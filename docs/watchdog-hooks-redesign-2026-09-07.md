# V2 hook-based attention notifications

V2 runs deterministic checks in response to Codex lifecycle hooks. It makes no
model calls, discovers no sessions, and does not scan historical transcripts or
periodically read loaded sessions. V1 scanner code and its migration path are
removed; Git history retains the prior implementation.

## Canonical source

Repository: `/Users/nv/repos/0x4007/codex-goal-supervisor`.
Canonical worktree: `/Users/nv/repos/0x4007/codex-goal-supervisor/.codex-worktrees/watchdog-hooks-redesign-2026-09-07-g79aa93690b`.
Canonical branch: `codex/watchdog-hooks-redesign-2026-09-07-g79aa93690b`.
Source: `watchdog/`. The Python 5xx recovery supervisor and managed-session
harness are separate tools, not V1 notification code.

## Runtime

1. Eight trusted lifecycle hooks run the metadata-only `hook.ts` enqueuer.
2. The consumer drains the bounded local spool and records the affected actor
   and attention episode. This local queue loop does not discover sessions.
3. Attention-bearing hooks and pending notification deadlines trigger bounded,
   read-only checks of the affected session through the existing Codex socket.
4. Eligible notifications use fixed templates and the existing ntfy topic.
   Delivery receipts and deduplication records persist across consumer restarts.

Ordinary root stops have a 45-second continuation grace. Approval signals use
runtime flags where available, with an explicit unverified notice if current
state cannot be read. Urgent revalidation has a three-second budget and at most
four concurrent RPC calls. Unverified reminders do not consume their allowance.
Delivery pacing, retry deadlines, and a single reminder for a still-pending
condition operate only on existing episodes. These deadlines do not discover
additional sessions. `--once` drains hooks and awaits eligible dispatch.

## Installation and limits

The installer prepares an immutable runtime, hook definitions, and a Mac
LaunchAgent or Linux systemd user service. Hook changes require normal Codex
`/hooks` review on each host. Do not restart the shared Codex daemon.

A missing hook can mean a missed condition: there is no periodic reconciliation
fallback. Existing sessions become covered when they emit a trusted hook.
Optional async input without a corresponding installed hook/runtime flag,
opaque hangs, sleeping hosts, and external host-death detection are not covered.
An ordinary completed turn can produce a generic review notice because no model
infers completion. The HTTPS click URL opens ChatGPT, not a verified session link.

See [README](../README.md#hook-driven-attention-monitor-v2) for commands and
[acceptance evidence](watchdog-hooks-acceptance-2026-09-07.md) for verification.
