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

The review disposition and final validation are recorded below; merge identity is available from the pull request history.

## Review correction and real expiry

Round 1 reviewed `ef728831ec952ab2a23b0557e40e0d925c416963` against `main`
with `codex review --base main` and exited successfully with one P1 and two P2
findings. The correction starts inference before slow observation, overlaps it
with read-only scans using serialized state writes, caps observation work at
30 seconds of the 45-second tick, and services the outbox before and after
observation. It also clears prior-turn gaps at a verified current-turn boundary
and reports stale complete evidence as lost coverage. A separate local probe
proved that an incomplete scan could resolve a queued alert; the correction
preserves the episode and queued alert until complete evidence returns.

There are now 49 focused tests, including the shared runtime tick's slow-scan
regression, concurrent stale-result handling, incomplete-scan recovery, and a
synthetic provider adapter test for model/cap/usage and invalid-response handling.
Formatting and type checks pass.

A real 12-second run at 15:00:26 UTC discovered 30 sessions, tracked nine, made
zero model calls, and expired at 15:00:38 UTC. ntfy accepted its final summary
with receipt `Nwsk3cmE6cSS`. It reported one covered and eight unknown sessions;
that partial coverage is a real limitation, not a green claim. This run tested
the pre-correction candidate; the scheduling correction has focused replay and
runtime regression coverage and will receive a final short live expiry check.


Round 2 reviewed `226c9d1` against `main` and exited successfully with a P1
finding: an unsent canceled alert could not be queued again under the same
request key. The correction permits reuse only when the prior alert was
canceled before any dispatch attempt. Accepted and uncertain sends remain
deduplicated. Root-session burst tests also prove one bounded POST can retain
two child identities and exclude a stale member. All 53 tests now pass.

The corrected real expiry run at 15:15:36 UTC discovered 29 sessions, tracked
five, made zero model calls, and expired at 15:15:48 UTC. ntfy accepted its
summary with receipt `GoIlnp3h5Y5V`. That run validates the scheduling correction;
the later queue/dedup correction has focused fake-transport regression tests.


## Final bounded review disposition

Round 3 reviewed `915122e` against `main` and exited successfully with one P1
and one P2 finding. The P1 is tracked in issue #2. The final correction caps
discovery work at ten seconds, reserves observation time for evidence by ending
status reads at twenty seconds, retains a due sweep when no packet was read,
and exits before sleeping if shutdown is already requested. Notification
delivery follows observation within the existing 45-second tick deadline;
inference still overlaps read-only observation.

All 55 tests pass. New credential-free subprocess reproductions import the
actual CLI entry point: twelve synthetic sessions with 2.8-second virtual
snapshots now produce evidence and candidates, and a signal during discovery
schedules no minute sleep and preserves the signal stop reason. Type and format
checks pass. No fourth Codex review was run; the last correction is verified by
focused primary-agent regressions rather than a new independent review verdict.

No P0/P1 finding is knowingly left unresolved. Issue #2 is closed by the V2 PR
when merged. This remains a bounded local watchdog, with the coverage and
external-death limitations described above; it is not a production-readiness
claim or a claim that the separate GPT Pro research returned successfully.


## Release runtime receipt

Code candidate `179acdb` ran against the real local daemon from
`2026-09-06T15:39:26.075Z` through `2026-09-06T15:39:38.089Z`, exited naturally
with reason `expired`, and made zero model calls. ntfy accepted the final summary
with receipt `257dY73EyE7x`. This verifies the final observation and
shutdown correction through the live runtime; the earlier Luna smoke remains
the cached provider proof. PR #3 contains the change and closes issue #2.
GitHub reports no configured CI/deployment checks for this PR.
