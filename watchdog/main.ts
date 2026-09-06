import { join } from "node:path";
import { analyze } from "./analyst.ts";
import { evidence, Observer } from "./observe.ts";
import {
  type Delivery,
  Engine,
  failureOf,
  MINUTE,
  newState,
  restoreState,
} from "./engine.ts";
import { eligible, type Packet, redact } from "./policy.ts";

function duration(s: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(s);
  if (!m) throw new Error("Use a duration such as 6h");
  const ms = Number(m[1]) * ({ s: 1000, m: 60000, h: 3600000 }[m[2]]!);
  if (ms < 1000 || ms > 86400000) {
    throw new Error("Duration must be 1 second to 24 hours");
  }
  return ms;
}
const args = Deno.args,
  smoke = args.includes("--smoke"),
  once = args.includes("--once");
const di = args.indexOf("--duration"),
  maxDuration = duration(di >= 0 ? args[di + 1] ?? "" : "6h");
for (let i = 0; i < args.length; i++) {
  if (!["--duration", "--smoke", "--once"].includes(args[i])) {
    throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (args[i] === "--duration") i++;
}
const userHome = Deno.env.get("HOME");
if (!userHome) throw new Error("HOME missing");
const home = Deno.env.get("CODEX_HOME") ?? join(userHome, ".codex"),
  dir = join(home, "attention-watchdog");
await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
const lock = await Deno.open(join(dir, "lock"), {
  create: true,
  read: true,
  write: true,
  mode: 0o600,
});
const lockTimer = setTimeout(() => {
  console.error("Another watchdog holds the lock");
  Deno.exit(2);
}, 2000);
await lock.lock(true);
clearTimeout(lockTimer);
const stateFile = join(dir, smoke ? "smoke-state.json" : "state.json");
let prior: any;
try {
  const file = await Deno.open(stateFile, { read: true });
  try {
    if ((await file.stat()).size > 2_097_152) {
      throw new Error("State oversized");
    }
  } finally {
    file.close();
  }
  prior = JSON.parse(await Deno.readTextFile(stateFile));
} catch (e) {
  if (!(e instanceof Deno.errors.NotFound)) throw e;
}
const started = Date.now();
const run = smoke
  ? newState(started, Math.min(maxDuration, 120_000))
  : restoreState(prior, started, maxDuration);
const logPath = join(dir, smoke ? "smoke-events.jsonl" : "events.jsonl");
function log(event: string, fields: Record<string, unknown> = {}) {
  const row = JSON.stringify({
    schema: 2,
    time: new Date().toISOString(),
    namespace: home,
    event,
    ...fields,
  }) + "\n";
  // Synchronous bounded records preserve ordering before a crash; never transcripts.
  try {
    if (Deno.statSync(logPath).size + row.length > 10 * 1024 * 1024) {
      try {
        Deno.removeSync(`${logPath}.2`);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
      try {
        Deno.renameSync(`${logPath}.1`, `${logPath}.2`);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
      Deno.renameSync(logPath, `${logPath}.1`);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  Deno.writeTextFileSync(logPath, row, {
    append: true,
    create: true,
    mode: 0o600,
  });
  console.log(row.trimEnd());
}
let saving = Promise.resolve();
function save(): Promise<void> {
  const raw = JSON.stringify(run);
  if (raw.length > 2_097_152) {
    return Promise.reject(new Error("State exceeds cap"));
  }
  saving = saving.then(async () => {
    await Deno.writeTextFile(`${stateFile}.tmp`, raw, { mode: 0o600 });
    await Deno.rename(`${stateFile}.tmp`, stateFile);
  });
  return saving;
}

if (prior && prior.expires <= started && !smoke) {
  const archive = join(dir, "summaries");
  await Deno.mkdir(archive, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    join(archive, `${prior.started}.json`),
    JSON.stringify({
      started: prior.started,
      expires: prior.expires,
      calls: prior.calls,
      ticks: prior.ticks,
      stopped: prior.stopped ?? "unknown",
      counters: prior.counters ?? null,
    }),
    { mode: 0o600 },
  );
  const files = [...Deno.readDirSync(archive)].filter((f) =>
    f.isFile && /^\d+\.json$/.test(f.name)
  ).sort((a, b) => b.name.localeCompare(a.name));
  for (const file of files.slice(10)) {
    await Deno.remove(join(archive, file.name));
  }
}
let stopping = false, stopReason = "expired", sleeper: (() => void) | undefined;
const cancellation = new AbortController();
const startMono = performance.now(),
  remaining = Math.max(0, run.expires - started),
  monoEnd = startMono + remaining;
function stop(reason = "expired") {
  stopping = true;
  stopReason = reason;
  cancellation.abort();
  observer.close();
  sleeper?.();
}
Deno.addSignalListener("SIGTERM", () => stop("signal"));
Deno.addSignalListener("SIGINT", () => stop("signal"));
const deadline = setTimeout(() => stop(), remaining);
const observer = new Observer(home);
async function send(message: string, session?: string): Promise<Delivery> {
  let topic: string;
  try {
    topic =
      (await Deno.readTextFile(join(userHome!, ".config/codex-nudge/topic")))
        .trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(topic)) throw new Error();
  } catch {
    return { state: "unsent", category: "configuration" };
  }
  try {
    const response = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(5000), cancellation.signal]),
      headers: {
        Title: "Codex watchdog",
        Click: "https://chatgpt.com",
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: `${redact(message, 850)}${session ? `\nSession: ${session}` : ""}`,
    });
    if (!response.ok) {
      const retry = response.headers.get("retry-after");
      const seconds = retry === null ? NaN : Number(retry);
      const retryAt = Number.isFinite(seconds)
        ? Date.now() + seconds * 1000
        : Date.parse(retry ?? "");
      await response.body?.cancel();
      return {
        state: "rejected",
        category: response.status === 429
          ? "rate_limit"
          : [401, 403].includes(response.status)
          ? "auth"
          : "http",
        retryAt: Number.isFinite(retryAt) ? retryAt : undefined,
      };
    }
    const receipt = await response.json();
    return typeof receipt.id === "string"
      ? { state: "accepted", receipt: receipt.id }
      : { state: "uncertain", category: "invalid_receipt" };
  } catch {
    return { state: "uncertain", category: "transport" };
  }
}
async function fresh(id: string, withEvidence: boolean): Promise<Packet> {
  const snapshot = await observer.fresh(id);
  // Missing fields remain marked unavailable; identity can use the last known
  // turn, but analysis still requires verified current fields.
  if (snapshot.coverage?.turn === false) {
    snapshot.turn = run.tracked[id]?.turn ?? "";
  }
  if (withEvidence) {
    const row = (await observer.call("thread/read", {
      threadId: id,
      includeTurns: false,
    })).thread;
    const p = await evidence(row.path, snapshot);
    p.complete &&= snapshot.coverage?.turn !== false &&
      snapshot.coverage?.goal !== false && snapshot.coverage?.runtime !== false;
    return p;
  }
  return {
    snapshot,
    records: [],
    complete: false,
    silenceMs: 0,
    repeatedFailures: 0,
  };
}
const engine = new Engine(run, {
  now: () => Date.now(),
  save,
  log,
  analyze: (p, dispatched) =>
    analyze(
      home,
      p,
      AbortSignal.any([
        cancellation.signal,
        AbortSignal.timeout(
          Math.max(1, Math.min(30000, observer.deadline - Date.now())),
        ),
      ]),
      dispatched,
    ),
  fresh,
  send,
});
observer.onFailure = (id, f) => engine.failure(id, f);
observer.onSuccess = (id, m) => engine.success(id, m);
observer.readDue = (id, m) => engine.readDue(id, m);
const exclude = new Set([Deno.env.get("CODEX_THREAD_ID") ?? ""]);
let lastEvidence = 0;
try {
  await save();
  log("started", {
    runId: run.runId,
    version: 2,
    expires: new Date(run.expires).toISOString(),
    calls: run.calls,
    nextCredit: run.nextCredit,
    resumed: prior?.expires > started && !smoke,
  });
  if (run.counters.migrated) {
    await engine.queue(
      `migration:${run.runId}`,
      "Watchdog upgraded to paced analysis: at most one model attempt every 15 minutes. Existing run expiry is preserved.",
    );
  }
  if (smoke) {
    await observer.open();
    const discovery = await observer.discover([], exclude);
    log("smoke_discovery", {
      threads: discovery.rows.length,
      reasons: discovery.reasons,
    });
    const snapshot = {
      id: "synthetic",
      turn: "test",
      runtime: "idle",
      flags: [],
      goal: "blocked",
      terminal: "completed",
      label: "Watchdog test",
      updated: Date.now(),
      parent: null,
    };
    const p: Packet = {
      snapshot,
      complete: true,
      silenceMs: 0,
      repeatedFailures: 0,
      records: [{
        id: "e1",
        at: Date.now(),
        kind: "assistant",
        text:
          "I need your approval before continuing. Please open this session and approve or deny the pending operation.",
      }],
    };
    run.calls++;
    await save();
    const result = await analyze(home, p, cancellation.signal);
    if (!eligible(result.verdict, p)) {
      throw new Error("Synthetic blocker was not identified");
    }
    log("smoke_luna", {
      classification: result.verdict.classification,
      model: result.model,
      reasoning: "medium",
      usage: result.usage,
    });
    await engine.queue(
      `smoke:${run.runId}`,
      "Watchdog V2 test passed: real session discovery and Luna triage work. This short test is ending; no six-hour monitor was started.",
    );
    await engine.flush();
    stopReason = "smoke_complete";
  } else {while (
      !stopping && Date.now() < run.expires && performance.now() < monoEnd
    ) {
      const tickStart = Date.now();
      observer.deadline = Math.min(run.expires, tickStart + 45_000);
      const drift = (tickStart - started) - (performance.now() - startMono);
      if (Math.abs(drift) > 120_000) {
        log("health_transition", {
          component: "clock",
          state: "degraded",
          drift,
        });
        stop("clock_jump");
        break;
      }
      if (run.expires - tickStart <= 10_000 && maxDuration >= 10_000) {
        await engine.expiry();
        await engine.flush();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            resolve,
            Math.max(1, run.expires - Date.now()),
          );
          sleeper = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        sleeper = undefined;
        break;
      }
      try {
        if (!engine.readDue("connection", "discover")) throw { backoff: true };
        if (observer.socket?.readyState !== 1) {
          observer.close();
          await observer.open();
        }
        await engine.tick(async () => {
          const discovery = await observer.discover(
            Object.keys(run.tracked),
            exclude,
          );
          engine.success("connection", "discover");
          await engine.health(
            "discovery",
            discovery.reasons.includes("capacity") ? "capacity" : "",
            "Watchdog discovery capacity reached; some sessions are not covered.",
          );
          const rows = discovery.rows;
          const ordered = [
            ...rows.slice(run.cursor % Math.max(1, rows.length)),
            ...rows.slice(0, run.cursor % Math.max(1, rows.length)),
          ];
          ordered.sort((a, b) =>
            Number(
              (b.status?.activeFlags ?? []).some((f: string) =>
                ["waitingOnApproval", "waitingOnUserInput"].includes(f)
              ),
            ) - Number((a.status?.activeFlags ?? []).some((f: string) =>
              ["waitingOnApproval", "waitingOnUserInput"].includes(f)
            ))
          );
          let visited = 0;
          const observed = new Map<string, { row: any; snapshot: any }>();
          for (const row of ordered) {
            if (
              stopping || Date.now() - tickStart >= 20_000 ||
              run.expires - Date.now() < 10_000
            ) break;
            visited++;
            const s = await observer.snapshot(row);
            if (s.coverage?.turn === false) {
              s.turn = run.tracked[s.id]?.turn ?? "";
            }
            // Baseline ordinary historical failures; retain loaded active/blocked work.
            if (
              !run.tracked[s.id] && s.updated < run.started &&
              s.runtime !== "active" &&
              !["active", "blocked"].includes(s.goal ?? "") &&
              !s.flags.length &&
              s.coverage?.goal && s.coverage?.turn
            ) continue;
            await engine.snapshot(s);
            observed.set(s.id, { row, snapshot: s });
          }
          run.cursor = (run.cursor + Math.max(1, visited)) %
            Math.max(1, rows.length);
          if (visited < rows.length) {
            log("observation_result", {
              state: "partial",
              category: "tick_deadline",
              visited,
              discovered: rows.length,
            });
          }
          if (Date.now() - lastEvidence >= 5 * MINUTE) {
            const entries = [...observed.values()].filter((x) =>
              run.tracked[x.snapshot.id]
            ).sort((a, b) =>
              (run.tracked[a.snapshot.id].evidenceAt -
                run.tracked[b.snapshot.id].evidenceAt) ||
              a.snapshot.id.localeCompare(b.snapshot.id)
            );
            let tails = 0;
            let scanned = 0;
            for (const { row, snapshot: s } of entries) {
              if (
                stopping || tails >= 16 || Date.now() - tickStart >= 30_000 ||
                run.expires - Date.now() < 10_000
              ) break;
              if (
                !engine.readDue(s.id, "evidence") || run.tracked[s.id]?.direct
              ) continue;
              tails++;
              try {
                const p = await evidence(row.path, s);
                p.complete &&= s.coverage?.turn !== false &&
                  s.coverage?.goal !== false && s.coverage?.runtime !== false;
                engine.success(s.id, "evidence");
                await engine.observe(p);
                scanned++;
              } catch (e) {
                engine.failure(s.id, failureOf(e, "evidence"));
              }
            }
            if (scanned > 0) lastEvidence = Date.now();
          }

          run.ticks++;
          run.lastTick = Date.now();
          log("scan", {
            discovered: rows.length,
            watched: Object.keys(run.tracked).length,
            reasons: discovery.reasons,
            calls: run.calls,
            ticks: run.ticks,
          });
        }, observer.deadline);
      } catch (e) {
        if (!stopping && !(e && typeof e === "object" && "backoff" in e)) {
          engine.failure("connection", failureOf(e, "discover"));
        }
      }
      if (!stopping) {
        await engine.healthCheck();
        if (Date.now() < observer.deadline) {
          await engine.flush(observer.deadline);
        }
        if (Date.now() - run.summaryAt >= 5 * MINUTE) engine.summary();
        await save();
      }
      if (stopping) break;
      if (once) {
        stopReason = "once";
        break;
      }
      const wait = Math.max(
        1,
        Math.min(
          MINUTE - (Date.now() - tickStart),
          run.expires - Date.now() - (maxDuration >= 10_000 ? 10_000 : 0),
        ),
      );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        sleeper = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      sleeper = undefined;
    }}
} finally {
  clearTimeout(deadline);
  observer.close();
  run.stopped = stopReason;
  engine.summary();
  await save();
  await lock.unlock();
  lock.close();
  log("stopped", {
    runId: run.runId,
    reason: stopReason,
    expired: Date.now() >= run.expires,
    calls: run.calls,
  });
}
