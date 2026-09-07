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
