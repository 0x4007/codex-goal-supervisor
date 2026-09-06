import { join } from "node:path";
import { analyze } from "./analyst.ts";
import { evidence, Observer } from "./observe.ts";
import {
  directBlocker,
  eligible,
  fingerprint,
  type Packet,
  redact,
  retired,
  sameEpoch,
  suspected,
} from "./policy.ts";

type Tracked = {
  turn: string;
  seen: number;
  progress: number;
  material: string;
  analysisAt: number;
  analyses: number;
  episode: string;
  logVersion?: string;
  quietSince?: number;
};
type State = {
  started: number;
  expires: number;
  calls: number;
  modelErrors: number;
  tracked: Record<string, Tracked>;
  alerts: Record<string, string>;
  ticks: number;
  lastTick: number;
  evidenceCursor?: number;
};
function duration(s: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(s);
  if (!m) throw new Error("Use a duration such as 6h");
  const ms = Number(m[1]) * ({ s: 1000, m: 60000, h: 3600000 }[m[2]]!);
  if (ms < 1000 || ms > 86400000) {
    throw new Error("Duration must be 1 second to 24 hours");
  }
  return ms;
}
const args = Deno.args;
const smoke = args.includes("--smoke");
const once = args.includes("--once");
const durationIndex = args.indexOf("--duration");
const maxDuration = duration(
  durationIndex >= 0 ? args[durationIndex + 1] ?? "" : "6h",
);
const known = new Set(["--duration", "--smoke", "--once"]);
for (let i = 0; i < args.length; i++) {
  if (!known.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  if (args[i] === "--duration") i++;
}
const userHome = Deno.env.get("HOME");
if (!userHome) throw new Error("HOME missing");
const home = Deno.env.get("CODEX_HOME") ?? join(userHome, ".codex");
const dir = join(home, "attention-watchdog");
await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
const lock = await Deno.open(join(dir, "lock"), {
  create: true,
  read: true,
  write: true,
  mode: 0o600,
});
// OS lock is released after a crash. A stale lock file does not block a run.
const lockAbort = setTimeout(() => {
  console.error("Another watchdog holds the lock");
  Deno.exit(2);
}, 2000);
await lock.lock(true);
clearTimeout(lockAbort);
const stateFile = join(dir, smoke ? "smoke-state.json" : "state.json");
let state: State | undefined;
try {
  const raw = await Deno.readTextFile(stateFile);
  if (raw.length > 2_097_152) throw new Error("State oversized");
  state = JSON.parse(raw);
} catch (e) {
  if (!(e instanceof Deno.errors.NotFound)) throw e;
}
if (!state || state.expires <= Date.now() || smoke) {
  const priorAlerts = state?.alerts ?? {};
  state = {
    started: Date.now(),
    expires: Date.now() + maxDuration,
    calls: 0,
    modelErrors: 0,
    tracked: {},
    alerts: priorAlerts,
    ticks: 0,
    lastTick: 0,
  };
}
const run = state;
const remaining = Math.max(0, run.expires - Date.now());
const monotonicEnd = performance.now() + remaining;
let stopping = false;
const cancellation = new AbortController();
let sleeper: (() => void) | undefined;
const stop = () => {
  stopping = true;
  cancellation.abort();
  sleeper?.();
};
Deno.addSignalListener("SIGTERM", stop);
Deno.addSignalListener("SIGINT", stop);
const deadline = setTimeout(stop, remaining);
const observer = new Observer(home);
const exclude = new Set([
  Deno.env.get("CODEX_THREAD_ID") ?? "",
]);
function log(event: string, details: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, ...details }),
  );
}
async function save() {
  const raw = JSON.stringify(run);
  if (raw.length > 2_097_152) throw new Error("State exceeds cap");
  const temp = `${stateFile}.tmp`;
  await Deno.writeTextFile(temp, raw, { mode: 0o600 });
  await Deno.rename(temp, stateFile);
}
async function notify(key: string, message: string, session?: string) {
  if (run.alerts[key] || stopping) return;
  run.alerts[key] = "attempted";
  await save();
  const topic =
    (await Deno.readTextFile(join(userHome!, ".config/codex-nudge/topic")))
      .trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(topic)) {
    throw new Error("Invalid notification topic");
  }
  const body = `${redact(message, 850)}${
    session ? `\nSession: ${session}` : ""
  }`;
  try {
    const response = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(5000), cancellation.signal]),
      headers: {
        Title: "Codex needs attention",
        Click: "https://chatgpt.com",
        "Content-Type": "text/plain; charset=utf-8",
      },
      body,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Notification HTTP error");
    }
    const receipt = await response.json();
    run.alerts[key] = `sent:${receipt.id}`;
    log("notification_sent", { session, receipt: receipt.id });
  } catch {
    run.alerts[key] = "delivery_uncertain";
    log("notification_unconfirmed", { session });
  }
  await save();
}
let failedSince = 0;
let lastScan = 0;
try {
  if (smoke) {
    await observer.open();
    const { rows } = await observer.discover([], exclude);
    log("smoke_discovery", { threads: rows.length });
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
    const packet: Packet = {
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
    const verdict = await analyze(home, packet, cancellation.signal);
    if (!eligible(verdict, packet)) {
      throw new Error("Synthetic blocker was not identified");
    }
    log("smoke_luna", {
      classification: verdict.classification,
      model: "gpt-5.6-luna",
      reasoning: "medium",
    });
    await notify(
      `smoke:${run.started}`,
      "Watchdog test passed: local sessions and Luna triage work. The six-hour monitor is being started; future messages will name the blocker and action needed.",
    );
  } else {
    log("started", {
      expires: new Date(run.expires).toISOString(),
      callsRemaining: 12 - run.calls,
    });
    while (
      !stopping && Date.now() < run.expires && performance.now() < monotonicEnd
    ) {
      const tickStart = Date.now();
      try {
        if (observer.socket?.readyState !== 1) {
          observer.close();
          await observer.open();
        }
        const discovery = await observer.discover(
          Object.keys(run.tracked),
          exclude,
        );
        const scan = Date.now() - lastScan >= 300000;
        let watched = 0;
        let analyzed = false;
        let bytes = 0;
        let broken = 0;
        const offset = (run.evidenceCursor ?? 0) %
          Math.max(1, discovery.rows.length);
        const ordered = [
          ...discovery.rows.slice(offset),
          ...discovery.rows.slice(0, offset),
        ];
        let visited = 0;
        for (const row of ordered) {
          if (stopping) break;
          // Bound total observation time; rotate next tick instead of starving later rows.
          if (Date.now() - tickStart > 45000) {
            broken++;
            break;
          }
          visited++;
          let s;
          try {
            s = await observer.snapshot(row);
          } catch {
            broken++;
            log("session_observation_failed", { session: row.id });
            continue;
          }
          if (retired(s)) {
            delete run.tracked[s.id];
            continue;
          }
          // Do not resurrect historical ordinary failures during startup discovery.
          if (
            !run.tracked[s.id] && s.updated < run.started &&
            s.runtime !== "active" &&
            !["active", "blocked"].includes(s.goal ?? "") && !s.flags.length
          ) continue;
          watched++;
          const previous = run.tracked[s.id];
          const t = previous?.turn === s.turn ? previous : {
            turn: s.turn,
            seen: Date.now(),
            progress: Date.now(),
            material: "",
            analysisAt: 0,
            analyses: 0,
            episode: "",
          };
          run.tracked[s.id] = t;
          if (
            s.terminal === "failed" && s.runtime !== "active" &&
            Date.now() - t.seen >= 300000
          ) {
            const fresh = await observer.fresh(s.id);
            if (sameEpoch(s, fresh)) {
              await notify(
                await fingerprint(`${s.id}:${s.turn}:failed`),
                `${s.label}: the latest turn failed and no newer turn has appeared during five minutes of observation. Open the session to check recovery.`,
                s.id,
              );
            }
          }
          const direct = directBlocker(s);
          if (direct) {
            if (!t.episode.startsWith(`${direct}:`)) {
              t.episode = `${direct}:${Date.now()}`;
            }
            let fresh;
            try {
              fresh = await observer.fresh(s.id);
            } catch {
              broken++;
              continue;
            }
            if (sameEpoch(s, fresh) && directBlocker(fresh) === direct) {
              await notify(
                await fingerprint(`${s.id}:${s.turn}:${t.episode}`),
                `${s.label}: ${
                  direct === "approval"
                    ? "Approval required. Open the session and approve or deny the pending request."
                    : "Your input is required. Open the session and answer the pending question."
                }`,
                s.id,
              );
            }
            continue;
          }
          t.episode = "";
          if (!scan || bytes >= 4_194_304) continue;
          let p;
          try {
            p = await evidence(row.path, s);
          } catch {
            broken++;
            log("session_evidence_unavailable", { session: s.id });
            continue;
          }
          bytes += 262144;
          if (t.logVersion !== p.logVersion) t.quietSince = Date.now();
          t.logVersion = p.logVersion;
          // An unchanged file establishes a fully observed silence interval even
          // when the earlier turn start is outside the bounded tail.
          p.complete ||= Date.now() - (t.quietSince ?? Date.now()) >= 600000;
          const material = await fingerprint(
            p.records.filter((r) => r.kind === "change" || r.kind === "user")
              .map((r) => r.id).join(","),
          );
          if (
            t.material && material !== t.material &&
            p.records.some((r) =>
              ["change", "user"].includes(r.kind) && r.at > t.progress
            )
          ) {
            t.progress = Date.now();
            t.analyses = 0;
            t.episode = "";
          }
          t.material = material;
          p.silenceMs = Date.now() - t.progress;
          if (
            !suspected(p) || analyzed || run.calls >= 12 ||
            run.modelErrors >= 3 ||
            t.analyses >= 2 || Date.now() - t.analysisAt < 900000
          ) continue;
          analyzed = true;
          t.analysisAt = Date.now();
          t.analyses++;
          run.calls++;
          await save();
          try {
            const verdict = await analyze(home, p, cancellation.signal);
            run.modelErrors = 0;
            log("analysis", {
              session: s.id,
              classification: verdict.classification,
              confidence: verdict.confidence,
              calls: run.calls,
            });
            if (eligible(verdict, p)) {
              const fresh = await observer.fresh(s.id);
              if (sameEpoch(s, fresh)) {
                await notify(
                  await fingerprint(`${s.id}:${s.turn}:user`),
                  `${s.label}: ${redact(verdict.blocker, 240)}\nAction: ${
                    redact(verdict.requested_action, 240)
                  }`,
                  s.id,
                );
              }
            }
          } catch {
            run.modelErrors++;
            log("analyst_failed", {
              session: s.id,
              consecutive: run.modelErrors,
            });
          }
        }
        if (scan || visited < ordered.length) {
          run.evidenceCursor = offset + Math.max(1, Math.min(visited, 16));
        }
        if (scan) lastScan = Date.now();
        if (broken) {
          failedSince ||= Date.now();
          if (Date.now() - failedSince >= 180000) {
            await notify(
              `observer:${run.started}`,
              "Watchdog cannot read some sessions. Other sessions remain monitored. Check the Mac session logs for the missing coverage.",
            );
          }
        } else failedSince = 0;
        run.ticks++;
        run.lastTick = Date.now();
        await save();
        log("scan", {
          discovered: discovery.rows.length,
          watched,
          broken,
          partial: discovery.partial,
          calls: run.calls,
          ticks: run.ticks,
        });
      } catch {
        failedSince ||= Date.now();
        log("observer_failed");
        if (Date.now() - failedSince >= 180000) {
          await notify(
            `observer:${run.started}`,
            "Watchdog cannot read session status. Monitoring coverage is unavailable; the agents themselves may still be working. Check the Mac connection.",
          );
        }
      }
      if (once || stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          resolve,
          Math.max(100, 60000 - (Date.now() - tickStart)),
        );
        sleeper = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      sleeper = undefined;
    }
  }
} finally {
  clearTimeout(deadline);
  observer.close();
  await save();
  await lock.unlock();
  lock.close();
  log("stopped", { expired: Date.now() >= run.expires, calls: run.calls });
}
