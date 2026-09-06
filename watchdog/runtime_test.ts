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
    "4s",
  ];
  const start = performance.now();
  const child = new Deno.Command(Deno.execPath(), {
    args,
    env: { CODEX_HOME: home },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const safety = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* exited */ }
  }, 10000);
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
      env: { CODEX_HOME: home },
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (second.code !== 2) throw new Error("Second writer was not rejected");
    const result = await child.output();
    if (!result.success || performance.now() - start > 8000) {
      throw new Error(
        new TextDecoder().decode(result.stderr) || "Deadline failed",
      );
    }
    const state = JSON.parse(
      await Deno.readTextFile(`${home}/attention-watchdog/state.json`),
    );
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
