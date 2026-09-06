import WebSocket from "ws";
import { basename } from "node:path";
import { type Evidence, type Packet, redact, type Snapshot } from "./policy.ts";

type Row = Record<string, any>;
export class Observer {
  socket?: WebSocket;
  serial = 0;
  pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(readonly home: string) {}
  async open() {
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
      const pending = this.pending.get(r.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(r.id);
      if (r.error) pending.reject(new Error(`RPC ${r.error.code}`));
      else pending.resolve(r.result);
    });
    const lost = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Observer disconnected"));
      }
      this.pending.clear();
    };
    ws.on("close", lost);
    ws.on("error", lost);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", () => reject(new Error("Observer connection failed")));
    });
    await this.call("initialize", {
      clientInfo: { name: "session_attention_watchdog", version: "1.0" },
      capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ method: "initialized" }));
  }
  call(method: string, params: Row): Promise<any> {
    if (
      ![
        "initialize",
        "thread/list",
        "thread/loaded/list",
        "thread/read",
        "thread/goal/get",
        "thread/turns/list",
      ].includes(method)
    ) {
      throw new Error("Observer is read-only");
    }
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Observer unavailable"));
    }
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("RPC deadline"));
      }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.socket?.terminate();
  }
  cursor: string | null = null;
  async discover(
    known: string[],
    exclude: Set<string>,
  ): Promise<{ rows: Row[]; partial: boolean }> {
    const rows = new Map<string, Row>();
    const loaded = await this.call("thread/loaded/list", {});
    const ids = new Set<string>([
      ...known,
      ...(loaded.data ?? loaded.threadIds ?? []),
    ]);
    let partial = false;
    // Fresh first page each minute; rotate an additional cursor to cover a busy host.
    for (
      const cursor of [null, this.cursor].filter((v, i, a) =>
        i === 0 || v !== a[0]
      )
    ) {
      const page = await this.call("thread/list", {
        limit: 25,
        archived: false,
        sortKey: "updated_at",
        useStateDbOnly: true,
        cursor,
      });
      this.cursor = page.nextCursor ?? null;
      for (const t of page.data ?? []) {
        if (
          Date.now() - t.updatedAt * 1000 <= 86_400_000 ||
          t.status?.type === "active"
        ) rows.set(t.id, t);
      }
      if (this.cursor) partial = true;
    }
    for (const id of ids) {
      if (rows.size >= 128) {
        partial = true;
        break;
      }
      if (!rows.has(id) && !exclude.has(id)) {
        try {
          rows.set(
            id,
            (await this.call("thread/read", {
              threadId: id,
              includeTurns: false,
            })).thread,
          );
        } catch {
          partial = true;
        }
      }
    }
    return {
      rows: [...rows.values()].filter((t) => !exclude.has(t.id)).slice(0, 128),
      partial,
    };
  }
  async snapshot(t: Row): Promise<Snapshot> {
    const [goals, turns] = await Promise.all([
      this.call("thread/goal/get", { threadId: t.id }),
      this.call("thread/turns/list", {
        threadId: t.id,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      }),
    ]);
    const turn = turns.data?.[0];
    return {
      id: t.id,
      turn: turn?.id ?? "",
      runtime: t.status?.type ?? "unknown",
      flags: t.status?.activeFlags ?? [],
      goal: goals.goal?.status ?? null,
      terminal: turn?.status ?? null,
      updated: t.updatedAt * 1000,
      label: redact(basename(t.cwd ?? "Codex"), 100),
      parent: t.parentThreadId ?? null,
    };
  }
  async fresh(id: string): Promise<Snapshot> {
    return await this.snapshot(
      (await this.call("thread/read", { threadId: id, includeTurns: false }))
        .thread,
    );
  }
}

export async function evidence(
  path: string,
  snapshot: Snapshot,
): Promise<Packet> {
  if (!path || path.length > 4096) throw new Error("Missing rollout path");
  const file = await Deno.open(path, { read: true });
  let text = "";
  let truncated = false;
  let logVersion = "";
  try {
    const stat = await file.stat();
    const size = stat.size;
    logVersion = `${size}:${stat.mtime?.getTime() ?? 0}`;
    const offset = Math.max(0, size - 262144);
    await file.seek(offset, Deno.SeekMode.Start);
    const bytes = new Uint8Array(Math.min(size, 262144));
    let n = 0;
    while (n < bytes.length) {
      const read = await file.read(bytes.subarray(n));
      if (read === null) break;
      n += read;
    }
    text = new TextDecoder().decode(bytes.subarray(0, n));
    if (offset) text = text.slice(text.indexOf("\n") + 1);
    // Ignore partial writes; never parse an incomplete JSONL record.
    text = text.slice(0, text.lastIndexOf("\n") + 1);
    truncated = offset > 0;
  } finally {
    file.close();
  }
  const records: Evidence[] = [];
  let currentTurn = "";
  let lastProgress = snapshot.updated;
  let seenStart = false;
  const failures = new Map<
    string,
    { count: number; first: number; last: number }
  >();
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.length > 65536) continue;
    let r: Row;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const p = r.payload ?? {};
    const at = Date.parse(r.timestamp);
    if (!Number.isFinite(at)) continue;
    if (p.type === "task_started" || r.type === "turn_context") {
      currentTurn = p.turn_id ?? "";
    }
    const explicitTurn =
      p.internal_chat_message_metadata_passthrough?.turn_id ?? p.turn_id;
    if ((explicitTurn ?? currentTurn) !== snapshot.turn) continue;
    if (p.type === "task_started" && p.turn_id === snapshot.turn) {
      seenStart = true;
      lastProgress = at;
    }
    if (
      r.type === "response_item" && p.type === "message" &&
      ["user", "assistant"].includes(p.role)
    ) {
      const body = (p.content ?? []).filter((x: Row) =>
        ["input_text", "output_text", "text"].includes(x.type)
      ).map((x: Row) => x.text ?? "").join(" ");
      if (p.role === "user" && !body.startsWith("<codex_internal_context")) {
        lastProgress = at;
      }
      if (body) {
        records.push({
          id: `e${r.ordinal ?? at}`,
          at,
          kind: p.role,
          text: redact(body, 550),
        });
      }
    }
    if (r.type === "event_msg" && p.type === "item_completed") {
      const item = p.item ?? {};
      if (item.type === "FileChange") {
        lastProgress = at;
        records.push({
          id: `e${r.ordinal ?? at}`,
          at,
          kind: "change",
          text: "File change completed; acceptance not yet established.",
        });
      }
      if (
        item.type === "CommandExecution" && typeof item.exit_code === "number"
      ) {
        const exit = item.exit_code;
        // Only an outcome signature, never outgoing command arguments or output.
        const key = `${exit}:${
          redact(String(item.command?.[0] ?? "command"), 60)
        }`;
        if (exit !== 0) {
          const f = failures.get(key) ?? { count: 0, first: at, last: at };
          f.count++;
          f.last = at;
          failures.set(key, f);
        }
        records.push({
          id: `e${r.ordinal ?? at}`,
          at,
          kind: "command",
          text: `Command completed with exit ${exit}.`,
        });
      }
    }
  }
  const dedup = [...new Map(records.map((r) => [r.id, r])).values()].slice(-12);
  return {
    snapshot,
    logVersion,
    records: dedup,
    complete: !truncated || seenStart,
    silenceMs: Math.max(0, Date.now() - lastProgress),
    repeatedFailures: Math.max(
      0,
      ...[...failures.values()].filter((f) => f.last - f.first >= 600000).map((
        f,
      ) => f.count),
    ),
  };
}
