import { analyze } from "./analyst.ts";
import { WatchdogError } from "./engine.ts";
Deno.test("analyst preserves model caps and distinguishes invalid output without live traffic", async () => {
  const home = await Deno.makeTempDir();
  const original = globalThis.fetch;
  let requests = 0;
  let valid = false;
  try {
    await Deno.writeTextFile(
      `${home}/config.toml`,
      'model_provider="fixture"\n[model_providers.fixture]\nwire_api="responses"\nbase_url="https://example.invalid"\n',
    );
    await Deno.writeTextFile(
      `${home}/auth.json`,
      JSON.stringify({ OPENAI_API_KEY: "synthetic-fixture-credential" }),
    );
    globalThis.fetch = async (_input, init) => {
      requests++;
      const request = JSON.parse(String(init?.body));
      if (
        request.model !== "gpt-5.6-luna" ||
        request.reasoning.effort !== "medium" ||
        request.max_output_tokens !== 2048 || request.store !== false
      ) throw new Error("Request contract changed");
      return new Response(JSON.stringify({
        status: "completed",
        model: "gpt-5.6-luna",
        output_text: valid
          ? JSON.stringify({
            classification: "needs_user",
            confidence: "high",
            evidence_ids: ["e"],
            blocker: "Approval required",
            requested_action: "Approve or deny.",
          })
          : "not JSON",
        usage: { input_tokens: 100, output_tokens: 20 },
      }));
    };
    const p = {
      snapshot: {
        id: "fixture",
        turn: "t",
        runtime: "idle",
        flags: [],
        goal: "blocked",
        terminal: "completed",
        label: "test",
        updated: 1,
        parent: null,
      },
      records: [{
        id: "e",
        at: 1,
        kind: "assistant",
        text: "I need your approval.",
      }],
      complete: true,
      silenceMs: 0,
      repeatedFailures: 0,
    };
    let rejected = false;
    try {
      await analyze(home, p);
    } catch (e) {
      rejected = e instanceof WatchdogError &&
        e.failure.category === "invalid_response";
    }
    if (!rejected) throw new Error("Invalid response lost its category");
    valid = true;
    const result = await analyze(home, p);
    if (
      requests !== 2 || result.usage?.input_tokens !== 100 ||
      result.verdict.classification !== "needs_user"
    ) throw new Error("Usage or verdict lost");
  } finally {
    globalThis.fetch = original;
    await Deno.remove(home, { recursive: true });
  }
});
