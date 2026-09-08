import { type Category, type Event, type Snapshot, VERSION } from "./policy.ts";
export type Episode = {
  id: string;
  actor: string;
  turn: string | null;
  kind: Category;
  source: string;
  created: number;
  due: number;
  revision: number;
  disposition:
    | "candidate"
    | "attention"
    | "resolved"
    | "completion"
    | "interrupt";
  delivery: "pending" | "dispatching" | "accepted" | "rejected" | "uncertain";
  attempts: number;
  retryAt: number;
  receipt?: string;
  sentAt?: number;
  reminded?: boolean;
  reminder?: boolean;
  request: string | null;
  partial: boolean;
};
export type Actor = {
  id: string;
  parent: string | null;
  lastEvent: number;
  lastKind?: string;
  hookVersion?: string;
  snapshot?: Snapshot;
  failedAt?: number;
  failures: number;
  lastRead: number;
};
export type State = {
  version: typeof VERSION;
  started: number;
  actors: Record<string, Actor>;
  episodes: Record<string, Episode>;
  seen: Record<string, number>;
  posts: number[];
  history?: Record<
    string,
    Pick<Episode, "delivery" | "receipt" | "sentAt" | "created" | "disposition">
  >;
  losses: number;
  lastEvent: number;
  gapAt?: number;
  deliveryHealth?: string;
  captureLossAt?: number;
  stopped?: number;
};
export function newState(now: number): State {
  return {
    version: VERSION,
    started: now,
    actors: {},
    episodes: {},
    seen: {},
    posts: [],
    losses: 0,
    lastEvent: 0,
  };
}
export class Engine {
  constructor(readonly state: State) {
    state.history ??= {};
  }
  actor(id: string, now: number): Actor | undefined {
    if (this.state.actors[id]) return this.state.actors[id];
    if (Object.keys(this.state.actors).length >= 1024) {
      this.state.losses++;
      return;
    }
    return this.state.actors[id] = {
      id,
      parent: null,
      lastEvent: 0,
      lastRead: 0,
      failures: 0,
    };
  }
  add(
    actor: string,
    turn: string | null,
    kind: Category,
    source: string,
    now: number,
    request: string | null = null,
  ): Episode | undefined {
    const id = `${actor}:${turn ?? "unknown"}:${source}`;
    if (this.state.episodes[id]) return this.state.episodes[id];
    if (this.state.history![id]) return;
    if (Object.keys(this.state.episodes).length >= 4096) {
      this.reclaim(now, true);
    }
    if (Object.keys(this.state.episodes).length >= 4096) {
      this.state.losses++;
      return;
    }
    return this.state.episodes[id] = {
      id,
      actor,
      turn,
      kind,
      source,
      created: now,
      due: now + (kind === "stop" ? 45000 : kind === "approval" ? 2000 : 0),
      revision: 0,
      disposition: "candidate",
      delivery: "pending",
      attempts: 0,
      retryAt: 0,
      request,
      partial: request === null,
    };
  }
  ingest(e: Event) {
    if (this.state.seen[e.id]) return;
    this.state.seen[e.id] = e.at;
    this.state.lastEvent = Math.max(this.state.lastEvent, e.at);
    const a = this.actor(e.session, e.at);
    if (!a) return;
    a.hookVersion = e.version;
    if (e.child) {
      const child = this.actor(e.child, e.at);
      if (child) child.parent = e.session;
    }
    // A late old event cannot undo newer runtime or event evidence.
    if (
      e.at < a.lastEvent &&
      ["Stop", "Interrupt", "UserPromptSubmit"].includes(e.kind)
    ) return;
    a.lastEvent = Math.max(a.lastEvent, e.at);
    a.lastKind = e.kind;
    if (e.kind === "Stop" && !a.parent) {
      this.add(a.id, e.turn, "stop", `stop:${e.turn ?? e.id}`, e.at);
    }
    if (e.kind === "PermissionRequest") {
      this.add(a.id, e.turn, "approval", `approval:${e.id}`, e.at, e.request);
    }
    if (e.kind === "PreToolUse" && e.tool?.includes("request_user_input")) {
      this.add(
        a.id,
        e.turn,
        "input",
        `request:${e.request ?? e.id}`,
        e.at,
        e.request,
      );
    }
    if (e.kind === "Interrupt") {
      for (const p of this.forActor(a.id)) {
        if (p.turn === e.turn && !["approval", "input"].includes(p.kind)) {
          this.resolve(p, "interrupt");
        }
      }
    }
    if (e.kind === "UserPromptSubmit") {
      for (const p of this.forActor(a.id)) {
        if (p.created < e.at && !["approval", "input"].includes(p.kind)) {
          this.resolve(p);
        }
      }
    }
    // SessionEnd and async tool return deliberately do not answer requests.
  }
  forActor(id: string) {
    return Object.values(this.state.episodes).filter((p) =>
      p.actor === id && ["candidate", "attention"].includes(p.disposition)
    );
  }
  resolve(p: Episode, disposition: Episode["disposition"] = "resolved") {
    p.disposition = disposition;
    p.revision++;
  }
  observe(s: Snapshot, now: number) {
    const a = this.actor(s.id, now);
    if (!a || (a.snapshot && a.snapshot.at > s.at)) return;
    const previous = a.snapshot;
    a.snapshot = s;
    a.parent = s.parent ?? a.parent;
    a.lastRead = now;
    a.failures = 0;
    delete a.failedAt;
    const approval = s.flags.includes("waitingOnApproval"),
      input = s.flags.includes("waitingOnUserInput");
    // A hook-triggered read can also expose a pending runtime condition.
    for (
      const [present, kind] of [[approval, "approval"], [
        input,
        "input",
      ]] as const
    ) {
      if (present && !this.forActor(a.id).some((p) => p.kind === kind)) {
        this.add(
          a.id,
          s.turn,
          kind,
          `observed:${kind}:${crypto.randomUUID()}`,
          now,
        );
      }
    }
    const stopped = s.terminal !== "inProgress" && s.runtime !== "active";
    if (
      stopped && s.complete &&
      (a.hookVersion || previous?.terminal === "inProgress") &&
      (s.terminal === "failed" || s.goal === "blocked")
    ) {
      const kind = s.terminal === "failed" ? "failed" : "blocked";
      this.add(a.id, s.turn, kind, `stop:${s.turn ?? "unknown"}`, now);
    }
    for (const p of this.forActor(a.id)) {
      p.revision++;
      if (p.kind === "approval" || p.kind === "input") {
        const pending = p.kind === "approval" ? approval : input;
        if (pending) {
          p.disposition = "attention";
          p.due = Math.max(p.created + 2000, Math.min(p.due, now));
        } else if (s.complete && s.at >= p.created + 2000) {
          // Runtime flags only prove aggregate synchronous pending state. Do
          // not falsely resolve a specific optional asynchronous question.
          if (p.kind === "approval" || !p.request) this.resolve(p);
        }
        continue;
      }
      if (s.complete && s.terminal === "interrupted" && s.turn === p.turn) {
        this.resolve(p, "interrupt");
        continue;
      }
      if (
        s.complete && s.terminal === "inProgress" && s.at >= p.created + 5000
      ) {
        this.resolve(p);
        continue;
      }
      if (s.turn && p.turn && s.turn !== p.turn && s.at >= p.created) {
        this.resolve(p);
        continue;
      }
      if (a.parent && p.kind === "stop") {
        this.resolve(p);
        continue;
      }
      if (
        s.complete && ["complete", "completed"].includes(s.goal ?? "") &&
        s.terminal === "completed"
      ) this.resolve(p, "completion");
      else if (
        stopped && s.complete &&
        (s.terminal === "failed" || s.goal === "blocked")
      ) {
        p.kind = s.terminal === "failed" ? "failed" : "blocked";
        p.disposition = "attention";
        p.due = now;
      }
    }
    // A previously observed running turn ending without a hook is a new event,
    // unlike an old idle session found when the service starts.
    if (
      previous?.terminal === "inProgress" && s.terminal === "completed" &&
      !a.parent && !this.forActor(a.id).some((p) => p.turn === s.turn)
    ) this.add(a.id, s.turn, "stop", `stop:${s.turn ?? now}`, now);
  }
  failed(id: string, now: number) {
    const a = this.state.actors[id];
    if (!a) return;
    a.failures++;
    a.failedAt ??= now;
    a.lastRead = now;
  }
  eligible(now: number): Episode[] {
    return Object.values(this.state.episodes).filter((p) => {
      if (!["candidate", "attention"].includes(p.disposition)) return false;
      const a = this.state.actors[p.actor];
      if (p.disposition === "candidate" && now >= p.due) {
        if (["approval", "input"].includes(p.kind) && now < p.created + 15000) {
          return false;
        }
        p.disposition = "attention";
      }
      if (p.disposition !== "attention" || now < p.due || now < p.retryAt) {
        return false;
      }
      if (
        p.delivery === "accepted" && !p.reminded &&
        now >= (p.sentAt ?? now) + 600000 && a?.snapshot &&
        (p.kind === "approval"
          ? a.snapshot.flags.includes("waitingOnApproval")
          : p.kind === "input"
          ? a.snapshot.flags.includes("waitingOnUserInput")
          : a.snapshot.goal === "blocked" || a.snapshot.terminal === "failed")
      ) {
        return true;
      }
      return p.delivery === "pending" ||
        (p.delivery === "rejected" && p.attempts < 3 &&
          Number.isFinite(p.retryAt));
    }).sort((a, b) => a.due - b.due);
  }
  compact(now: number) {
    this.reclaim(now, false);
    const seen = Object.entries(this.state.seen).sort((a, b) => b[1] - a[1]);
    this.state.seen = Object.fromEntries(seen.slice(0, 8192));
    for (const [id, a] of Object.entries(this.state.actors)) {
      if (
        now - Math.max(a.lastEvent, a.snapshot?.at ?? 0) > 7 * 86400000 &&
        !this.forActor(id).length
      ) delete this.state.actors[id];
    }
    this.state.posts = this.state.posts.filter((t) => now - t < 86400000);
  }
  private reclaim(now: number, pressure: boolean) {
    const resolved = Object.values(this.state.episodes).filter((p) =>
      !["candidate", "attention"].includes(p.disposition) &&
      p.delivery !== "dispatching"
    ).sort((a, b) => a.created - b.created);
    let count = Object.keys(this.state.episodes).length;
    for (const p of resolved) {
      if (now - p.created <= 7 * 86400000 && (!pressure || count < 3584)) {
        continue;
      }
      const { delivery, receipt, sentAt, created, disposition } = p;
      this.state.history![p.id] = {
        delivery,
        receipt,
        sentAt,
        created,
        disposition,
      };
      delete this.state.episodes[p.id];
      count--;
    }
    this.state.history = Object.fromEntries(
      Object.entries(this.state.history!)
        .sort((a, b) => b[1].created - a[1].created).slice(0, 8192),
    );
  }
}
