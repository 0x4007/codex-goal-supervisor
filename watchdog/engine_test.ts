import {
  CREDIT_MS,
  type Delivery,
  Engine,
  MINUTE,
  newState,
  restoreState,
  semanticVersion,
  WatchdogError,
} from "./engine.ts";
import { type Packet } from "./policy.ts";
function assert(value: unknown, message = "Assertion failed"): void {
  if (!value) throw new Error(message);
}
const epoch = Date.parse("2026-09-06T03:28:13Z");
function packet(
  id = "a",
  text = "I need your approval to deploy.",
  version = 0,
): Packet {
  return {
    snapshot: {
      id,
      turn: "t",
      runtime: "idle",
      flags: [],
      goal: "blocked",
      terminal: "completed",
      label: id,
      updated: epoch + version,
      parent: null,
      coverage: { runtime: true, goal: true, turn: true },
    },
    records: [{
      id: `e${version}`,
      at: epoch + version,
      kind: "assistant",
      text,
    }],
    complete: true,
    silenceMs: 0,
    repeatedFailures: 0,
  };
}
function harness() {
  let now = epoch;
  const state = newState(now, 6 * 60 * MINUTE);
  const packets = new Map<string, Packet>();
  const events: { event: string; fields: any }[] = [];
  const calls: { id: string; at: number }[] = [];
  const sent: string[] = [];
  let failures = 0;
  let auth = false;
  let delivery: Delivery = { state: "accepted", receipt: "test" };
  const engine = new Engine(state, {
    now: () => now,
    save: async () => {},
    log: (event, fields) => events.push({ event, fields }),
    fresh: async (id) => {
      const p = packets.get(id);
      if (!p) throw new Error("Missing");
      return structuredClone(p);
    },
    analyze: async (p, dispatched) => {
      await dispatched();
      calls.push({ id: p.snapshot.id, at: now });
      if (failures > 0) {
        failures--;
        throw new WatchdogError({
          method: "analysis",
          category: auth ? "auth" : "provider",
        });
      }
      return {
        model: "gpt-5.6-luna",
        usage: { input_tokens: 100, output_tokens: 20 },
        verdict: {
          classification: "needs_user",
          confidence: "high",
          evidence_ids: [
            (p.records.find((r) => r.kind === "assistant") ?? p.records[0]).id,
          ],
          blocker: "Approval required",
          requested_action: "Approve or deny.",
        },
      };
    },
    send: async (message) => {
      sent.push(message);
      return delivery;
    },
  });
  return {
    engine,
    state,
    events,
    calls,
    sent,
    packets,
    setTime: (v: number) => now = v,
    advance: (v: number) => now += v,
    fail: (n: number, isAuth = false) => {
      failures = n;
      auth = isAuth;
    },
    delivery: (v: Delivery) => delivery = v,
    put: async (p: Packet) => {
      packets.set(p.snapshot.id, p);
      await engine.observe(structuredClone(p));
    },
  };
}
Deno.test("six-hour incident replay paces 24 attempts and keeps later-hour analysis", async () => {
  const h = harness();
  for (let minute = 0; minute < 360; minute++) {
    h.setTime(epoch + minute * MINUTE);
    await h.put(
      packet(
        "a",
        `I need your approval for release ${minute}.`,
        minute,
      ),
    );
    await h.engine.analyzeOne();
    await h.engine.healthCheck();
  }
  assert(h.calls.length === 24, `calls=${h.calls.length}`);
  for (let i = 1; i < h.calls.length; i++) {
    assert(h.calls[i].at - h.calls[i - 1].at >= CREDIT_MS);
  }
  assert(h.calls.some((c) => c.at > epoch + 5 * 60 * MINUTE));
  assert(
    h.events.some((e) =>
      e.event === "candidate_decision" && e.fields.reason === "credit_wait"
    ),
  );
  const resumed = restoreState(
    JSON.parse(JSON.stringify(h.state)),
    epoch + 359 * MINUTE,
    6 * 60 * MINUTE,
  );
  assert(
    resumed.calls === 24 && resumed.expires === epoch + 360 * MINUTE &&
      resumed.nextCredit >= resumed.expires,
  );
});
Deno.test("fair queue does not starve an older session when earlier rows change", async () => {
  const h = harness();
  await h.put(packet("a"));
  await h.put(packet("b"));
  await h.put(packet("c"));
  await h.engine.analyzeOne();
  h.advance(CREDIT_MS);
  await h.put(packet("b"));
  await h.put(packet("c"));
  await h.put(packet("a", "I need your approval for another operation.", 2));
  await h.engine.analyzeOne();
  h.advance(CREDIT_MS);
  await h.put(packet("c"));
  await h.engine.analyzeOne();
  assert(h.calls.map((c) => c.id).join(",") === "a,b,c");
});
Deno.test("zero credit still delivers direct approval and emits delayed coverage once", async () => {
  const h = harness();
  h.state.nextCredit = epoch + 60 * MINUTE;
  await h.put(packet("a"));
  const p = packet("b");
  p.snapshot.flags = ["waitingOnApproval"];
  await h.put(p);
  await h.engine.flush();
  assert(h.sent.length === 1 && h.sent[0].includes("Approval required"));
  assert(h.calls.length === 0);
  h.advance(CREDIT_MS);
  await h.engine.healthCheck();
  await h.engine.flush();
  const count = h.sent.length;
  h.advance(MINUTE);
  await h.engine.healthCheck();
  await h.engine.flush();
  assert(h.sent.length === count);
  assert(h.state.health.analysis.open);
});
Deno.test("different blockers in one turn alert separately and restatements deduplicate", async () => {
  const h = harness();
  await h.put(packet());
  await h.engine.analyzeOne();
  await h.engine.flush();
  assert(h.sent.length === 1);
  h.advance(CREDIT_MS);
  await h.put(packet("a", "Please, I need your approval to deploy!", 2));
  await h.engine.analyzeOne();
  await h.engine.flush();
  assert(h.sent.length === 1 && h.calls.length === 1);
  await h.put(packet("a", "I need your login access for the browser.", 3));
  await h.engine.analyzeOne();
  await h.engine.flush();
  assert(h.sent.length === 2);
});
Deno.test("paused, resolved and stale pending alerts never send", async () => {
  const h = harness();
  const p = packet();
  p.snapshot.flags = ["waitingOnUserInput"];
  await h.put(p);
  p.snapshot.goal = "paused";
  h.packets.set("a", p);
  await h.engine.flush();
  assert(h.sent.length === 0);
});
Deno.test("provider failure circuit recovers through a charged useful probe", async () => {
  const h = harness();
  h.fail(3);
  await h.put(packet());
  for (let n = 0; n < 3; n++) {
    h.setTime(epoch + n * CREDIT_MS);
    await h.put(packet());
    await h.engine.analyzeOne();
  }
  assert(h.state.modelErrors === 3 && h.state.health.provider.open);
  const calls = h.calls.length;
  h.advance(5 * MINUTE);
  await h.engine.analyzeOne();
  assert(h.calls.length === calls);
  h.advance(10 * MINUTE);
  await h.put(packet());
  await h.engine.analyzeOne();
  assert(
    h.calls.length === 4 && !h.state.health.provider.open &&
      h.state.modelErrors === 0,
  );
});
Deno.test("auth rejection disables analysis visibly until explicit restart", async () => {
  const h = harness();
  h.fail(1, true);
  await h.put(packet());
  await h.engine.analyzeOne();
  assert(h.state.disabled);
  h.advance(60 * MINUTE);
  await h.put(packet());
  await h.engine.analyzeOne();
  assert(h.calls.length === 1);
  const restored = restoreState(
    JSON.parse(JSON.stringify(h.state)),
    epoch + 60 * MINUTE,
    6 * 60 * MINUTE,
  );
  assert(
    !restored.disabled && restored.calls === 1 &&
      restored.expires === h.state.expires,
  );
});
Deno.test("61 failed reads preserve per-source coverage, backoff and distinct recurrence", async () => {
  const h = harness();
  for (const id of ["a", "b", "c"]) await h.put(packet(id));
  for (let n = 0; n < 61; n++) {
    const id = ["a", "b", "c"][n % 3];
    h.engine.failure(id, { method: "thread/goal/get", category: "not_found" });
  }
  h.advance(3 * MINUTE);
  await h.engine.healthCheck();
  assert(h.state.health.observation.open);
  const sequence = h.state.health.observation.sequence;
  assert(!h.engine.readDue("a", "thread/goal/get"));
  for (const id of ["a", "b", "c"]) h.engine.success(id, "thread/goal/get");
  await h.engine.healthCheck();
  assert(!h.state.health.observation.open);
  h.engine.failure("a", { method: "thread/goal/get", category: "timeout" });
  h.advance(3 * MINUTE);
  await h.engine.healthCheck();
  assert(h.state.health.observation.sequence > sequence);
  assert(Object.keys(h.state.tracked).length === 3);
});
Deno.test("uncertain dispatch survives restart without blind resend", async () => {
  const h = harness();
  h.delivery({ state: "uncertain", category: "transport" });
  await h.engine.queue("x", "test");
  await h.engine.flush();
  h.advance(MINUTE);
  await h.engine.flush();
  assert(h.sent.length === 1);
  const s = restoreState(
    JSON.parse(JSON.stringify(h.state)),
    epoch + MINUTE,
    6 * 60 * MINUTE,
  );
  assert(s.alerts.x.state === "uncertain");
  s.alerts.x.state = "dispatching";
  assert(
    restoreState(s, epoch + MINUTE, 6 * 60 * MINUTE).alerts.x.state ===
      "uncertain",
  );
});
Deno.test("definite rate limit retries are bounded and respect the server delay", async () => {
  const h = harness();
  h.delivery({
    state: "rejected",
    category: "rate_limit",
    retryAt: epoch + 5 * MINUTE,
  });
  await h.engine.queue("x", "test");
  await h.engine.flush();
  h.advance(MINUTE);
  await h.engine.flush();
  assert(h.sent.length === 1);
  h.advance(4 * MINUTE);
  await h.engine.flush();
  assert(h.sent.length === 2);
  h.advance(MINUTE);
  await h.engine.flush();
  assert(h.sent.length === 3);
  h.advance(MINUTE);
  await h.engine.flush();
  assert(h.sent.length === 3);
});
Deno.test("outbox rate limit retains messages and expiry summary is idempotent", async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) await h.engine.queue(String(i), "test");
  await h.engine.flush();
  assert(h.sent.length === 3);
  h.advance(MINUTE);
  await h.engine.flush();
  assert(h.sent.length === 5);
  await h.engine.expiry();
  await h.engine.expiry();
  assert(
    Object.values(h.state.alerts).filter((a) => a.key.startsWith("expiry:"))
      .length === 1,
  );
});
Deno.test("V1 cutover preserves deadline and consumed attempts without free credit", () => {
  const old = {
    started: epoch,
    expires: epoch + 360 * MINUTE,
    calls: 12,
    tracked: {},
    alerts: { a: "sent:receipt" },
  };
  const s = restoreState(old, epoch + 125 * MINUTE, 6 * 60 * MINUTE);
  assert(
    s.calls === 12 && s.nextCredit === epoch + 140 * MINUTE &&
      s.expires === old.expires && s.alerts["v1:a"].receipt === "receipt",
  );
  let rejected = false;
  try {
    restoreState(
      { version: 99, started: epoch, expires: epoch + 360 * MINUTE, calls: 0 },
      epoch,
      1,
    );
  } catch {
    rejected = true;
  }
  assert(rejected);
});
Deno.test("unchanged log silence never upgrades incomplete semantic context", async () => {
  const h = harness();
  const p = packet();
  p.complete = false;
  await h.put(p);
  h.advance(60 * MINUTE);
  await h.put(p);
  await h.engine.analyzeOne();
  await h.engine.healthCheck();
  assert(h.calls.length === 0);
  assert(
    h.events.some((e) =>
      e.event === "candidate_decision" &&
      e.fields.reason === "incomplete_evidence"
    ),
  );
});
Deno.test("semantic identity ignores irrelevant chatter but changes with a new action", async () => {
  const p = packet();
  const v = await semanticVersion(p);
  p.records.push({
    id: "noise",
    at: epoch,
    kind: "assistant",
    text: "Still checking.",
  });
  assert(await semanticVersion(p) === v);
  p.records.push({
    id: "new",
    at: epoch + 1,
    kind: "assistant",
    text: "I need your access to the VPS.",
  });
  assert(await semanticVersion(p) !== v);
});

