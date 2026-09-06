import { Observer } from "./observe.ts";
import { directBlocker } from "./policy.ts";
import { WatchdogError } from "./engine.ts";
function assert(x: unknown, message = "Assertion failed") {
  if (!x) throw new Error(message);
}
Deno.test("failed goal field cannot hide a current approval and its error remains classified", async () => {
  const observer = new Observer("/synthetic");
  const failures: any[] = [];
  observer.onFailure = (id, f) => failures.push({ id, ...f });
  observer.call = async (method) => {
    if (method === "thread/goal/get") {
      throw new WatchdogError({ method, category: "not_found", code: 404 });
    }
    return { data: [{ id: "turn", status: "inProgress" }] };
  };
  const s = await observer.snapshot({
    id: "s",
    updatedAt: 1,
    cwd: "/test",
    status: { type: "active", activeFlags: ["waitingOnApproval"] },
  });
  assert(
    s.coverage?.goal === false && s.coverage.runtime && s.coverage.turn &&
      directBlocker(s) === "approval",
  );
  assert(
    failures[0].category === "not_found" &&
      failures[0].method === "thread/goal/get",
  );
  observer.readDue = () => false;
  await observer.snapshot({
    id: "s",
    updatedAt: 1,
    status: { type: "active" },
  });
  assert(failures.length === 1, "Backoff generated another attempted read");
});
Deno.test("discovery continuation advances while refreshing the head and names actual gaps", async () => {
  const observer = new Observer("/synthetic");
  const cursors: (string | null)[] = [];
  observer.call = async (method, params) => {
    if (method === "thread/loaded/list") return { data: [] };
    cursors.push(params.cursor);
    const cursor = params.cursor ?? "head";
    return {
      data: [{
        id: cursor,
        updatedAt: Date.now() / 1000,
        status: { type: "active" },
      }],
      nextCursor: cursor === "head" ? "p2" : cursor === "p2" ? "p3" : null,
    };
  };
  await observer.discover([], new Set());
  await observer.discover([], new Set());
  const third = await observer.discover([], new Set());
  assert(cursors.join(",") == ",,p2,,p3", JSON.stringify(cursors));
  assert(
    third.reasons.includes("historical_pages") &&
      !third.reasons.includes("known_read_failed"),
  );
});
Deno.test("discovery overflow and failed loaded IDs remain explicit uncovered sources", async () => {
  const observer = new Observer("/synthetic");
  const failures: string[] = [];
  observer.onFailure = (id) => failures.push(id);
  observer.call = async (method, params) => {
    if (method === "thread/loaded/list") {
      return { data: Array.from({ length: 135 }, (_, i) => String(i)) };
    }
    if (method === "thread/list") return { data: [], nextCursor: null };
    if (params.threadId === "0") {
      throw new WatchdogError({ method, category: "not_found" });
    }
    return {
      thread: {
        id: params.threadId,
        updatedAt: Date.now() / 1000,
        status: { type: "active" },
      },
    };
  };
  const result = await observer.discover([], new Set());
  assert(
    result.rows.length === 128 && result.reasons.includes("capacity") &&
      result.reasons.includes("known_read_failed") && failures[0] === "0",
  );
});
