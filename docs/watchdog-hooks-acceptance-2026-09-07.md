# V2 hook notification evidence

V2 is the deterministic hook-based implementation in `watchdog/`. V1 scanner
code and its migration path are removed. The separate Python recovery service
is not part of the notification implementation.

## Verified delivery baseline

PR #8 (`f1d134b8ff5d1f057a9fa4e9b9d9529ace3db89f`) fixed one-shot shutdown,
slow-RPC dispatch, and resolved-episode capacity defects. Twenty tests passed in
actual Mac execution, recorded outside Git with reference:
`b82be93c6686276c58f7b90860a52f1ce7ac1d437a1d2c7156203e3f9c6261d7/f8919690-e6bf-4303-982d-d4b58e0f8853`.

The same runtime was installed on Mac and VPS, with eight active hooks on each
host after normal TUI trust review. Actual Stop events produced ntfy receipts:

| Host | Receipt | Stop-to-acceptance |
| --- | --- | --- |
| Mac | `2jyr741IWJ8Y` | 45.634 seconds |
| VPS | `WmciStLZ8WyK` | 45.112 seconds |

Both consumers retained receipts across restart, with one send attempt and zero
capture losses. Host-local records are under
`~/.codex/attention-watchdog/installed-repair-acceptance-2026-09-07.json`.
This baseline predates removal of the periodic fallback; new source needs fresh
verification and installation.

## Coverage limits

A missing hook can mean a missed alert. V2 does not discover loaded sessions or
periodically check sessions. Hook events and pending notification deadlines are
the only sources of session reads. Optional async input-tool mapping, opaque
hangs, sleeping hosts, and external host-death alerts remain uncovered.

Ordinary completed turns can produce a generic review notice. Phone display
and exact-session navigation remain unconfirmed. Hook-process burst latency
exceeds the original design target; the tests report this without treating it
as a delivery failure. No model calls are used for notification decisions.

## V1 removal verification

Fresh Mac execution after removing discovery: 20 passed, zero failed.
`b82be93c6686276c58f7b90860a52f1ce7ac1d437a1d2c7156203e3f9c6261d7/698c9fb9-0b06-4b80-9572-d7b30868b817`.
Final frozen dependency/type check after removing the unused V1 TOML parser:
`b82be93c6686276c58f7b90860a52f1ce7ac1d437a1d2c7156203e3f9c6261d7/f2332b2f-e7ae-402a-a0ff-29c5e4afd6c4`.
Both are actual executions on the canonical worktree, not cached results.

Local `codex review --uncommitted` completed with two P2 reminder findings:
a missing initial snapshot prevents recovery, and four repeatedly unreadable
actors can starve later reminder checks. They are tracked in the removal PR;
they are not fixed or verified. The review reproduced both cases with evidence
`b82be93c6686276c58f7b90860a52f1ce7ac1d437a1d2c7156203e3f9c6261d7/29a9e4c7-f84b-4669-bcce-778a487f1689`.
The final dependency-only removal was type-checked after review.