Deno.test("new user reply permits a later identical request in the same turn", async () => {
  const h = harness();
  await h.put(packet());
  await h.engine.analyzeOne();
  await h.engine.flush();
  h.advance(CREDIT_MS);
  const p = packet();
  p.records.unshift({
    id: "reply",
    at: epoch + MINUTE,
    kind: "user",
    text: "I approved the previous action.",
  });
  await h.put(p);
  await h.engine.analyzeOne();
  await h.engine.flush();
  assert(h.sent.length === 2);
});
Deno.test("blocked goal cannot turn command evidence into invented human action", async () => {
  const h = harness();
  const p = packet();
  p.records = [{
    id: "cmd",
    at: epoch,
    kind: "command",
    text: "Command abc completed with exit 1.",
  }];
  await h.put(p);
  await h.engine.analyzeOne();
  await h.engine.flush();
  assert(h.sent.length === 0);
});
Deno.test("repeated status command outcomes do not create new semantic episodes", async () => {
  const p = packet();
  p.records.push({
    id: "cmd1",
    at: epoch,
    kind: "command",
    text: "Command abc completed with exit 0.",
  });
  const before = await semanticVersion(p);
  p.records.push({
    id: "cmd2",
    at: epoch + MINUTE,
    kind: "command",
    text: "Command abc completed with exit 0.",
  });
  assert(await semanticVersion(p) === before);
});
Deno.test("partial semantic evidence is reported as uncovered despite recent successful reads", async () => {
  const h = harness();
  const p = packet();
  p.complete = false;
  await h.put(p);
  h.advance(10 * MINUTE);
  await h.put(p);
  await h.engine.healthCheck();
  const summary = h.engine.summary();
  assert(
    h.state.health.observation.open && summary.covered === 0 &&
      summary.unknown === 1,
  );
});
Deno.test("same health component burst coalesces before transport", async () => {
  const h = harness();
  await h.engine.health("observation", "a", "One source failed.");
  await h.engine.health("observation", "ab", "Two sources failed.");
  await h.engine.flush();
  assert(h.sent.length === 1 && h.sent[0].includes("Two"));
});
Deno.test("tick observation budget defers inference before reserving a call", async () => {
  const h = harness();
  await h.put(packet());
  await h.engine.analyzeOne(epoch + 20_000);
  assert(h.calls.length === 0 && h.state.calls === 0);
  assert(
    h.events.some((e) =>
      e.event === "candidate_decision" && e.fields.reason === "tick_deadline"
    ),
  );
});
Deno.test("final minute reserves a transport slot for the expiry summary", async () => {
  const h = harness();
  h.setTime(h.state.expires - 60_000);
  for (let i = 0; i < 3; i++) await h.engine.queue(`work${i}`, "test");
  await h.engine.flush();
  assert(h.sent.length === 2);
  h.setTime(h.state.expires - 10_000);
  await h.engine.expiry();
  await h.engine.flush();
  assert(h.sent.length === 3 && h.sent[2].includes("monitoring ends"));
});

