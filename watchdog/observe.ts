import WebSocket from "ws";
import type { Snapshot } from "./policy.ts";
type Row = Record<string, any>;
// This transport has no method for steering or resuming a session.
export class Observer {
  socket?: WebSocket;
  serial = 0;
  connecting?: Promise<void>;
  pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      cleanup: () => void;
    }
  >();
  constructor(readonly home: string) {}
  async open() {
    if (this.connecting) return await this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
  private async connect() {
    const ws = new WebSocket(
      `ws+unix://${this.home}/app-server-control/app-server-control.sock:/`,
      {
        headers: { Host: "localhost" },
        perMessageDeflate: false,
        maxPayload: 1_048_576,
        handshakeTimeout: 3000,
      },
    );
    this.socket = ws;
    ws.on("message", (raw: { toString(): string }) => {
      let r: Row;
      try {
        r = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const p = this.pending.get(r.id);
      if (!p) return;
      clearTimeout(p.timer);
      p.cleanup();
      this.pending.delete(r.id);
      if (r.error) p.reject(new Error("Read-only RPC failed"));
      else p.resolve(r.result);
    });
    const lost = () => {
      if (this.socket !== ws) return;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.cleanup();
        p.reject(new Error("Observer disconnected"));
      }
      this.pending.clear();
    };
    ws.on("close", lost);
    ws.on("error", lost);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", () => reject(new Error("Observer unavailable")));
    });
    await this.call("initialize", {
      clientInfo: { name: "codex_hook_attention", version: "1" },
      capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ method: "initialized" }));
  }
  call(method: string, params: Row, signal?: AbortSignal): Promise<any> {
    if (
      ![
        "initialize",
        "thread/loaded/list",
        "thread/read",
        "thread/goal/get",
        "thread/turns/list",
      ].includes(method)
    ) throw new Error("Observer is read-only");
    if (signal?.aborted) return Promise.reject(new Error("Observer deadline"));
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Observer unavailable"));
    }
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const abort = () => {
        clearTimeout(timer);
        cleanup();
        this.pending.delete(id);
        reject(new Error("Observer deadline"));
      };
      const timer = setTimeout(() => {
        abort();
      }, 3000);
      this.pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }
  async loaded(): Promise<string[]> {
    await this.open();
    const r = await this.call("thread/loaded/list", {});
    return (r.data ?? r.threadIds ?? []).filter((v: unknown) =>
      typeof v === "string"
    ).slice(0, 1024);
  }
  async fresh(id: string, signal?: AbortSignal): Promise<Snapshot> {
    await this.open();
    const t = (await this.call(
      "thread/read",
      { threadId: id, includeTurns: false },
      signal,
    ))
      .thread;
    // Sequential reads keep four urgent + four background workers within the
    // eight-RPC limit, even while discovery and dispatch overlap.
    let goal: any, turn: any;
    let complete = true;
    try {
      goal =
        (await this.call("thread/goal/get", { threadId: id }, signal)).goal;
    } catch {
      complete = false;
    }
    try {
      turn = (await this.call("thread/turns/list", {
        threadId: id,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      }, signal)).data?.[0];
    } catch {
      complete = false;
    }
    return {
      id,
      turn: turn?.id ?? null,
      runtime: t.status?.type ?? "unknown",
      flags: t.status?.activeFlags ?? [],
      terminal: turn?.status ?? null,
      goal: goal?.status ?? null,
      parent: t.parentThreadId ?? null,
      at: Date.now(),
      complete: complete && typeof t.status?.type === "string",
    };
  }
  close() {
    this.socket?.terminate();
  }
}
