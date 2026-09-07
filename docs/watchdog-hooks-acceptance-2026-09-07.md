# Hook-driven attention prototype acceptance

This is the deterministic first slice of the September 7 hook design. It replaces
the historical timer scanner and removes its model-backed analyst. Optional model
triage, the full design timing matrix and remote deployment are not claimed.

Canonical branch: `codex/watchdog-hooks-redesign-2026-09-07-g79aa93690b`.
Canonical worktree: `/Users/nv/repos/0x4007/codex-goal-supervisor/.codex-worktrees/watchdog-hooks-redesign-2026-09-07-g79aa93690b`.
Base: `58c59e7957dce8b617fa65a866c99094ef7b94ed`.
Mac runtime: `~/.codex/attention-watchdog/`, job `com.nv.codex-attention`.

## Real acceptance evidence

- Codex CLI 0.153.4 showed eight installed and eight active lifecycle hooks after
  normal `/hooks` trust review. No trust hashes were written by the installer.
- Real TUI test session: `01a07dda-daab-72f0-a5ca-e0677bf82cbe`.
- Real test turn: `01a07ddc-311b-7f50-9d54-8e812eedd2c2`.
- Stop captured at `2026-09-07T21:53:02.829Z`; event ID
  `3fb851b4-edf8-4669-8697-769c037ee0a7`.
- ntfy receipt `qiI6FvssU4uH`, accepted at approximately
  `2026-09-07T21:53:48.281Z`: 45.452 seconds after Stop.
- Source payload hash of this first runtime:
  `7759b2ca41fdd44e13da9be5d89756b6d52c594c4ed6c565b2178e08a47b7102`.
  Later source edits require a replacement installed hash and focused validation.
- At 21:54 UTC the real consumer reported 20 actors, four hook-observed and 16
  snapshot-only, zero capture losses, one accepted notice, and zero model calls.
- Phone display and exact-session navigation are awaiting the user's answer.

## Test evidence

Host: Mac. Results are stored outside Git using the installed evidence tool.

- First execution (13 passed, 2 failed):
  `b82be93c6686276c58f7b90860a52f1ce7ac1d437a1d2c7156203e3f9c6261d7/3e9d0101-5e23-463b-bdb8-0a944808241e`.
  Actual hook launch exposed missing read permission for atomic rename. Fixed.
- Fresh corrected execution (15 passed):
  `b82be93c6686276c58f7b90860a52f1ce7ac1d437a1d2c7156203e3f9c6261d7/fa5c12c5-6a5b-4bbc-8920-bd1fb0a6d7dd`.
  Actual 100-process burst p95 535.212 ms, p99 537.863 ms. Capture passed;
  the design targets of p95 <50 ms and p99 <200 ms did not pass.
- Runtime startup exposed WS environment reads and write permission required
  by Deno for connecting to the existing Unix socket. Installer permissions
  were corrected; the shared daemon was not restarted.

## Remaining prototype limits

- Hook-specific async/synchronous input-tool mappings have not been proved, so
  broad tool hooks are not installed. Runtime pending-input flags are supported;
  optional async questions without those flags remain a coverage gap.
- Completion inference is intentionally absent. Ambiguous ordinary root stops
  can produce a generic review notice; no model is needed for delivery.
- Health is exposed in local status; independent external host-death alerts and
  the full design's coalesced coverage-loss pushes are not implemented.
- The burst launch-latency target failed. Large degraded-RPC burst latency and
  seven-day capacity recovery have not been accepted on a live host.
- Claims left by failed writers are retained and counted; automated abandoned
  claim recovery is deferred to avoid deleting possibly live capture work.
- Remote workers and sleeping/offline Mac operation are not covered. Existing
  sessions need a new observed hook event to prove their refreshed configuration.

## Final source validation and review

Fresh focused result after connection-order and pre-dispatch cancellation fixes:
`b82be93c6686276c58f7b90860a52f1ce7ac1d437a1d2c7156203e3f9c6261d7/cb0fad15-e0b4-4fa2-90c2-0e95a3c3149a`.
All 15 tests passed. This is actual execution, not a cached result.

The watchdog-only LaunchAgent was unloaded; PID 42313 exited and the stopped
record was persisted. Restart retained receipt `qiI6FvssU4uH` as accepted with
one attempt. No duplicate test delivery appeared after restart.

Local review: `codex review --uncommitted`, exit 0, September 7 at 21:58 UTC.
Log: `~/.codex/attention-watchdog/hooks-review-2026-09-07.log`.
Three P2 findings were substantiated: one-shot shutdown ordering, delayed batch
revalidation under degraded RPC, and resolved-episode capacity pressure. Under
the configured review policy, P2-only findings are tracked instead of starting
a correction round. These are unresolved prototype defects, not passed gates.