Deno.test("terminal failures remain a deterministic attention path after recovery grace", async () => {
  const h = harness();
  const p = packet();
  p.snapshot.goal = null;
  p.snapshot.terminal = "failed";
  await h.put(p);
  h.advance(5 * MINUTE);
  await h.engine.snapshot(p.snapshot);
  await h.engine.flush();
  assert(
    h.calls.length === 0 && h.sent.length === 1 &&
      h.sent[0].includes("check recovery"),
  );
});
Deno.test("archived work retires even if stale runtime remains active", async () => {
  const h = harness();
  const p = packet();
  p.snapshot.archived = true;
  p.snapshot.runtime = "active";
  await h.put(p);
  await h.engine.analyzeOne();
  assert(h.calls.length === 0 && Object.keys(h.state.tracked).length === 0);
});

Deno.test("temporary missing revalidation evidence defers rather than resolves an alert", async () => {
  const h = harness();
  await h.put(packet());
  await h.engine.analyzeOne();
  const partial = packet();
  partial.complete = false;
  h.packets.set("a", partial);
  await h.engine.flush();
  assert(
    h.sent.length === 0 &&
      Object.values(h.state.alerts).some((a) => a.state === "queued"),
  );
  h.advance(MINUTE);
  h.packets.set("a", packet());
  await h.engine.flush();
  assert(
    h.sent.length === 1 &&
      !h.state.tracked.a.failures.notification_revalidation,
  );
});
Deno.test("restart rejects a backwards clock rather than resetting run credit", () => {
  const s = newState(epoch, 360 * MINUTE);
  s.lastTick = epoch + 10 * MINUTE;
  let rejected = false;
  try {
    restoreState(s, epoch, 360 * MINUTE);
  } catch {
    rejected = true;
  }
  assert(rejected);
});

