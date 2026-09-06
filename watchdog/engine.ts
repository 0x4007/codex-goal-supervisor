import {
  directBlocker,
  eligible,
  fingerprint,
  type Packet,
  redact,
  retired,
  type Snapshot,
  suspected,
  type Verdict,
} from "./policy.ts";

export const MINUTE = 60_000;
export const CREDIT_MS = 15 * MINUTE;
export type Failure = {
  category: string;
  method: string;
  code?: number;
  retryAt?: number;
};
export class WatchdogError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.category);
  }
}
export function failureOf(e: unknown, method = "unknown"): Failure {
  if (e instanceof WatchdogError) {
    return {
      ...e.failure,
      method: method === "unknown" ? e.failure.method : method,
    };
  }
  return {
    method,
    category: e instanceof Deno.errors.NotFound
      ? "not_found"
      : e instanceof Deno.errors.PermissionDenied
      ? "permission"
      : e instanceof SyntaxError
      ? "invalid_data"
      : e instanceof DOMException && e.name === "TimeoutError"
      ? "timeout"
      : "unavailable",
  };
}
export type Analysis = {
  verdict: Verdict;
  usage: Record<string, number> | null;
  model: string;
};
export type Delivery = {
  state: "accepted" | "rejected" | "uncertain" | "unsent";
  receipt?: string;
  category?: string;
  retryAt?: number;
};
type Incident = {
  open: boolean;
  sequence: number;
  signature: string;
  since: number;
};
type ReadFailure = {
  first: number;
  last: number;
  count: number;
  next: number;
  failure: Failure;
};
type Candidate = {
  version: string;
  since: number;
  next: number;
  analyses: number;
};
type Tracked = {
  turn: string;
  snapshot: Snapshot;
  seen: number;
  progress: number;
  evidenceAt: number;
  contextComplete?: boolean;
  version: string;
  candidate?: Candidate;
  direct?: string;
  directSequence: number;
  analyses: number;
  analysisAt: number;
  verdict?: string;
  userEpoch?: string;
  recheckAt?: number;
  failures: Record<string, ReadFailure>;
};
type Alert = {
  key: string;
  message: string;
  session?: string;
  turn?: string;
  version?: string;
  direct?: string;
  failed?: boolean;
  priority: number;
  created: number;
  next: number;
  attempts: number;
  state: "queued" | "dispatching" | Delivery["state"] | "resolved";
  receipt?: string;
  category?: string;
  resolved?: number;
};
export type State = {
  version: 2;
  runId: string;
  started: number;
  expires: number;
  calls: number;
  modelErrors: number;
  ticks: number;
  lastTick: number;
  nextCredit: number;
  nextProbe: number;
  disabled: boolean;
  stopped?: string;
  tracked: Record<string, Tracked>;
  alerts: Record<string, Alert>;
  health: Record<string, Incident>;
  faults: Record<string, ReadFailure>;
  attempts: {
    id: string;
    at: number;
    state: string;
    session: string;
    usage?: Record<string, number> | null;
  }[];
  counters: Record<string, number>;
  posts: number[];
  cursor: number;
  evidenceCursor: number;
  summaryAt: number;
  expiryNotified: boolean;
};
export function newState(now: number, duration: number): State {
  return {
    version: 2,
    runId: crypto.randomUUID(),
    started: now,
    expires: now + duration,
    calls: 0,
    modelErrors: 0,
    ticks: 0,
    lastTick: now,
    nextCredit: now,
    nextProbe: now,
    disabled: false,
    tracked: {},
    alerts: {},
    health: {},
    faults: {},
    attempts: [],
    counters: {},
    posts: [],
    cursor: 0,
    evidenceCursor: 0,
    summaryAt: now,
    expiryNotified: false,
  };
}
export function restoreState(value: any, now: number, duration: number): State {
  if (!value) return newState(now, duration);
  if (
    !Number.isFinite(value.started) || !Number.isFinite(value.expires) ||
    value.expires <= value.started || !Number.isInteger(value.calls) ||
    value.calls < 0
  ) throw new Error("Invalid watchdog state");
  if (Number.isFinite(value.lastTick) && value.lastTick > now + 120_000) {
    throw new Error(
      "Watchdog clock moved backwards; preserve state and correct clock before resuming",
    );
  }
  if (value.expires <= now) return newState(now, duration);
  if (value.version === 2) {
    for (const key of ["tracked", "alerts", "health", "faults", "counters"]) {
      if (
        !value[key] || typeof value[key] !== "object" ||
        Array.isArray(value[key])
      ) throw new Error("Invalid watchdog state");
    }
    for (
      const key of [
        "nextCredit",
        "nextProbe",
        "lastTick",
        "ticks",
        "modelErrors",
        "cursor",
        "evidenceCursor",
        "summaryAt",
      ]
    ) {
      if (!Number.isFinite(value[key])) {
        throw new Error("Invalid watchdog state");
      }
    }
    if (
      !Array.isArray(value.attempts) || !Array.isArray(value.posts) ||
      Object.keys(value.tracked).length > 128 ||
      Object.keys(value.alerts).length > 1024
    ) throw new Error("Invalid watchdog state");
    // A dispatch with no known response is never automatically repeated.
    for (const a of Object.values(value.alerts) as Alert[]) {
      if (a.state === "dispatching") a.state = "uncertain";
    }
    for (const a of value.attempts) {
      if (["reserved", "dispatched"].includes(a.state)) a.state = "uncertain";
    }
    // Explicit restart after configuration repair permits a bounded fresh probe.
    value.disabled = false;
    delete value.stopped;
    return value;
  }
  if (value.version !== undefined || !value.tracked || !value.alerts) {
    throw new Error("Unsupported watchdog state version");
  }
  const s = newState(value.started, value.expires - value.started);
  s.calls = value.calls;
  s.nextCredit = now + CREDIT_MS;
  s.nextProbe = s.nextCredit;
  s.counters.migrated = 1;
  // Preserve V1 dedup receipts as historical records, not V2 semantic claims.
  for (const [key, result] of Object.entries(value.alerts).slice(-1024)) {
    s.alerts[`v1:${key}`] = {
      key: `v1:${key}`,
      message: "Historical V1 notification",
      priority: 3,
      created: value.started,
      next: 0,
      attempts: 1,
      state: String(result).startsWith("sent:") ? "accepted" : "uncertain",
      receipt: String(result).startsWith("sent:")
        ? String(result).slice(5)
        : undefined,
      resolved: now,
    };
  }
  return s;
}
export type Dependencies = {
  now: () => number;
  save: () => Promise<void>;
  log: (event: string, fields?: Record<string, unknown>) => void;
  analyze: (p: Packet, dispatched: () => Promise<void>) => Promise<Analysis>;
  fresh: (id: string, evidence: boolean) => Promise<Packet>;
  send: (message: string, session?: string) => Promise<Delivery>;
};
// Semantic hashing excludes boilerplate and event timestamps. Source IDs remain
// separate evidence references; punctuation-only restatements share an episode.
export async function semanticVersion(p: Packet): Promise<string> {
  const relevant = p.records.filter((r) =>
    ["user", "change", "command"].includes(r.kind) ||
    (r.kind === "assistant" &&
      /need|please|blocked|cannot|can't|permission|approv|access|sign.in|log.in|missing|select|choose|provide|waiting|minutes|hours/i
        .test(r.text))
  );
  const normalized = [
    ...new Set(
      relevant.map((r) =>
        `${r.kind}:${
          r.kind === "assistant"
            ? r.text.toLowerCase().replace(/\b(?:please|kindly)\b/g, "")
              .replace(
                /[^a-z0-9]+/g,
                " ",
              ).trim()
            : ["command", "change"].includes(r.kind)
            ? r.text
            : r.id
        }`
      ),
    ),
  ];
  return await fingerprint(
    JSON.stringify([p.snapshot.turn, p.snapshot.goal, normalized]),
  );
}
export class Engine {
  packets = new Map<string, Packet>();
  decisions = new Map<
    string,
    { reason: string; first: number; last: number; count: number }
  >();
  constructor(readonly state: State, readonly io: Dependencies) {}
  event(event: string, fields: Record<string, unknown> = {}) {
    this.io.log(event, {
      runId: this.state.runId,
      elapsed: this.io.now() - this.state.started,
      ...fields,
    });
  }
  count(name: string) {
    this.state.counters[name] = (this.state.counters[name] ?? 0) + 1;
  }
  decision(id: string, reason: string, version = "") {
    this.count(`decision:${reason}`);
    const key = `${id}:${version}`;
    const old = this.decisions.get(key);
    const now = this.io.now();
    if (old?.reason === reason) {
      old.last = now;
      old.count++;
      return;
    }
    if (old) this.event("candidate_decision", { session: id, version, ...old });
    this.decisions.set(key, { reason, first: now, last: now, count: 1 });
    this.event("candidate_decision", { session: id, version, reason, at: now });
    if (this.decisions.size > 256) {
      this.decisions.delete(this.decisions.keys().next().value!);
    }
  }
  async queue(key: string, message: string, fields: Partial<Alert> = {}) {
    if (this.state.alerts[key]) {
      this.event("alert_decision", { key, reason: "deduplicated" });
      return;
    }
    if (Object.keys(this.state.alerts).length >= 1024) {
      const resolved = Object.values(this.state.alerts).filter((a) =>
        a.resolved
      ).sort((a, b) =>
        a.resolved! - b.resolved!
      )[0];
      if (resolved) delete this.state.alerts[resolved.key];
      else {
        this.event("health_transition", {
          component: "ledger",
          state: "degraded",
          reason: "capacity",
        });
        this.count("ledger_overflow");
        return;
      }
    }
    const now = this.io.now();
    this.state.alerts[key] = {
      key,
      message: redact(message, 850),
      priority: 1,
      created: now,
      next: now,
      attempts: 0,
      state: "queued",
      ...fields,
    };
    this.event("alert_decision", {
      key,
      session: fields.session,
      reason: "queued",
    });
  }
  async health(component: string, signature: string, message: string) {
    const now = this.io.now();
    const old = this.state.health[component];
    if (!signature) {
      if (!old?.open) return;
      old.open = false;
      this.event("health_transition", {
        component,
        state: "recovered",
        incident: old.sequence,
      });
      await this.queue(
        `health:${component}:${old.sequence}:recovered`,
        `Watchdog ${component} coverage recovered.`,
        { priority: 2 },
      );
      for (const a of Object.values(this.state.alerts)) {
        if (
          a.key.startsWith(`health:${component}:`) &&
          a.key !== `health:${component}:${old.sequence}:recovered`
        ) {
          a.resolved = now;
          if (a.state === "queued") a.state = "resolved";
        }
      }
      return;
    }
    if (old?.open && old.signature === signature) return;
    for (const a of Object.values(this.state.alerts)) {
      if (a.state === "queued" && a.key.startsWith(`health:${component}:`)) {
        a.state = "resolved";
        a.resolved = now;
      }
    }
    const sequence = (old?.sequence ?? 0) + 1;
    this.state.health[component] = {
      open: true,
      sequence,
      signature,
      since: old?.open ? old.since : now,
    };
    this.event("health_transition", {
      component,
      state: "degraded",
      signature,
      incident: sequence,
    });
    await this.queue(`health:${component}:${sequence}`, message, {
      priority: 1,
    });
  }
  failure(id: string, failure: Failure) {
    const now = this.io.now();
    const target = this.state.tracked[id]?.failures ?? this.state.faults;
    const key = this.state.tracked[id]
      ? failure.method
      : `${id}:${failure.method}`;
    if (!target[key] && Object.keys(target).length >= 512) {
      this.count("observation_fault_capacity");
      this.event("health_transition", {
        component: "observation",
        state: "degraded",
        reason: "fault_capacity",
      });
      return;
    }
    const old = target[key];
    const count = (old?.count ?? 0) + 1;
    const delay = count >= 3 ? 10 : [1, 2][count - 1];
    target[key] = {
      first: old?.first ?? now,
      last: now,
      count,
      next: Math.max(now + delay * MINUTE, failure.retryAt ?? 0),
      failure,
    };
    this.count("observation_failures");
    this.event("observation_result", {
      session: id,
      state: "failure",
      ...failure,
      consecutive: count,
      nextRetry: target[key].next,
    });
  }
  readDue(id: string, method: string) {
    const f = this.state.tracked[id]?.failures[method] ??
      this.state.faults[`${id}:${method}`];
    return !f || f.next <= this.io.now();
  }
  success(id: string, method: string) {
    if (this.state.tracked[id]) delete this.state.tracked[id].failures[method];
    delete this.state.faults[`${id}:${method}`];
    this.event("observation_result", { session: id, method, state: "success" });
  }
  async snapshot(s: Snapshot) {
    const now = this.io.now();
    if (retired(s)) {
      for (const key of Object.keys(this.state.faults)) {
        if (key.startsWith(`${s.id}:`)) delete this.state.faults[key];
      }
      delete this.state.tracked[s.id];
      this.packets.delete(s.id);
      for (const a of Object.values(this.state.alerts)) {
        if (a.session === s.id) {
          a.resolved = now;
          if (a.state === "queued") a.state = "resolved";
        }
      }
      this.decision(s.id, "retired");
      return;
    }
    let t = this.state.tracked[s.id];
    if (!t && Object.keys(this.state.tracked).length >= 128) {
      await this.health(
        "capacity",
        "sessions",
        "Watchdog session capacity reached; discovery coverage is incomplete.",
      );
      return;
    }
    if (!t || t.turn !== s.turn) {
      for (const a of Object.values(this.state.alerts)) {
        if (a.session === s.id && a.turn !== s.turn) {
          a.resolved = now;
          if (a.state === "queued") a.state = "resolved";
        }
      }
      t = {
        turn: s.turn,
        snapshot: s,
        seen: now,
        progress: now,
        evidenceAt: 0,
        version: "",
        directSequence: 0,
        analyses: 0,
        analysisAt: 0,
        failures: t?.failures ?? {},
      };
      this.state.tracked[s.id] = t;
    }
    t.snapshot = s;
    if (
      s.terminal === "failed" && s.runtime !== "active" &&
      now - t.seen >= 5 * MINUTE
    ) {
      await this.queue(
        `${s.id}:${s.turn}:terminal_failed`,
        `${s.label}: the latest turn failed and no newer turn has appeared during five minutes of observation. Open the session to check recovery.`,
        { session: s.id, turn: s.turn, failed: true, priority: 0 },
      );
    }
    const direct = directBlocker(s);
    if (direct) {
      if (t.direct !== direct) t.directSequence++;
      t.direct = direct;
      delete t.candidate;
      await this.queue(
        `${s.id}:${s.turn}:direct:${direct}:${t.directSequence}`,
        `${s.label}: ${
          direct === "approval"
            ? "Approval required. Open the session and approve or deny the pending request."
            : "Your input is required. Open the session and answer the pending question."
        }`,
        { priority: 0, session: s.id, turn: s.turn, direct },
      );
      this.decision(s.id, "direct_alert");
    } else if (s.coverage?.runtime !== false) {
      t.direct = undefined;
      for (const a of Object.values(this.state.alerts)) {
        if (a.session === s.id && a.direct) {
          a.resolved = now;
          if (a.state === "queued") a.state = "resolved";
        }
      }
    }
  }
  async observe(p: Packet) {
    await this.snapshot(p.snapshot);
    const t = this.state.tracked[p.snapshot.id];
    if (!t || t.direct) return;
    const now = this.io.now();
    // An incomplete scan cannot establish a new semantic episode or resolve an
    // existing alert. Retain its identity until complete current evidence arrives.
    if (!p.complete) {
      t.evidenceAt = now;
      t.contextComplete = false;
      this.packets.set(p.snapshot.id, p);
      delete t.candidate;
      this.decision(p.snapshot.id, "incomplete_evidence", t.version);
      return;
    }
    const version = await semanticVersion(p);
    t.evidenceAt = now;
    t.contextComplete = p.complete;
    const latestUser = p.records.filter((r) => r.kind === "user").at(-1);
    if (latestUser) t.userEpoch = latestUser.id;
    if (t.version !== version) {
      if (
        t.version &&
        p.records.some((r) =>
          ["change", "user"].includes(r.kind) && r.at > t.progress
        )
      ) t.progress = now;
      for (const a of Object.values(this.state.alerts)) {
        if (a.session === p.snapshot.id && a.version && a.version !== version) {
          a.resolved = now;
          if (a.state === "queued") a.state = "resolved";
        }
      }
      t.analyses = 0;
      t.verdict = undefined;
    }
    t.version = version;
    p.silenceMs = now - t.progress;
    this.packets.set(p.snapshot.id, p);
    if (!p.complete) {
      delete t.candidate;
      this.decision(p.snapshot.id, "incomplete_evidence", version);
      return;
    }
    if (!suspected(p)) {
      delete t.candidate;
      this.decision(p.snapshot.id, "not_suspect", version);
      return;
    }
    // A second pass over exactly the same evidence is useful only for one timed
    // expected-wait recheck. Unknown/user verdicts wait for new semantic evidence.
    if (
      t.analyses &&
      (t.verdict !== "expected_wait" || !t.recheckAt || t.analyses >= 2)
    ) {
      delete t.candidate;
      this.decision(
        p.snapshot.id,
        t.analyses >= 2 ? "episode_limit" : "unchanged_evidence",
        version,
      );
      return;
    }
    if (t.candidate?.version !== version) {
      t.candidate = {
        version,
        since: now,
        next: Math.max(
          now,
          t.analysisAt + CREDIT_MS,
          t.analyses ? t.recheckAt ?? now : now,
        ),
        analyses: t.analyses,
      };
    }
    this.decision(p.snapshot.id, "fair_queue", version);
  }
  async tick(observe: () => Promise<void>, deadline: number) {
    const calls = this.state.calls;
    // Begin useful inference before the slow observation phase. State saves are
    // serialized by the runtime; session alerts still revalidate in the outbox.
    const analysis = this.analyzeOne(deadline);
    try {
      await this.flush(deadline);
      await observe();
      await this.flush(deadline);
    } finally {
      await analysis;
    }
    // Fresh first-sweep candidates may use spare time; slow sweeps leave them
    // queued for the early analysis phase of the next tick.
    if (this.state.calls === calls && deadline - this.io.now() >= 39_000) {
      await this.analyzeOne(deadline);
    }
    if (deadline - this.io.now() >= 10_000) await this.flush(deadline);
  }
  async analyzeOne(deadline = Infinity) {
    const now = this.io.now();
    const candidates = Object.entries(this.state.tracked).filter(([, t]) =>
      t.candidate
    ).sort((a, b) =>
      a[1].candidate!.since - b[1].candidate!.since || a[0].localeCompare(b[0])
    );
    let selected: [string, Tracked] | undefined;
    for (const [id, t] of candidates) {
      const c = t.candidate!;
      const reason = deadline - now < 39_000
        ? "tick_deadline"
        : this.state.expires - now < 40_000
        ? "expiry"
        : this.state.disabled
        ? "provider_disabled"
        : now < this.state.nextProbe
        ? "provider_backoff"
        : now < this.state.nextCredit
        ? "credit_wait"
        : now < c.next
        ? "cooldown"
        : !this.readDue(id, "fresh")
        ? "observation_backoff"
        : !this.packets.has(id) || now - t.evidenceAt > 6 * MINUTE
        ? "incomplete_evidence"
        : selected
        ? "fair_queue"
        : "selected";
      this.decision(id, reason, c.version);
      if (reason === "selected") selected = [id, t];
    }
    if (!selected) return;
    const [id, t] = selected;
    const version = t.candidate!.version;
    const userEpoch = t.userEpoch;
    let p: Packet;
    try {
      p = await this.io.fresh(id, true);
      this.success(id, "fresh");
    } catch (e) {
      this.failure(id, failureOf(e, "fresh"));
      return;
    }
    if (
      retired(p.snapshot) || directBlocker(p.snapshot) || !p.complete ||
      await semanticVersion(p) !== version
    ) {
      await this.observe(p);
      this.decision(id, "stale", version);
      return;
    }
    const at = this.io.now();
    if (this.state.expires - at < 40_000 || deadline - at < 30_000) return;
    this.state.calls++;
    this.state.nextCredit = at + CREDIT_MS;
    t.analysisAt = at;
    t.analyses++;
    delete t.candidate;
    const attempt = {
      id: `${this.state.runId}:${this.state.calls}`,
      at,
      state: "reserved",
      session: id,
      usage: null as Record<string, number> | null,
    };
    this.state.attempts.push(attempt);
    this.state.attempts = this.state.attempts.slice(-128);
    await this.io.save();
    this.event("analysis_reserved", {
      attempt: attempt.id,
      session: id,
      version,
      nextCredit: this.state.nextCredit,
    });
    let result: Analysis | undefined;
    try {
      result = await this.io.analyze(p, async () => {
        attempt.state = "dispatched";
        await this.io.save();
        this.event("analysis_dispatched", { attempt: attempt.id, session: id });
      });
      attempt.state = "completed";
      attempt.usage = result.usage;
      this.state.modelErrors = 0;
      this.state.nextProbe = 0;
      if (t.version === version) {
        t.verdict = result.verdict.classification;
        t.recheckAt = undefined;
        if (t.verdict === "expected_wait") {
          const stated = p.records.filter((r) => r.kind === "assistant").map(
            (r) => ({
              r,
              m: /(?:wait|takes?|allow|within|up to)\D{0,20}(\d{1,3})\s*(seconds?|minutes?|hours?)/i
                .exec(r.text),
            }),
          ).find((x) => x.m);
          if (stated?.m) {
            const factor = /hour/i.test(stated.m[2])
              ? 60 * MINUTE
              : /minute/i.test(stated.m[2])
              ? MINUTE
              : 1000;
            t.recheckAt = Math.max(
              this.io.now() + CREDIT_MS,
              stated.r.at + Number(stated.m[1]) * factor,
            );
          }
        }
      }
      this.event("analysis_completed", {
        attempt: attempt.id,
        session: id,
        version,
        model: result.model,
        requestedEffort: "medium",
        classification: result.verdict.classification,
        evidenceIds: result.verdict.evidence_ids,
        usage: result.usage,
        latency: this.io.now() - at,
      });
      await this.health("provider", "", "");
    } catch (e) {
      const failure = failureOf(e, "analysis");
      const wasDispatched = attempt.state === "dispatched";
      attempt.state = "failed";
      this.state.modelErrors++;
      this.event("analysis_failed", {
        attempt: attempt.id,
        session: id,
        ...failure,
        dispatched: wasDispatched,
      });
      if (["auth", "configuration"].includes(failure.category)) {
        this.state.disabled = true;
      }
      if (
        this.state.modelErrors >= 3 || this.state.disabled || failure.retryAt
      ) {
        const delay =
          [5, 15, 30][Math.min(2, Math.max(0, this.state.modelErrors - 3))] *
          MINUTE;
        this.state.nextProbe = Math.max(
          this.io.now() + delay,
          failure.retryAt ?? 0,
        );
        await this.health(
          "provider",
          this.state.disabled ? "disabled" : "backoff",
          this.state.disabled
            ? "Watchdog analysis is disabled by an authentication or configuration error. Fix the existing provider configuration and restart this run. Direct approval checks continue."
            : "Watchdog analysis is unavailable after provider errors. Direct approval checks continue; a paced probe will retry useful work.",
        );
      }
      // Failed attempts may retry useful unchanged evidence after backoff; these
      // are new charged attempts, not automatic resubmission inside the adapter.
      if (t.version === version) {
        t.analyses = 0;
        t.candidate = {
          version,
          since: at,
          next: Math.max(this.state.nextCredit, this.state.nextProbe),
          analyses: 0,
        };
      }
    }
    if (result && eligible(result.verdict, p)) {
      const cited = p.records.filter((r) =>
        result!.verdict.evidence_ids.includes(r.id) && r.kind === "assistant"
      );
      const request = await fingerprint(
        cited.map((r) =>
          r.text.toLowerCase().replace(/\b(?:please|kindly)\b/g, "").replace(
            /[^a-z0-9]+/g,
            " ",
          ).trim()
        ).sort().join("|"),
      );
      // The outbox revalidates current fields and evidence immediately before POST.
      await this.queue(
        `${id}:${p.snapshot.turn}:request:${request}:${
          t.userEpoch ?? "initial"
        }`,
        `${p.snapshot.label}: ${redact(result.verdict.blocker, 240)}\nAction: ${
          redact(result.verdict.requested_action, 240)
        }`,
        { session: id, turn: p.snapshot.turn, version, priority: 0 },
      );
    }
    await this.io.save();
  }
  async healthCheck() {
    const now = this.io.now();
    const failed = [
      ...Object.entries(this.state.faults).map(([id, f]) => [id, f] as const),
      ...Object.entries(this.state.tracked).flatMap(([id, t]) =>
        Object.entries(t.failures).map(([m, f]) => [`${id}:${m}`, f] as const)
      ),
    ].filter(([, f]) => now - f.first >= 3 * MINUTE);
    const missing = Object.entries(this.state.tracked).filter(([, t]) =>
      !t.direct && now - t.seen >= 10 * MINUTE &&
      (!this.packets.get(t.snapshot.id)?.complete ||
        now - t.evidenceAt >= 10 * MINUTE)
    );
    await this.health(
      "observation",
      failed.length || missing.length
        ? await fingerprint(
          [
            ...failed.map(([id]) => id),
            ...missing.map(([id]) => `context:${id}`),
          ].sort().join(","),
        )
        : "",
      `Watchdog coverage is incomplete for ${
        new Set([
          ...failed.map(([id]) => id.split(":")[0]),
          ...missing.map(([id]) => id),
        ]).size
      } session or connection sources. Other sessions remain monitored. Check the local Codex connection and coverage log.`,
    );
    const overdue = Object.values(this.state.tracked).filter((t) =>
      t.candidate && now - t.candidate.since >= CREDIT_MS
    );
    await this.health(
      "analysis",
      overdue.length ? "delayed" : "",
      `Watchdog analysis is delayed for ${overdue.length} sessions. Direct approval checks continue. Next credit or probe: ${
        new Date(Math.max(now, this.state.nextCredit, this.state.nextProbe))
          .toISOString()
      }.`,
    );
  }
  async flush(deadline = Infinity) {
    const now = this.io.now();
    this.state.posts = this.state.posts.filter((at) => now - at < MINUTE);
    const pending = Object.values(this.state.alerts).filter((a) =>
      a.state === "queued" && a.next <= now
    ).sort((a, b) => a.priority - b.priority || a.created - b.created);
    for (const a of pending) {
      if (
        this.io.now() >= deadline || this.io.now() >= this.state.expires ||
        this.state.posts.length >=
          (!this.state.expiryNotified &&
              this.state.expires - this.io.now() <= 70_000
            ? 2
            : 3)
      ) {
        break;
      }
      if (a.session) {
        if (!this.readDue(a.session, "notification_revalidation")) continue;
        try {
          const p = await this.io.fresh(a.session, Boolean(a.version));
          if (a.version && !p.complete) {
            this.failure(a.session, {
              method: "notification_revalidation",
              category: "incomplete_evidence",
            });
            a.next = now + MINUTE;
            continue;
          }
          this.success(a.session, "notification_revalidation");
          if (
            retired(p.snapshot) || p.snapshot.turn !== a.turn ||
            (a.direct && directBlocker(p.snapshot) !== a.direct) ||
            (a.version && directBlocker(p.snapshot)) ||
            (a.failed &&
              (p.snapshot.terminal !== "failed" ||
                p.snapshot.runtime === "active" ||
                p.snapshot.coverage?.turn === false)) ||
            (a.version &&
              (!p.complete || await semanticVersion(p) !== a.version))
          ) {
            a.state = "resolved";
            a.resolved = this.io.now();
            this.event("alert_decision", { key: a.key, reason: "stale" });
            continue;
          }
        } catch (e) {
          this.failure(a.session, failureOf(e, "notification_revalidation"));
          a.next = now + MINUTE;
          continue;
        }
      }
      a.state = "dispatching";
      a.attempts++;
      this.state.posts.push(this.io.now());
      await this.io.save();
      this.event("alert_dispatch", {
        key: a.key,
        session: a.session,
        attempt: a.attempts,
      });
      let result: Delivery;
      try {
        result = await this.io.send(a.message, a.session);
      } catch {
        result = { state: "uncertain", category: "transport" };
      }
      a.state = result.state;
      a.receipt = result.receipt;
      a.category = result.category;
      this.count(`delivery:${result.state}`);
      this.event("alert_result", { key: a.key, session: a.session, ...result });
      if (
        (result.state === "unsent" ||
          (result.state === "rejected" && result.category === "rate_limit")) &&
        a.attempts < 3
      ) {
        a.state = "queued";
        a.next = Math.max(now + MINUTE, result.retryAt ?? 0);
      }
      if (result.state !== "accepted") {
        this.event("health_transition", {
          component: "delivery",
          state: result.state,
          category: result.category,
        });
        this.state.counters.deliveryDegraded = 1;
      } else if (this.state.counters.deliveryDegraded) {
        this.event("health_transition", {
          component: "delivery",
          state: "service_accepted",
          note: "Earlier uncertain messages remain uncertain",
        });
        this.state.counters.deliveryDegraded = 0;
      }
      await this.io.save();
    }
  }
  summary() {
    const now = this.io.now();
    const ts = Object.values(this.state.tracked);
    const queue = ts.filter((t) => t.candidate);
    const result = {
      watched: ts.length,
      covered: ts.filter((t) =>
        !Object.keys(t.failures).length &&
        (t.direct || (t.contextComplete && now - t.evidenceAt <= 6 * MINUTE))
      ).length,
      unknown: ts.filter((t) =>
        Object.keys(t.failures).length ||
        (!t.direct && (!t.contextComplete || now - t.evidenceAt > 6 * MINUTE))
      ).length,
      queued: queue.length,
      maxSourceAgeMs: Math.max(
        0,
        ...ts.map((t) => now - (t.snapshot.observedAt ?? t.seen)),
      ),
      maxEvidenceAgeMs: Math.max(
        0,
        ...ts.filter((t) => !t.direct).map((t) =>
          now - (t.evidenceAt || t.seen)
        ),
      ),
      modelErrors: this.state.modelErrors,
      analysisDisabled: this.state.disabled,
      oldestQueueMs: Math.max(0, ...queue.map((t) => now - t.candidate!.since)),
      nextCredit: this.state.nextCredit,
      nextProbe: this.state.nextProbe,
      calls: this.state.calls,
      counters: this.state.counters,
      health: this.state.health,
    };
    this.event("coverage_summary", result);
    this.state.summaryAt = now;
    for (const [key, decision] of this.decisions) {
      this.event("candidate_decision", { key, ...decision });
    }
    this.decisions.clear();
    return result;
  }
  async expiry() {
    if (this.state.expiryNotified) return;
    this.state.expiryNotified = true;
    const s = this.summary();
    await this.queue(
      `expiry:${this.state.runId}`,
      `Watchdog monitoring ends at ${
        new Date(this.state.expires).toISOString()
      }. ${s.calls} model attempts; ${
        this.state.counters["delivery:accepted"] ?? 0
      } notifications accepted by ntfy. ${s.unknown} sessions have incomplete coverage; ${s.queued} analyses remain queued.`,
      { priority: -1 },
    );
  }
}
