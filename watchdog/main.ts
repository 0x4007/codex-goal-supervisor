import { join } from "node:path";
import { Engine, type Episode, newState, type State } from "./engine.ts";
import { Observer } from "./observe.ts";
import {
  identifier,
  notificationLabels,
  validEvent,
  VERSION,
} from "./policy.ts";
export class Pool {
  active = 0;
  constructor(readonly limit: number) {}
  tryRun<T>(fn: () => Promise<T>): Promise<T> | undefined {
    if (this.active >= this.limit) return;
    this.active++;
    return (async () => {
      try {
        return await fn();
      } finally {
        this.active--;
      }
    })();
  }
}
// A slow batch gets one bounded opportunity to refresh. Unchecked members are
// explicitly unverified; they never build a FIFO queue ahead of new hooks.
export async function revalidateBatch(
  ids: string[],
  pool: Pool,
  read: (id: string, signal: AbortSignal) => Promise<void>,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, 3000);
  });
  const work: Promise<void>[] = [];
  const attempted = new Set<string>();
  for (const id of new Set(ids)) {
    const job = pool.tryRun(() => read(id, controller.signal));
    if (job) {
      attempted.add(id);
      work.push(job);
    } else break;
  }
  try {
    await Promise.race([Promise.allSettled(work), deadline]);
  } finally {
    clearTimeout(timer!);
    controller.abort();
  }
  return attempted;
}
export function digest(
  episodes: Episode[],
  host: string,
  titles: Record<string, string | undefined>,
) {
  const lines: string[] = [];
  const included: Episode[] = [];
  const prefix = `Codex attention on ${host}\n`;
  for (const p of episodes) {
    const title = Array.from(
      (titles[p.actor] ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(
        /\s+/gu,
        " ",
      ).trim(),
    ).slice(0, 160).join("") || "Untitled session";
    const line = `${title} — ${notificationLabels[p.kind]}${
      p.delivery === "accepted" ? " (reminder)" : ""
    }`;
    const body = prefix + [...lines, line].join("\n");
    if (new TextEncoder().encode(body).length > 3072) break;
    lines.push(line);
    included.push(p);
  }
  return {
    included,
    body: prefix + lines.join("\n"),
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
  }
  for (const p of Object.values(state.episodes)) {
    if (p.delivery === "dispatching") p.delivery = "uncertain";
  }
  delete state.stopped;
  const engine = new Engine(state),
    observer = new Observer(home),
    urgent = new Pool(4);
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
  const read = async (id: string, signal = AbortSignal.timeout(3000)) => {
    if (stopping) return;
    try {
      engine.observe(await observer.fresh(id, signal), Date.now());
    } catch {
      engine.failed(id, Date.now());
    }
  };
  let draining = false,
    dispatching = false,
    stopping = false;
  let lastTick = Date.now(),
    lastPost = 0;
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
        engine.compact(Date.now());
        engine.ingest(event);
        await save();
        await Deno.remove(slot, { recursive: true });
        // Coalesce routine lifecycle evidence; only attention-bearing events
        // consume urgent reads. No per-tool activity heartbeat exists.
        if (["Stop", "PermissionRequest", "PreToolUse"].includes(event.kind)) {
          const job = urgent.tryRun(() => read(event.session));
          if (job) track(job);
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
      const revalidationAt = Date.now();
      const attempted = await revalidateBatch(
        candidates.map((p) => p.actor),
        urgent,
        read,
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
            (state.actors[p.actor]?.snapshot?.at ?? 0) < revalidationAt ||
            (state.actors[p.actor]?.failedAt ?? 0) >= revalidationAt
          ? "unverified" as const
          : p.kind,
      })).filter((p) => {
        if (p.delivery !== "accepted") return true;
        const snapshot = state.actors[p.actor]?.snapshot;
        return p.kind !== "unverified" && snapshot &&
          (p.kind === "approval"
            ? snapshot.flags.includes("waitingOnApproval")
            : p.kind === "input"
            ? snapshot.flags.includes("waitingOnUserInput")
            : snapshot.goal === "blocked" || snapshot.terminal === "failed");
      });
      // Only attempted reminders move their deadline. Unchecked actors retain
      // priority, so failed reads cannot monopolize the four RPC slots. Persist
      // the delay even when nothing is sent; do not consume the allowance.
      for (const p of candidates) {
        if (p.delivery === "accepted" && attempted.has(p.actor)) {
          p.retryAt = Date.now() + 20000;
        }
      }
      const notification = crypto.randomUUID();
      const batch = digest(
        presented,
        Deno.build.os === "darwin" ? "Mac" : "VPS",
        Object.fromEntries(
          Object.values(state.actors).map((a) => [a.id, a.snapshot?.title]),
        ),
      );
      if (!batch.included.length) {
        await save();
        return;
      }
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
        log("observation_gap");
      }
      lastTick = now;
      await drain();
      if (args.includes("--once")) {
        await dispatch();
        break;
      }
      track(dispatch());
      if (
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