Deno.test("incomplete observation cannot retire a queued semantic alert", async () => {
  const h = harness();
  await h.put(packet());
  await h.engine.analyzeOne();
  await h.put({ ...packet(), complete: false, records: [] });
  h.advance(CREDIT_MS);
  await h.put(packet());
  await h.engine.analyzeOne();
  await h.engine.flush();
  assert(h.sent.length === 1 && h.calls.length === 1);
});
Deno.test("stale complete evidence opens observation-health incident", async () => {
  const h = harness();
  await h.put(packet());
  h.advance(11 * MINUTE);
  await h.engine.healthCheck();
  assert(h.engine.summary().unknown === 1 && h.state.health.observation.open);
});
Deno.test("slow observation cannot starve early analysis or queued approval delivery", async () => {
  const h = harness();
  await h.put(packet("a"));
  const direct = packet("b");
  direct.snapshot.flags = ["waitingOnApproval"];
  await h.put(direct);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => entered = resolve);
  const analyze = h.engine.io.analyze;
  h.engine.io.analyze = async (...args) => {
    const result = await analyze(...args);
    entered();
    return result;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await h.engine.tick(async () => {
      await Promise.race([
        started,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("Analysis did not start before slow observation"),
              ),
            500,
          );
        }),
      ]);
      h.advance(20_000);
    }, epoch + 45_000);
  } finally {
    if (timer) clearTimeout(timer);
  }

  assert(h.calls.length === 1 && h.calls[0].at === epoch);
  assert(
    h.sent.some((s) => s.includes("Approval required")) && h.sent.length === 2,
  );
});
Deno.test("new first-sweep candidate can use spare tick time", async () => {
  const h = harness();
  await h.engine.tick(async () => {
    await h.put(packet());
  }, epoch + 45_000);
  assert(h.calls.length === 1 && h.sent.length === 1);
});
Deno.test("late analyst result cannot overwrite a new request during concurrent observation", async () => {
  const h = harness();
  await h.put(packet());
  let release!: () => void;
  let started!: () => void;
  const begun = new Promise<void>((r) => started = r);
  const gate = new Promise<void>((r) => release = r);
  const base = h.engine.io.analyze;
  h.engine.io.analyze = async (...args) => {
    const result = await base(...args);
    started();
    await gate;
    return result;
  };
  const pending = h.engine.analyzeOne();
  await begun;
  await h.put(packet("a", "I need your browser login.", 2));
  release();
  await pending;
  await h.engine.flush();
  assert(h.sent.length === 0);
  h.advance(CREDIT_MS);
  await h.put(packet("a", "I need your browser login.", 2));
  await h.engine.analyzeOne();
  await h.engine.flush();
  assert(h.sent.length === 1);
});
