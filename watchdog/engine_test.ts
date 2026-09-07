import { Engine, newState } from "./engine.ts";
import { capture, type Snapshot } from "./policy.ts";
import { digest } from "./main.ts";
const assert = (x: unknown, m = "assertion failed") => {
  if (!x) throw new Error(m);
};
const snap = (at: number, extra: Partial<Snapshot> = {}): Snapshot => ({
  id: "actor",
  turn: "turn",
  runtime: "idle",
  flags: [],
  terminal: "completed",
  goal: null,
  parent: null,
  at,
  complete: true,
  ...extra,
});
const event = (kind: string, at: number, extra: Record<string, unknown> = {}) =>
  capture({
    session_id: "actor",
    turn_id: "turn",
    hook_event_name: kind,
    ...extra,
  }, at);
Deno.test("stop deadline is independent of AI and idle no-goal is not discarded", () => {
  const e = new Engine(newState(1000));
  e.ingest(event("Stop", 1000));
  e.observe(snap(2000), 2000);
  assert(e.eligible(45999).length === 0);
  assert(e.eligible(46000).length === 1);
});
Deno.test("goal completion evidence suppresses a stop but not pending input", () => {
  const e = new Engine(newState(1000));
  e.ingest(event("Stop", 1000));
  e.observe(
    snap(4000, { goal: "complete", flags: ["waitingOnUserInput"] }),
    4000,
  );
  const p = e.eligible(6000);
  assert(p.length === 1 && p[0].kind === "input");
});
Deno.test("continuation and explicit interruption suppress old stops", () => {
  for (const kind of ["UserPromptSubmit", "Interrupt"]) {
    const e = new Engine(newState(1000));
    e.ingest(event("Stop", 1000));
    e.ingest(event(kind, 2000));
    assert(!e.eligible(60000).length);
  }
  const e = new Engine(newState(1000));
  e.ingest(event("Stop", 1000));
  e.observe(snap(8000, { terminal: "inProgress", runtime: "active" }), 8000);
  assert(!e.eligible(60000).length);
});
Deno.test("duplicate and late events do not reopen an already handled stop", () => {
  const e = new Engine(newState(1000));
  const stop = event("Stop", 1000);
  e.ingest(stop);
  e.ingest(stop);
  assert(Object.keys(e.state.episodes).length === 1);
  e.ingest(event("UserPromptSubmit", 9000));
  e.ingest(event("Stop", 5000));
  assert(!e.eligible(60000).length);
});
Deno.test("approval is revalidated and resolved before send", () => {
  const e = new Engine(newState(1000));
  e.ingest(event("PermissionRequest", 1000));
  e.observe(
    snap(2000, {
      runtime: "active",
      terminal: "inProgress",
      flags: ["waitingOnApproval"],
    }),
    2000,
  );
  assert(e.eligible(3000).length === 1);
  e.observe(snap(4000, { runtime: "active", terminal: "inProgress" }), 4000);
  assert(!e.eligible(5000).length);
});
Deno.test("unreadable approval gets uncertainty eligibility at 15 seconds", () => {
  const e = new Engine(newState(1000));
  e.ingest(event("PermissionRequest", 1000));
  e.failed("actor", 4000);
  assert(!e.eligible(15999).length);
  assert(e.eligible(16000).length === 1);
});
Deno.test("child handoffs stay quiet and a child input condition still alerts", () => {
  const e = new Engine(newState(1000));
  e.ingest(event("SubagentStart", 1000, { agent_id: "child" }));
  e.ingest(event("SubagentStop", 2000, { agent_id: "child" }));
  e.ingest(event("Stop", 3000, { session_id: "child" }));
  assert(!e.eligible(60000).length);
  e.observe(
    snap(60000, {
      id: "child",
      parent: "actor",
      runtime: "active",
      terminal: "inProgress",
      flags: ["waitingOnUserInput"],
    }),
    60000,
  );
  assert(e.eligible(62000).length === 1);
});
Deno.test("same-turn distinct request identities survive async return and continued work", () => {
  const e = new Engine(newState(1000));
  for (const id of ["r1", "r2"]) {
    e.ingest(
      event("PreToolUse", 1000, {
        tool_name: "request_user_input_async",
        tool_use_id: id,
      }),
    );
    e.ingest(
      event("PostToolUse", 2000, {
        tool_name: "request_user_input_async",
        tool_use_id: id,
      }),
    );
  }
  e.observe(snap(20000, { runtime: "active", terminal: "inProgress" }), 20000);
  assert(e.eligible(20000).length === 2);
});
Deno.test("accepted and uncertain deliveries are not blindly repeated", () => {
  for (const delivery of ["accepted", "uncertain"] as const) {
    const e = new Engine(newState(1000));
    e.ingest(event("Stop", 1000));
    const p = e.eligible(46000)[0];
    p.delivery = delivery;
    p.sentAt = 46000;
    const restored = new Engine(JSON.parse(JSON.stringify(e.state)));
    assert(!restored.eligible(47000).length);
  }
});
Deno.test("100 simultaneous blockers fit a private digest with collision-safe IDs", () => {
  const e = new Engine(newState(1000));
  for (let i = 0; i < 100; i++) {
    e.ingest(
      event("Stop", 1000, {
        session_id: `sameprefix-${String(i).padStart(3, "0")}`,
      }),
    );
  }
  const batch = digest(e.eligible(46000), "Mac", 46000, "notice");
  assert(batch.included.length === 100);
  assert(new TextEncoder().encode(batch.body).length <= 3072);
  assert(batch.body.includes("sameprefix-000"));
  assert(!batch.body.includes("secret"));
});
Deno.test("fake-time 24-hour operation does not expire with an inference allowance", () => {
  const e = new Engine(newState(1000));
  for (let hour = 0; hour < 25; hour++) {
    const now = 1000 + hour * 3600000;
    e.ingest(event("Stop", now, { turn_id: `turn-${hour}` }));
    assert(e.eligible(now + 45000).length > 0);
    for (const p of e.eligible(now + 45000)) {
      p.delivery = "accepted";
      p.sentAt = now + 45000;
    }
    e.compact(now);
  }
  assert(e.state.posts.length === 0);
});
Deno.test("healthy long work and historical idle discovery do not alert", () => {
  const e = new Engine(newState(1000));
  e.observe(snap(1000), 1000);
  e.observe(
    snap(2000, { id: "working", terminal: "inProgress", runtime: "active" }),
    2000,
  );
  assert(!e.eligible(86400000).length);
});
Deno.test("capture excludes command text, payloads, paths, and final prose", () => {
  const e = event("Stop", 1000, {
    last_assistant_message: "secret",
    tool_input: { command: "secret" },
    cwd: "/private",
    transcript_path: "/private",
  });
  assert(!JSON.stringify(e).includes("secret"));
  assert(!JSON.stringify(e).includes("private"));
});
