import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Observer } from "./observe.ts";
const assert = (x: unknown, m = "assertion failed") => {
  if (!x) throw new Error(m);
};
Deno.test("100 concurrent actual hook processes enqueue private bounded events", async () => {
  const home = await Deno.makeTempDir({ prefix: "attention-hook-test-" });
  const times: number[] = [];
  try {
    const launches = await Promise.allSettled(
      Array.from({ length: 100 }, async (_, i) => {
        const start = performance.now();
        const p = new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "--no-config",
            "--no-prompt",
            "--allow-env=HOME,CODEX_HOME",
            `--allow-write=${home}`,
            `--allow-read=${home}`,
            fileURLToPath(new URL("hook.ts", import.meta.url)),
          ],
          env: { HOME: home, CODEX_HOME: home },
          clearEnv: true,
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        const writer = p.stdin.getWriter();
        await writer.write(
          new TextEncoder().encode(
            JSON.stringify({
              session_id: `actor-${i}`,
              turn_id: "turn",
              hook_event_name: "Stop",
              last_assistant_message: "private text",
            }),
          ),
        );
        await writer.close();
        const r = await p.output();
        times.push(performance.now() - start);
        assert(r.success, new TextDecoder().decode(r.stderr));
        assert(new TextDecoder().decode(r.stdout).trim() === "{}");
      }),
    );
    const failed = launches.filter((r) => r.status === "rejected");
    assert(
      !failed.length,
      failed.map((r) => String((r as PromiseRejectedResult).reason)).join("\n"),
    );
    const dirs = Array.from(
      Deno.readDirSync(join(home, "attention-watchdog/spool")),
    );
    assert(dirs.length === 100);
    const ids = new Set();
    for (const dir of dirs) {
      const path = join(
        home,
        "attention-watchdog/spool",
        dir.name,
        "event.json",
      );
      const raw = await Deno.readTextFile(path);
      assert(!raw.includes("private text"));
      assert(new TextEncoder().encode(raw).length < 8192);
      assert(((await Deno.stat(path)).mode! & 0o777) === 0o600);
      ids.add(JSON.parse(raw).id);
    }
    assert(ids.size === 100);
    times.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        actualProcesses: 100,
        p95Ms: times[94],
        p99Ms: times[98],
        targetPassed: times[94] < 50 && times[98] < 200,
      }),
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
Deno.test("runtime handles real spool, read-only RPC, exclusive lock and bounded stop", async () => {
  const home = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "attention-runtime-",
  });
  await Deno.mkdir(join(home, "app-server-control"));
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const methods: string[] = [];
  sockets.on("connection", (socket: any) =>
    socket.on("message", (raw: any) => {
      const r = JSON.parse(raw.toString());
      methods.push(r.method);
      if (!r.id) return;
      const result = r.method === "initialize"
        ? {}
        : r.method === "thread/read"
        ? {
          thread: {
            id: "actor",
            status: { type: "idle" },
            parentThreadId: null,
          },
        }
        : r.method === "thread/goal/get"
        ? { goal: { status: "complete" } }
        : r.method === "thread/turns/list"
        ? { data: [{ id: "turn", status: "completed" }] }
        : { data: [] };
      socket.send(JSON.stringify({ id: r.id, result }));
    }));
  await new Promise<void>((r) =>
    server.listen(join(home, "app-server-control/app-server-control.sock"), r)
  );
  const args = [
    "run",
    "--no-prompt",
    "--allow-read",
    "--allow-write",
    "--allow-net",
    "--allow-env",
    fileURLToPath(new URL("main.ts", import.meta.url)),
    "--duration",
    "4s",
  ];
  let child: Deno.ChildProcess | undefined;
  try {
    child = new Deno.Command(Deno.execPath(), {
      args,
      env: { HOME: home, CODEX_HOME: home },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const hook = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        "--allow-env",
        "--allow-write",
        "--allow-read",
        fileURLToPath(new URL("hook.ts", import.meta.url)),
      ],
      env: { HOME: home, CODEX_HOME: home },
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = hook.stdin.getWriter();
    await w.write(
      new TextEncoder().encode(
        JSON.stringify({
          session_id: "actor",
          turn_id: "turn",
          hook_event_name: "Stop",
        }),
      ),
    );
    await w.close();
    const hookResult = await hook.output();
    assert(hookResult.success, new TextDecoder().decode(hookResult.stderr));
    await new Promise((r) => setTimeout(r, 600));
    const second = await new Deno.Command(Deno.execPath(), {
      args,
      env: { HOME: home, CODEX_HOME: home },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(second.code === 2, "second consumer must fail lock");
    const result = await child.output();
    child = undefined;
    assert(result.success, new TextDecoder().decode(result.stderr));
    const state = JSON.parse(
      await Deno.readTextFile(join(home, "attention-watchdog/hook-state.json")),
    );
    assert(
      Object.values(state.episodes).some((p: any) =>
        p.disposition === "completion"
      ),
    );
    assert(state.posts.length === 0);
    assert(state.stopped);
    assert(methods.includes("thread/read"));
    assert(!methods.includes("thread/list"));
    assert(!methods.includes("thread/loaded/list"));
    assert(!methods.some((m) => /resume|start|interrupt/.test(m)));
    const o = new Observer(home);
    let rejected = false;
    try {
      o.call("turn/start", {});
    } catch {
      rejected = true;
    }
    assert(rejected);
  } finally {
    if (child) {
      try {
        child.kill("SIGTERM");
        await child.status;
      } catch { /* settled */ }
    }
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((r) => sockets.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("one-shot completes hook-episode revalidation and delivery before exit", async () => {
  const home = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "attention-once-",
  });
  const { Engine, newState } = await import("./engine.ts");
  const state = newState(Date.now() - 60000);
  new Engine(state).add(
    "actor",
    "turn",
    "stop",
    "stop:turn",
    Date.now() - 50000,
  );
  await Deno.mkdir(join(home, "attention-watchdog"));
  await Deno.mkdir(join(home, ".config/codex-nudge"), { recursive: true });
  await Deno.mkdir(join(home, "app-server-control"));
  await Deno.writeTextFile(
    join(home, "attention-watchdog/hook-state.json"),
    JSON.stringify(state),
  );
  await Deno.writeTextFile(join(home, ".config/codex-nudge/topic"), "fixture");
  const server = createServer(), sockets = new WebSocketServer({ server });
  sockets.on("connection", (ws: any) =>
    ws.on("message", (raw: any) => {
      const r = JSON.parse(raw.toString());
      if (!r.id) return;
      const result = r.method === "initialize"
        ? {}
        : r.method === "thread/read"
        ? { thread: { id: "actor", status: { type: "idle" } } }
        : r.method === "thread/goal/get"
        ? { goal: null }
        : r.method === "thread/turns/list"
        ? { data: [{ id: "turn", status: "completed" }] }
        : { data: [] };
      setTimeout(() => ws.send(JSON.stringify({ id: r.id, result })), 30);
    }));
  await new Promise<void>((r) =>
    server.listen(join(home, "app-server-control/app-server-control.sock"), r)
  );
  const harness = join(home, "harness.ts");
  await Deno.writeTextFile(
    harness,
    `import {main} from ${
      JSON.stringify(new URL("main.ts", import.meta.url).href)
    };globalThis.fetch=async(input,init)=>{if(String(input)!=="https://ntfy.sh/fixture")throw new Error("Unexpected external call");await Deno.writeTextFile(${
      JSON.stringify(join(home, "sent.json"))
    },JSON.stringify({body:init?.body,at:Date.now()}));return new Response(JSON.stringify({id:"once-receipt"}),{status:200});};await main();`,
  );
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-net",
        "--allow-env",
        "--config",
        fileURLToPath(new URL("../deno.json", import.meta.url)),
        harness,
        "--once",
      ],
      env: { HOME: home, CODEX_HOME: home },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
    const saved = JSON.parse(
      await Deno.readTextFile(join(home, "attention-watchdog/hook-state.json")),
    );
    assert(
      Object.values(saved.episodes).some((p: any) =>
        p.receipt === "once-receipt" && p.delivery === "accepted"
      ),
    );
    assert(
      saved.stopped >=
        JSON.parse(await Deno.readTextFile(join(home, "sent.json"))).at,
    );
    assert(saved.actors.actor.snapshot.complete);
  } finally {
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>((r) => sockets.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("slow RPC burst delivers all 100 plus new urgent input without queue head blocking", async () => {
  const home = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "attention-burst-",
  });
  const { Engine, newState } = await import("./engine.ts");
  const { enqueue } = await import("./hook.ts");
  const { capture } = await import("./policy.ts");
  const state = newState(Date.now() - 60000), engine = new Engine(state);
  for (let i = 0; i < 100; i++) {
    const id = `actor-${String(i).padStart(3, "0")}`;
    engine.actor(id, Date.now());
    engine.add(id, "turn", "stop", "stop:turn", Date.now() - 50000);
  }
  await Deno.mkdir(join(home, "attention-watchdog"));
  await Deno.mkdir(join(home, ".config/codex-nudge"), { recursive: true });
  await Deno.mkdir(join(home, "app-server-control"));
  await Deno.writeTextFile(
    join(home, "attention-watchdog/hook-state.json"),
    JSON.stringify(state),
  );
  await Deno.writeTextFile(join(home, ".config/codex-nudge/topic"), "fixture");
  const server = createServer(), sockets = new WebSocketServer({ server });

  sockets.on("connection", (ws: any) =>
    ws.on("message", (raw: any) => {
      const r = JSON.parse(raw.toString());
      if (!r.id) return;
      if (r.method === "thread/read") {
        return;
      }
      ws.send(
        JSON.stringify({
          id: r.id,
          result: r.method === "initialize" ? {} : { data: [] },
        }),
      );
    }));
  await new Promise<void>((r) =>
    server.listen(join(home, "app-server-control/app-server-control.sock"), r)
  );
  const harness = join(home, "harness.ts");
  await Deno.writeTextFile(
    harness,
    `import {main} from ${
      JSON.stringify(new URL("main.ts", import.meta.url).href)
    };import {Observer} from ${
      JSON.stringify(new URL("observe.ts", import.meta.url).href)
    };let active=0,maxActive=0;const call=Observer.prototype.call;Observer.prototype.call=function(...args){active++;maxActive=Math.max(maxActive,active);return call.apply(this,args).finally(()=>active--);};let count=0;globalThis.fetch=async(input,init)=>{if(String(input)!=="https://ntfy.sh/fixture")throw new Error("Unexpected external call");await Deno.writeTextFile(${
      JSON.stringify(join(home, "sent.jsonl"))
    },JSON.stringify({body:init?.body,at:Date.now()})+"\\n",{append:true,create:true});return new Response(JSON.stringify({id:"burst-"+(++count)}),{status:200});};await main();await Deno.writeTextFile(${
      JSON.stringify(join(home, "rpc-metrics.json"))
    },JSON.stringify({maxActive}));`,
  );
  const start = Date.now();
  let child: Deno.ChildProcess | undefined;
  try {
    child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-net",
        "--allow-env",
        "--config",
        fileURLToPath(new URL("../deno.json", import.meta.url)),
        harness,
        "--duration",
        "30s",
      ],
      env: { HOME: home, CODEX_HOME: home },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    await new Promise((r) => setTimeout(r, 500));
    await enqueue(
      join(home, "attention-watchdog/spool"),
      capture({
        session_id: "new-urgent",
        turn_id: "new-turn",
        hook_event_name: "PermissionRequest",
      }, Date.now() - 15000),
    );
    const result = await child.output();
    child = undefined;
    assert(result.success, new TextDecoder().decode(result.stderr));
    const sent = (await Deno.readTextFile(join(home, "sent.jsonl"))).trim()
      .split("\n").map((r) => JSON.parse(r));
    const { maxActive } = JSON.parse(
      await Deno.readTextFile(join(home, "rpc-metrics.json")),
    );
    console.log(
      JSON.stringify({
        firstMs: sent[0].at - start,
        lastMs: sent.at(-1).at - start,
        posts: sent.length,
        maxActive,
      }),
    );
    for (let i = 0; i < 100; i++) {
      assert(
        sent.some((r) =>
          r.body.includes(`actor-${String(i).padStart(3, "0")}`)
        ),
        `missing actor ${i}`,
      );
    }
    assert(
      sent.some((r) => r.body.includes("new-urge")),
      "new urgent condition was delayed behind stale batch",
    );
    assert(sent[0].at - start < 10000, "first delivery deadline exceeded");
    assert(sent.at(-1).at - start < 30000, "last delivery deadline exceeded");
    assert(
      sent.every((r) => r.body.includes("current state could not be verified")),
      "unreadable state must be labeled",
    );
    assert(maxActive <= 4, `RPC concurrency ${maxActive} exceeds four`);
    console.log(
      JSON.stringify({
        firstMs: sent[0].at - start,
        lastMs: sent.at(-1).at - start,
        posts: sent.length,
        maxActive,
      }),
    );
  } finally {
    if (child) {
      try {
        child.kill("SIGTERM");
        await child.status;
      } catch {}
    }
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>((r) => sockets.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("unverified reminders retain their single allowance and do not publish", async () => {
  const home = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "attention-reminder-",
  });
  const { Engine, newState } = await import("./engine.ts");
  const now = Date.now();
  const state = newState(now - 700000), engine = new Engine(state);
  for (let i = 0; i < 5; i++) {
    const id = `actor-${i}`;
    const actor = engine.actor(id, now)!;
    actor.snapshot = {
      id,
      turn: "turn",
      runtime: "active",
      flags: ["waitingOnApproval"],
      terminal: "inProgress",
      goal: null,
      parent: null,
      at: now,
      complete: true,
    };
    const p = engine.add(id, "turn", "approval", "request", now - 650000)!;
    p.disposition = "attention";
    p.delivery = "accepted";
    p.receipt = `original-${i}`;
    p.sentAt = now - 610000;
  }
  await Deno.mkdir(join(home, "attention-watchdog"));
  await Deno.mkdir(join(home, ".config/codex-nudge"), { recursive: true });
  await Deno.mkdir(join(home, "app-server-control"));
  await Deno.writeTextFile(
    join(home, "attention-watchdog/hook-state.json"),
    JSON.stringify(state),
  );
  await Deno.writeTextFile(join(home, ".config/codex-nudge/topic"), "fixture");
  const server = createServer(), sockets = new WebSocketServer({ server });
  sockets.on("connection", (ws: any) =>
    ws.on("message", (raw: any) => {
      const r = JSON.parse(raw.toString());
      if (!r.id || r.method === "thread/read") return;
      ws.send(
        JSON.stringify({
          id: r.id,
          result: r.method === "initialize" ? {} : { data: [] },
        }),
      );
    }));
  await new Promise<void>((r) =>
    server.listen(join(home, "app-server-control/app-server-control.sock"), r)
  );
  const harness = join(home, "harness.ts");
  await Deno.writeTextFile(
    harness,
    `import {main} from ${
      JSON.stringify(new URL("main.ts", import.meta.url).href)
    };globalThis.fetch=async()=>{await Deno.writeTextFile(${
      JSON.stringify(join(home, "unexpected-send"))
    },"sent");return new Response(JSON.stringify({id:"unexpected"}),{status:200});};await main();`,
  );
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-net",
        "--allow-env",
        "--config",
        fileURLToPath(new URL("../deno.json", import.meta.url)),
        harness,
        "--duration",
        "5s",
      ],
      env: { HOME: home, CODEX_HOME: home },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
    const saved = JSON.parse(
      await Deno.readTextFile(join(home, "attention-watchdog/hook-state.json")),
    );
    assert(saved.posts.length === 0, "unverified reminder must not dispatch");
    assert(
      Object.values(saved.episodes).every((p: any) =>
        p.delivery === "accepted" && !p.reminded &&
        p.receipt.startsWith("original-")
      ),
      "existing receipt and reminder allowance must survive",
    );
  } finally {
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>((r) => sockets.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
    await Deno.remove(home, { recursive: true });
  }
});
