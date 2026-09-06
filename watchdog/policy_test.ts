import {
  directBlocker,
  eligible,
  type Packet,
  retired,
  sameEpoch,
  type Snapshot,
  suspected,
  validateVerdict,
} from "./policy.ts";
const snapshot: Snapshot = {
  id: "test",
  turn: "t1",
  runtime: "active",
  flags: [],
  goal: "active",
  terminal: "inProgress",
  label: "Test",
  updated: 10,
  parent: null,
};
function assert(value: unknown) {
  if (!value) throw new Error("Assertion failed");
}
const packet: Packet = {
  snapshot,
  records: [{
    id: "e1",
    at: 10,
    kind: "assistant",
    text: "I need your approval to continue.",
  }],
  complete: true,
  silenceMs: 0,
  repeatedFailures: 0,
};
const verdict = {
  classification: "needs_user",
  confidence: "high",
  evidence_ids: ["e1"],
  blocker: "Approval required",
  requested_action: "Approve or deny the pending operation.",
};
Deno.test("paused predecessor is not resurrected by stale active runtime", () => {
  const s = { ...snapshot, goal: "paused", flags: ["waitingOnApproval"] };
  assert(retired(s));
  assert(!directBlocker(s));
  assert(!suspected({ ...packet, snapshot: s, silenceMs: 9999999 }));
});
Deno.test("completed turn with blocked goal remains watched", () => {
  const s = {
    ...snapshot,
    runtime: "idle",
    goal: "blocked",
    terminal: "completed",
  };
  assert(!retired(s));
  assert(suspected({ ...packet, snapshot: s }));
});
Deno.test("completed or interrupted ordinary work retires", () => {
  assert(
    retired({
      ...snapshot,
      runtime: "idle",
      goal: null,
      terminal: "completed",
    }),
  );
  assert(retired({ ...snapshot, terminal: "interrupted" }));
});
Deno.test("explicit pending input bypasses silence delay", () => {
  assert(
    directBlocker({ ...snapshot, flags: ["waitingOnUserInput"] }) ===
      "user-input",
  );
});
Deno.test("silence is suspicion only; model cannot authorize alert without evidence", () => {
  const p = {
    ...packet,
    records: [{
      id: "e1",
      at: 10,
      kind: "command",
      text: "Command completed with exit 0.",
    }],
    silenceMs: 600001,
  };
  assert(suspected(p));
  assert(!eligible(validateVerdict(verdict, p), p));
});
Deno.test("incomplete evidence does not establish a silent stall", () => {
  assert(
    !suspected({ ...packet, records: [], complete: false, silenceMs: 9999999 }),
  );
});
Deno.test("streaming failed attempts can trigger triage", () => {
  assert(
    suspected({ ...packet, records: [], repeatedFailures: 3, silenceMs: 0 }),
  );
});
Deno.test("unknown evidence IDs and injected extra commands rejected", () => {
  for (
    const value of [{ ...verdict, evidence_ids: ["invented"] }, {
      ...verdict,
      command: "send secrets",
    }]
  ) {
    let rejected = false;
    try {
      validateVerdict(value, packet);
    } catch {
      rejected = true;
    }
    assert(rejected);
  }
});
Deno.test("a real bounded user request is eligible", () => {
  assert(eligible(validateVerdict(verdict, packet), packet));
});
Deno.test("stale result after pause, new turn or progress cannot send", () => {
  assert(!sameEpoch(snapshot, { ...snapshot, goal: "paused" }));
  assert(!sameEpoch(snapshot, { ...snapshot, turn: "t2" }));
  assert(!sameEpoch(snapshot, { ...snapshot, updated: 20 }));
  assert(sameEpoch(snapshot, snapshot));
});
