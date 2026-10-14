import { Engine, newState, NOTIFICATION_COOLDOWN } from "./engine.ts";
import { goalIdentity } from "./observe.ts";
const assert = (value: unknown) => {
  if (!value) throw new Error("assertion failed");
};
const episode = (engine: Engine, turn = "one", goalKey = "goal-one") => {
  engine.actor("actor", 1000)!.snapshot = {
    id: "actor",
    turn,
    goalKey,
    goal: "blocked",
    runtime: "idle",
    flags: [],
    terminal: "completed",
    parent: null,
    at: 1000,
    complete: true,
  };
  return engine.add("actor", turn, "blocked", `stop:${turn}:${goalKey}`, 1000)!;
};
Deno.test("successful notice survives disk restart and exact six-hour boundary", async () => {
  const e = new Engine(newState(1000)), p = episode(e);
  assert(e.canNotify(p, 1000));
  e.delivered(p, { state: "accepted", receipt: "receipt" }, 1000);
  const path = await Deno.makeTempFile({ dir: "/tmp" });
  try {
    await Deno.writeTextFile(path, JSON.stringify(e.state));
    const restored = new Engine(JSON.parse(await Deno.readTextFile(path))),
      next = episode(restored, "two");
    assert(!restored.canNotify(next, 1000 + NOTIFICATION_COOLDOWN - 1));
    assert(restored.canNotify(next, 1000 + NOTIFICATION_COOLDOWN));
  } finally {
    await Deno.remove(path);
  }
});
Deno.test("recovery and new turns cannot bypass cooldown; distinct goals can alert", () => {
  const e = new Engine(newState(1000)), p = episode(e);
  e.canNotify(p, 1000);
  e.delivered(p, { state: "accepted" }, 1000);
  e.resolve(p);
  const same = episode(e, "two");
  assert(!e.canNotify(same, 2000));
  const different = episode(e, "three", "goal-two");
  assert(e.canNotify(different, 2000));
});
Deno.test("failed and uncertain sends never advance successful cooldown and may retry", () => {
  for (const state of ["rejected", "uncertain"] as const) {
    const e = new Engine(newState(1000)), p = episode(e);
    e.canNotify(p, 1000);
    e.delivered(p, { state, retryAt: 2000 }, 1000);
    assert(
      p.sentAt === undefined &&
        Object.keys(e.state.successfulNotices!).length === 0,
    );
    assert(e.canNotify(p, 2000));
    e.delivered(p, { state: "accepted" }, 2000);
    e.delivered(p, { state, retryAt: 3000 }, 2500);
    assert(p.sentAt === 2000 && !e.canNotify(p, 3000));
  }
});
Deno.test("legacy accepted timestamps migrate and remain through transient recovery", () => {
  const e = new Engine(newState(1000)), p = episode(e);
  delete e.state.actors.actor.snapshot!.goalKey;
  p.delivery = "accepted";
  p.sentAt = 1000;
  delete e.state.successfulNotices;
  const restored = new Engine(JSON.parse(JSON.stringify(e.state)));
  const next = episode(restored, "two");
  assert(!restored.canNotify(next, 2000));
  restored.resolve(next);
  assert(!restored.canNotify(episode(restored, "three"), 3000));
  assert(restored.canNotify(episode(restored, "four", "new-goal"), 3000));
  const restarted = new Engine(JSON.parse(JSON.stringify(restored.state)));
  assert(restarted.canNotify(episode(restarted, "five", "new-goal"), 4000));
});

Deno.test("missing goal metadata uses the conservative thread cooldown", () => {
  const e = new Engine(newState(1000)), p = episode(e);
  e.canNotify(p, 1000);
  e.delivered(p, { state: "accepted" }, 1000);
  const next = episode(e, "two");
  delete e.state.actors.actor.snapshot!.goalKey;
  assert(!e.canNotify(next, 2000));
});
Deno.test("goal identity ignores status, updated time, title and turn; new goal stays distinct", async () => {
  const first = { objective: "same work", createdAt: 1000, status: "blocked" };
  assert(
    await goalIdentity(first) ===
      await goalIdentity({
        ...first,
        objective: "new wording",
        status: "active",
        updatedAt: 3000,
        title: "changed",
        turn: "new",
      }),
  );
  assert(
    await goalIdentity(first) !==
      await goalIdentity({ ...first, createdAt: 2000 }),
  );
  assert(
    await goalIdentity({ id: "one" }) !== await goalIdentity({ id: "two" }),
  );
});
Deno.test("live three-day unresolved episode expiry is preserved without erasing recent cooldown", () => {
  const e = new Engine(newState(1000)), p = episode(e);
  e.canNotify(p, 3 * 86400000);
  e.delivered(p, { state: "accepted" }, 3 * 86400000);
  e.compact(3 * 86400000 + 2000);
  assert(p.disposition === "expired");
  assert(!e.canNotify(episode(e, "two"), 3 * 86400000 + 3000));
});
