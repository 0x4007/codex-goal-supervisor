import { join } from "node:path";
import { Engine, type Episode, newState, type State } from "./engine.ts";
import { Observer } from "./observe.ts";
import { identifier, templates, validEvent, VERSION } from "./policy.ts";
export class Pool {
  active = 0;
  waiting: (() => void)[] = [];
  constructor(readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((r) => this.waiting.push(r));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
export function digest(
  episodes: Episode[],
  host: string,
  now: number,
  notification: string,
) {
  const ids = [...new Set(episodes.map((p) => p.actor))];
  const short = (id: string) => {
    let length = 8;
    while (
      ids.some((other) =>
        other !== id && other.slice(0, length) === id.slice(0, length)
      )
    ) length++;
    return id.slice(0, length);
  };
  const legend = new Set<string>();
  const lines: string[] = [];
  const included: Episode[] = [];
  const prefix = `Codex attention on ${host}\nNotice: ${notification}\n`;
  for (const p of episodes) {
    const code = p.kind === "approval"
      ? "A"
      : p.kind === "input"
      ? "I"
      : p.kind === "failed"
      ? "F"
      : p.kind === "blocked"
      ? "B"
      : p.kind === "stop"
      ? "S"
      : "U";
    const line = `${short(p.actor)} ${code} ${
      Math.max(0, Math.floor((now - p.created) / 1000))
    }s${p.partial ? "*" : ""}${p.delivery === "accepted" ? " reminder" : ""}`;
    const next = new Set([...legend, `${code}: ${templates[p.kind]}`]);
    const body = prefix + [...lines, line].join("\n") + "\n" +
      [...next].join("\n") +
      "\n* Request identity partial. Match session ID in Codex.";
    if (new TextEncoder().encode(body).length > 3072) break;
    lines.push(line);
    legend.add(`${code}: ${templates[p.kind]}`);
    included.push(p);
  }
  return {
    included,
    body: prefix + lines.join("\n") + "\n" + [...legend].join("\n") +
      "\n* Request identity partial. Match session ID in Codex.",
  };
}
export async function publish(
  topic: string,
  body: string,
): Promise<
  {
    state: "accepted" | "rejected" | "uncertain";
    receipt?: string;
    retryAt?: number;
    reason?: string;
  }
> {
  try {
    const r = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        Title: "Codex attention",
        Click: "https://chatgpt.com",
        "Content-Type": "text/plain; charset=utf-8",
      },
      body,
    });
    if (!r.ok) {
      const retry = r.headers.get("retry-after");
      const seconds = retry === null ? NaN : Number(retry);
      const at = Number.isFinite(seconds)
        ? Date.now() + seconds * 1000
        : Date.parse(retry ?? "");
      await r.body?.cancel();
      return {
        state: "rejected",
        reason: `HTTP ${r.status}`,
        retryAt: [429, 500, 502, 503, 504].includes(r.status)
          ? Math.max(Date.now() + 20000, Number.isFinite(at) ? at : 0)
          : undefined,
      };
    }
    const receipt = await r.json();
    return typeof receipt.id === "string" && receipt.id.length > 0
      ? { state: "accepted", receipt: receipt.id }
      : { state: "uncertain", reason: "Invalid receipt" };
  } catch {
    return { state: "uncertain", reason: "Transport outcome unknown" };
  }
}
export async function main() {
  const args = Deno.args;
  let duration: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--once") continue;
    if (args[i] !== "--duration") {
      throw new Error("Use existing --once or --duration interfaces");
    }
    const m = /^(\d+)(s|m|h)$/.exec(args[++i] ?? "");
    if (!m) throw new Error("Invalid duration");
    duration = Number(m[1]) * ({ s: 1000, m: 60000, h: 3600000 }[m[2]]!);
    if (duration < 1000 || duration > 86400000) {
      throw new Error("Duration must be 1 second to 24 hours");
    }
  }
  const user = Deno.env.get("HOME");
  if (!user) throw new Error("HOME missing");
  const home = Deno.env.get("CODEX_HOME") ?? join(user, ".codex"),
    directory = join(home, "attention-watchdog"),
    spool = join(directory, "spool");
  await Deno.mkdir(spool, { recursive: true, mode: 0o700 });
  const lock = await Deno.open(join(directory, "lock"), {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  const timeout = setTimeout(() => {
    console.error("Another attention consumer holds the lock");
    Deno.exit(2);
  }, 2000);
  await lock.lock(true);
  clearTimeout(timeout);
  const path = join(directory, "hook-state.json");
  let state: State;
  try {
    const stat = await Deno.stat(path);
    if (stat.size > 16 * 1024 * 1024) throw new Error("State too large");
    state = JSON.parse(await Deno.readTextFile(path));
    if (
      state.version !== VERSION || !state.actors || !state.episodes ||
      !state.seen || !Array.isArray(state.posts)
    ) throw new Error("Unknown state");
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    state = newState(Date.now());
    // The old run stays intact. Retain receipt evidence locally, but never
    // revive old idle conditions or silently reset accepted delivery history.
    try {
      const old = JSON.parse(
        await Deno.readTextFile(join(directory, "state.json")),
      );
      state.legacyReceipts = [{
        version: old.schema ?? old.version,
        started: old.started,
        expires: old.expires,
        calls: old.calls,
      }];
      await Deno.writeTextFile(
        join(directory, "v2-cutover-state.json"),
        JSON.stringify(old),
        { mode: 0o600, createNew: true },
      );
    } catch (e) {
      if (
        !(e instanceof Deno.errors.NotFound) &&
        !(e instanceof Deno.errors.AlreadyExists)
      ) throw e;
    }
  }
  for (const p of Object.values(state.episodes)) {
    if (p.delivery === "dispatching") p.delivery = "uncertain";
  }
  delete state.stopped;
  const engine = new Engine(state),
    observer = new Observer(home),
    urgent = new Pool(4),
    background = new Pool(4);
  let saving = Promise.resolve();
  const save = () => {
    const raw = JSON.stringify(state);
    saving = saving.then(async () => {
      await Deno.writeTextFile(path + ".tmp", raw, { mode: 0o600 });
      await Deno.rename(path + ".tmp", path);
    });
    return saving;
  };
  function log(event: string, fields: Record<string, unknown> = {}) {
    const path = join(directory, "hook-events.jsonl");
    try {
      if (Deno.statSync(path).size > 2 * 1024 * 1024) {
        Deno.renameSync(path, path + ".1");
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    Deno.writeTextFileSync(
      path,
      JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + "\n",
      { append: true, create: true, mode: 0o600 },
    );
  }
  const read = async (id: string, pool: Pool) =>
    pool.run(async () => {
      if (stopping) return;
      try {
        engine.observe(await observer.fresh(id), Date.now());
      } catch {
        engine.failed(id, Date.now());
      }
    });
  let draining = false,
    dispatching = false,
    reconciling = false,
    stopping = false;
  let lastTick = Date.now(), nextDiscovery = 0, lastPost = 0;
  const startMono = performance.now();
  const jobs = new Set<Promise<unknown>>();
  const track = (job: Promise<unknown>) => {
    jobs.add(job);
    job.catch(() => {
      state.losses++;
    }).finally(() => jobs.delete(job));
  };
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      let claimed = 0;
      for await (const entry of Deno.readDir(spool)) {
        if (!/^\d{1,4}$/.test(entry.name) || !entry.isDirectory) continue;
        claimed++;
        if (claimed > 4096) {
          state.losses++;
          break;
        }
        const slot = join(spool, entry.name);
        let event;
        try {
          const stat = await Deno.stat(join(slot, "event.json"));
          if (stat.size > 8192) throw new Error("Oversized event");
          event = JSON.parse(await Deno.readTextFile(join(slot, "event.json")));
          if (!validEvent(event)) throw new Error("Invalid event");
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) state.losses++;
          continue;
        }
        engine.ingest(event);
        await save();
        await Deno.remove(slot, { recursive: true });
        // Coalesce routine lifecycle evidence; only attention-bearing events
        // consume urgent reads. No per-tool activity heartbeat exists.
        if (["Stop", "PermissionRequest", "PreToolUse"].includes(event.kind)) {
          track(read(event.session, urgent));
        }
      }
      try {
        const marker = JSON.parse(
          await Deno.readTextFile(join(directory, "capture-loss.json")),
        );
        if (marker.at > (state.captureLossAt ?? 0)) {
          state.captureLossAt = marker.at;
          state.losses++;
          log("capture_loss");
        }
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) state.losses++;
      }
      await Deno.writeTextFile(
        join(directory, "status.json"),
        JSON.stringify({
          version: VERSION,
          running: true,
          at: Date.now(),
          lastEvent: state.lastEvent,
          lastReconcile: state.lastReconcile,
          hookObserved: Object.values(state.actors).filter((a) =>
            a.hookVersion === VERSION
          ).length,
          snapshotOnly: Object.values(state.actors).filter((a) =>
            !a.hookVersion
          ).length,
          actors: Object.keys(state.actors).length,
          unresolved: Object.values(state.episodes).filter((p) =>
            ["candidate", "attention"].includes(p.disposition)
          ).length,
          spoolClaims: claimed,
          losses: state.losses,
          deliveryHealth: state.deliveryHealth ?? null,
          knownPosts24h: state.posts.length,
          quotaRemaining: "unknown",
          modelCalls: 0,
          gapAt: state.gapAt ?? null,
          remoteCoverage: "unverified",
        }),
        { mode: 0o600 },
      );
    } finally {
      draining = false;
    }
  }
  async function reconcile() {
    if (reconciling) return;
    reconciling = true;
    try {
      let ids: string[] = [];
      try {
        ids = await observer.loaded();
      } catch {
        state.deliveryHealth = "Current session discovery unavailable";
      }
      // Only the loaded set and actors registered by events. Never thread/list
      // over historical sessions and never a transcript sweep.
      const known = Object.values(state.actors).filter((a) =>
        engine.forActor(a.id).length || a.snapshot?.terminal === "inProgress" ||
        Date.now() - a.lastEvent < 3600000
      ).map((a) => a.id);
      const candidates = [...new Set([...known, ...ids])].slice(0, 1024);
      await Promise.all(candidates.map((id) => read(id, background)));
      state.lastReconcile = Date.now();
      engine.compact(Date.now());
      await save();
    } finally {
      reconciling = false;
    }
  }
  async function dispatch() {
    if (dispatching || stopping) return;
    dispatching = true;
    try {
      const now = Date.now();
      if (
        now - lastPost < 20000 ||
        state.posts.filter((t) => now - t < 60000).length >= 3
      ) return;
      const candidates = engine.eligible(now).slice(0, 256);
      if (!candidates.length) return;
      await Promise.all(
        [...new Set(candidates.map((p) => p.actor))].map((id) =>
          read(id, urgent)
        ),
      );
      if (stopping) return;
      const current = engine.eligible(Date.now()).filter((p) =>
        candidates.includes(p)
      );
      // Unreadable current state must remain explicitly uncertain. Do not
      // mutate the original category: it is needed for later resolution.
      const presented = current.map((p) => ({
        ...p,
        kind: !state.actors[p.actor]?.snapshot?.complete ||
            Date.now() - (state.actors[p.actor]?.snapshot?.at ?? 0) > 15000
          ? "unverified" as const
          : p.kind,
      }));
      const notification = crypto.randomUUID();
      const batch = digest(
        presented,
        Deno.build.os === "darwin" ? "Mac" : "local host",
        Date.now(),
        notification,
      );
      if (!batch.included.length) return;
      const members = batch.included.map((p) => state.episodes[p.id]);
      let topic: string;
      try {
        topic =
          (await Deno.readTextFile(join(user!, ".config/codex-nudge/topic")))
            .trim();
        if (!/^[a-zA-Z0-9_-]+$/.test(topic)) throw new Error();
      } catch {
        state.deliveryHealth = "Notification destination unavailable";
        await save();
        return;
      }
      for (const p of members) {
        if (p.delivery === "accepted") {
          p.reminded = true;
          p.reminder = true;
          p.attempts = 0;
        }
        p.delivery = "dispatching";
        p.attempts++;
      }
      const revisions = members.map((p) => p.revision);
      state.posts.push(Date.now());
      lastPost = Date.now();
      await save();
      if (stopping || members.some((p, i) => p.revision !== revisions[i])) {
        // An event or revalidation changed the batch while its intent was
        // saved. Nothing was dispatched, so safely reconsider fresh members.
        for (const p of members) {
          p.delivery = p.reminder ? "accepted" : "pending";
          p.attempts--;
          if (p.reminder) {
            p.reminded = false;
            p.reminder = false;
          }
        }
        await save();
        return;
      }
      log("dispatch_intent", {
        notification,
        members: members.map((p) => p.id),
      });
      const result = await publish(topic, batch.body);
      for (const p of members) {
        p.delivery = result.state;
        p.receipt = result.receipt;
        p.sentAt = Date.now();
        p.retryAt = result.state === "accepted"
          ? 0
          : result.retryAt ?? Number.MAX_SAFE_INTEGER;
      }
      state.deliveryHealth = result.state === "accepted"
        ? undefined
        : result.reason;
      await save();
      log("delivery", {
        notification,
        state: result.state,
        receipt: result.receipt,
        count: members.length,
      });
    } finally {
      dispatching = false;
    }
  }
  const stop = () => {
    stopping = true;
  };
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
  log("started", { version: VERSION, expiry: duration ?? null });
  await save();
  try {
    while (!stopping) {
      const now = Date.now();
      if (now - lastTick > 10000 || now < lastTick) {
        state.gapAt = now;
        for (const a of Object.values(state.actors)) {
          if (a.snapshot) a.snapshot.complete = false;
        }
        nextDiscovery = 0;
        log("observation_gap");
      }
      lastTick = now;
      await drain();
      if (now >= nextDiscovery) {
        nextDiscovery = now + 30000;
        track(reconcile());
      }
      track(dispatch());
      if (
        args.includes("--once") ||
        (duration !== undefined && performance.now() - startMono >= duration)
      ) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    stopping = true;
    observer.close();
    await Promise.allSettled([...jobs]);
    observer.close();
    state.stopped = Date.now();
    await save();
    log("stopped");
    await Deno.writeTextFile(
      join(directory, "status.json"),
      JSON.stringify({ version: VERSION, running: false, at: Date.now() }),
      { mode: 0o600 },
    );
    Deno.removeSignalListener("SIGTERM", stop);
    Deno.removeSignalListener("SIGINT", stop);
    lock.close();
  }
}
if (import.meta.main) await main();
