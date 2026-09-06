import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { evidence } from "./observe.ts";

Deno.test("old-turn requests and incomplete records cannot become current evidence", async () => {
  const file = await Deno.makeTempFile();
  const s = {
    id: "test",
    turn: "new",
    runtime: "active",
    flags: [],
    goal: "active",
    terminal: "inProgress",
    label: "Test",
    updated: Date.now(),
    parent: null,
  };
  try {
    const rows = [
      {
        timestamp: "2026-09-06T01:00:00Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "old" },
      },
      {
        timestamp: "2026-09-06T01:01:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I need your approval." }],
        },
      },
      {
        timestamp: "2026-09-06T02:00:00Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "new" },
      },
    ];
    await Deno.writeTextFile(
      file,
      rows.map((r) => JSON.stringify(r)).join("\n") + '\n{"incomplete":',
    );
    const p = await evidence(file, s);
    if (p.records.length !== 0) {
      throw new Error("Old request leaked into new turn");
    }
    if (!p.complete || !p.logVersion) {
      throw new Error("Missing current-turn boundary or log identity");
    }
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("bounded run expires, saves state and rejects a second writer without model or ntfy calls", async () => {
  const home = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "watchdog-test-",
  });
  await Deno.mkdir(`${home}/app-server-control`);
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const methods: string[] = [];
  sockets.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw: { toString(): string }) => {
      const request = JSON.parse(raw.toString());
      methods.push(request.method);
      if (!request.id) return;
      const result = request.method === "initialize"
        ? {}
        : { data: [], nextCursor: null };
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(`${home}/app-server-control/app-server-control.sock`, resolve)
  );
  const args = [
    "run",
    "--quiet",
    "--allow-read",
    "--allow-write",
    "--allow-net",
    "--allow-env",
    "--allow-run",
    fileURLToPath(new URL("main.ts", import.meta.url)),
    "--duration",
    "12s",
  ];
  const info = JSON.parse(
    new TextDecoder().decode(
      (await new Deno.Command(Deno.execPath(), {
        args: ["info", "--json"],
        stdout: "piped",
        stderr: "null",
      }).output()).stdout,
    ),
  );
  const env = { HOME: home, CODEX_HOME: home, DENO_DIR: info.denoDir };
  const start = performance.now();
  const child = new Deno.Command(Deno.execPath(), {
    args,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const safety = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* exited */ }
  }, 18000);
  try {
    // Wait for proof that the first writer has completed initialization, not a fixed launch guess.
    const reader = child.stdout.getReader();
    const first = await reader.read();
    if (
      first.done ||
      !new TextDecoder().decode(first.value).includes('"event":"started"')
    ) throw new Error("No startup evidence");
    reader.releaseLock();
    const second = await new Deno.Command(Deno.execPath(), {
      args,
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (second.code !== 2) throw new Error("Second writer was not rejected");
    const result = await child.output();
    if (!result.success || performance.now() - start > 16000) {
      throw new Error(
        new TextDecoder().decode(result.stderr) || "Deadline failed",
      );
    }
    const state = JSON.parse(
      await Deno.readTextFile(`${home}/attention-watchdog/state.json`),
    );
    if (
      state.version !== 2 || !state.expiryNotified ||
      state.stopped !== "expired"
    ) throw new Error("Missing V2 expiry evidence");
    if (state.calls !== 0 || state.ticks !== 1) {
      throw new Error("Unexpected model call or missing scan");
    }
    if (
      methods.some((method) =>
        !["initialize", "initialized", "thread/list", "thread/loaded/list"]
          .includes(method)
      )
    ) throw new Error("Unexpected session operation");
  } finally {
    clearTimeout(safety);
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("native command outcomes keep stable IDs and repeated failures without leaking arguments", async () => {
  const file = await Deno.makeTempFile();
  const s = {
    id: "test",
    turn: "native",
    runtime: "active",
    flags: [],
    goal: "active",
    terminal: "inProgress",
    label: "Native",
    updated: Date.now(),
    parent: null,
  };
  const start = Date.parse("2026-09-06T01:00:00Z");
  const rows = [
    {
      timestamp: new Date(start).toISOString(),
      type: "event_msg",
      payload: { type: "task_started", turn_id: "native" },
    },
    ...Array.from({ length: 3 }, (_, i) => ({
      timestamp: new Date(start + i * 300_000).toISOString(),
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          id: `cmd-${i}`,
          command: ["status", "--private-argument"],
          exit_code: 1,
          status: "completed",
        },
      },
    })),
  ];
  try {
    await Deno.writeTextFile(
      file,
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    const p = await evidence(file, s);
    if (
      !p.complete || p.repeatedFailures !== 3 || new Set(p.records.map((r) =>
          r.id
        )).size !== 3 ||
      JSON.stringify(p).includes("private-argument")
    ) throw new Error("Native outcome adapter failed");
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        timestamp: new Date(start).toISOString(),
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "x".repeat(66000) }],
        },
      }) + "\n",
      { append: true },
    );
    const incomplete = await evidence(file, s);
    if (incomplete.complete) {
      throw new Error("Oversized omitted record was called complete");
    }
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("successive real CLI sweeps cover more than sixteen evidence tails", async () => {
  const home = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "watchdog-sweep-",
  });
  await Deno.mkdir(`${home}/app-server-control`);
  const now = Date.now();
  const rows = Array.from(
    { length: 30 },
    (_, i) => ({
      id: `s${i.toString().padStart(2, "0")}`,
      path: `${home}/${i}.jsonl`,
      cwd: "/synthetic",
      updatedAt: now / 1000,
      status: { type: "active", activeFlags: [] },
    }),
  );
  for (const row of rows) {
    await Deno.writeTextFile(
      row.path,
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t" },
      }) + "\n",
    );
  }
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on(
    "connection",
    (socket: WebSocket) =>
      socket.on("message", (raw: { toString(): string }) => {
        const r = JSON.parse(raw.toString());
        if (!r.id) return;
        const result = r.method === "initialize"
          ? {}
          : r.method === "thread/loaded/list"
          ? { data: rows.map((r) => r.id) }
          : r.method === "thread/list"
          ? { data: rows.slice(0, 25), nextCursor: null }
          : r.method === "thread/read"
          ? { thread: rows.find((x) => x.id === r.params.threadId) }
          : r.method === "thread/goal/get"
          ? { goal: { status: "active" } }
          : { data: [{ id: "t", status: "inProgress" }] };
        socket.send(JSON.stringify({ id: r.id, result }));
      }),
  );
  await new Promise<void>((resolve) =>
    server.listen(`${home}/app-server-control/app-server-control.sock`, resolve)
  );
  const info = JSON.parse(
    new TextDecoder().decode(
      (await new Deno.Command(Deno.execPath(), {
        args: ["info", "--json"],
        stdout: "piped",
        stderr: "null",
      }).output()).stdout,
    ),
  );
  try {
    for (let pass = 0; pass < 2; pass++) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--quiet",
          "--allow-read",
          "--allow-write",
          "--allow-net",
          "--allow-env",
          "--allow-run",
          fileURLToPath(new URL("main.ts", import.meta.url)),
          "--once",
        ],
        clearEnv: true,
        env: { HOME: home, CODEX_HOME: home, DENO_DIR: info.denoDir },
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!result.success) {
        throw new Error(new TextDecoder().decode(result.stderr));
      }
    }
    const state = JSON.parse(
      await Deno.readTextFile(`${home}/attention-watchdog/state.json`),
    );
    if (
      Object.values(state.tracked).filter((t: any) => t.evidenceAt > 0)
          .length !== 30 || state.calls !== 0
    ) throw new Error("Evidence rotation starved sessions or called a model");
  } finally {
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Deno.remove(home, { recursive: true });
  }
});
