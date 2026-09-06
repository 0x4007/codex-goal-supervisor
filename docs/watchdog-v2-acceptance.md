# Watchdog V2 acceptance

Implementation lane: `codex/watchdog-design-v2-2026-09-06-g0c4111d654`.
Base: `296ae7f4279a4b1b8cf213ee3d474e13ba5858d1`.
The Python recovery service is unchanged. The watchdog uses read operations only.

## Incident evidence

The September 5–6 run began at 23:28:13 EDT and expired at 05:28:13 EDT.
Persisted state recorded 12 model attempts and 361 ticks. Its final analysis
was at 01:33:10 EDT. After that: 236 scans, zero further model calls or watchdog
pushes, and 61 session-read failures across three unknown IDs. ntfy separately
retained a direct Prospector notification at 03:36:53 EDT. These facts prove
loss of ambiguous triage; they do not prove a specific missed user alert or
phone receipt. One separate setup model call is outside the run's 12.

## Runtime and replay proof

The V2 live smoke on September 6 at 14:42 UTC discovered 28 real daemon sessions,
classified the synthetic request with `gpt-5.6-luna` / medium, and received ntfy
service receipt `T4gf6ry9vTDh`. Returned provider usage was 250 input and 105 output
tokens. The process completed in approximately 3.7 seconds. This is service
acceptance, not proof of iOS display or reading. The smoke starts no six-hour run.
The private local receipt log is `/tmp/watchdog-v2-live-smoke.log`.

The six-hour virtual-time replay feeds explicit changing synthetic candidates
to the same Engine used by the CLI. It verifies 24 maximum charged attempts,
15-minute spacing, and useful analysis opportunities in the final hour. It
makes no claim about candidate contents missing from the historical logs.

Focused tests cover partial field reads, a valid approval with an unreadable
goal, unknown IDs, discovery paging/overflow, evidence fairness beyond sixteen
tails, same-turn distinct requests, re-entered requests after a user reply,
unchanged status commands, current-turn and oversized-record boundaries,
recoverable provider failures, authentication disable/restart, 61 source errors,
health recurrence/coalescing, stale outbox work, uncertain dispatch, definite
rate-limit backoff, transport pacing, state cutover, deadline reservation, and
unmodified expiry across restart. Runtime subprocess tests use a credential-free
home and fake Unix WebSocket daemon; they establish lock exclusion and natural
expiry without model or ntfy traffic. Test fixtures are small and fake-time
replays complete in milliseconds; no hours-long synthetic test is used.

## Limits and review status

Only the local daemon namespace is observed; independent VPS workers need
supervisor evidence. Missing semantic context remains unknown, even if a file
has been quiet for ten minutes. Monitoring-health bursts coalesce locally;
independent agent-originated ntfy messages do not share this episode ledger.
A killed/offline watchdog cannot reliably report its own death. Scheduled
expiry attempts a summary but cannot guarantee network or phone delivery.

The requested GPT Pro design review remains pending: existing job
`3148d6f6-87d9-4d9b-883f-4f1829deb7ce` repeatedly returned HTTP 429 during result
retrieval, including after a cooldown. It was not resubmitted. This implementation
follows the saved local V2 plan and does not claim a returned Pro verdict.

Final check, review, and merge evidence will be recorded here after validation.
