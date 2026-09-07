# Watchdog driven by Codex lifecycle hooks

Status: the deterministic hook-driven prototype is implemented; see watchdog-hooks-acceptance-2026-09-07.md for current evidence and unresolved limits. The broader design below remains the target; optional model triage and the full acceptance matrix are not yet implemented.

## User outcome

The primary user runs tens of agents concurrently for many hours, leaves the
computer, and intervenes through Codex sessions on their phone. Notify them
promptly when input is needed or work has stopped unexpectedly. Routine
completion, healthy waiting, and internal subagent handoffs should not flood
the phone. TUI is the acceptance surface; desktop GUI support is not required.

## Canonical implementation lane (planned)

- Canonical plan: `/Users/nv/repos/0x4007/codex-goal-supervisor/docs/watchdog-hooks-redesign-2026-09-07.md`.
- Goal ID: SHA-256 of that resolved plan path, suffix `g79aa93690b`.
- Goal slug: `watchdog-hooks-redesign-2026-09-07`.
- Worktree name: `watchdog-hooks-redesign-2026-09-07-g79aa93690b`.
- Worktree: `/Users/nv/repos/0x4007/codex-goal-supervisor/.codex-worktrees/watchdog-hooks-redesign-2026-09-07-g79aa93690b`.
- Branch: `codex/watchdog-hooks-redesign-2026-09-07-g79aa93690b`.
- Base: `main` at `58c59e7957dce8b617fa65a866c99094ef7b94ed`.
- Lane state: planned; not created during research. One implementation writer
  owns the watchdog changes and Mac installer. No modular delegation is needed.
- Preserve this plan path and lane identity across continuation. The existing
  V2 lane is unrelated to the new implementation ownership.

## Research authorization and continuation

- User explicitly invoked `$gpt-pro` to redesign this watchdog around hooks.
- Authorized new submissions: one. Used: one. No additional submissions authorized.
- Model: `gpt-6-pro`.
- Job: `21630cb3-8086-40e6-a28d-8be745eb6c97`, submitted 2026-09-07 03:57 UTC.
- Prompt: `/tmp/watchdog-hooks-pro-request-2026-09-07.txt`.
- Review completed at 2026-09-07 04:15:51 UTC. Retrieval exited successfully.
  The answer is cached under the same job ID; a convenience copy is at
  `/tmp/watchdog-hooks-pro-result-2026-09-07.md`.
- This plan incorporates the technical review; unrelated appended language-learning
  content was excluded. The raw answer is not the implementation authority.
- Resume the same job if interrupted; never resubmit on timeout or HTTP 429.
- Prior V2 review `3148d6f6-87d9-4d9b-883f-4f1829deb7ce` is now complete
  and was read from its cache. Its former pending status in V2 acceptance
  documentation is historical. Preserve its useful incident and delivery
  accounting recommendations; the new user outcome supersedes six-hour polling
  assumptions.

## Verified current state

- Repository: `/Users/nv/repos/0x4007/codex-goal-supervisor`.
- Base branch: `main`; base SHA: `58c59e7957dce8b617fa65a866c99094ef7b94ed`.
- Repository was clean at the start of this design. This document is the only
  intended repository change during planning.
- Existing V2 worktree is already at that same merged SHA. Do not repurpose it.
- Current implementation: `watchdog/main.ts`, `engine.ts`, `observe.ts`,
  `policy.ts`, and `analyst.ts`, plus focused tests.
- V2 polls each minute, schedules evidence each five minutes, and permits one
  analysis per fifteen minutes. Its default six-hour process expiry is separate
  from per-request inference limits. Neither latency nor expiry fits unattended
  monitoring of many concurrent sessions.
- `main.ts` currently implements ntfy receipt handling directly. The separate
  `~/.local/bin/codex-nudge` helper also publishes to the existing topic; do not
  assume it supplies the watchdog's transport or shared deduplication.
- The Python 5xx recovery supervisor is separate and must remain unchanged.
- Local probe: `~/.codex/hooks.json` and
  `~/.codex/attention-watchdog/hook-probe/record.ts`.
- Codex CLI 0.153.4 TUI loaded and trusted both probe hooks through normal review.
  Persisted trust was checked. Session
  `01a079fd-955e-7191-9654-13138c09e445`, turn
  `01a079fd-f0c1-75c2-9534-71fb5ce54313`, emitted real `PostToolUse`
  at 03:51:25.117 UTC and `Stop` at 03:51:27.886 UTC on September 7.
- Probe records metadata only, has no network/model permissions, and returns
  `{}`. It is not connected to analysis or notification delivery. Its unbounded
  file-per-event storage is a probe, not the production event contract.
- A read-only count at 04:06 UTC found 215 real probe events across six sessions
  (211 PostToolUse, four Stop). This proves capture beyond the isolated TUI smoke,
  not complete coverage of every active session or automatic refresh semantics.
- Two corresponding trust hashes are saved in the user's existing
  `config.toml`. Do not copy these hashes for changed definitions or modify
  trust state manually. Existing empty inline hook tables coexist with the probe;
  matching definitions from different sources merge rather than replace.

## Source facts and boundaries

Official documentation fetched September 7, 2026:

1. <https://learn.chatgpt.com/docs/hooks>
2. <https://learn.chatgpt.com/docs/app-server>
3. <https://docs.ntfy.sh/publish/>
4. <https://docs.ntfy.sh/known-issues/>
5. <https://docs.ntfy.sh/subscribe/api/>
6. <https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html>

Codex supports lifecycle command hooks from user/project config and plugins.
New or changed non-managed hook definitions require review and trust. Matching
commands can run concurrently. Hooks are runtime-triggered at supported events;
this does not establish exactly-once event delivery or crash coverage.

Common hook input includes session ID, nullable transcript path, cwd, and event
name. Relevant events include turn ID. Subagent hooks identify the parent in
`session_id` and the child in `agent_id`; do not collapse those identities.
Stop events include the latest assistant message and `stop_hook_active`.

`PermissionRequest` is before approval resolution and may be handled by another
hook. It is a hint to reconcile, not proof the user is still needed. Local tool
hooks cover many function tools, shell, and MCP; hosted tools and some special
paths are excluded. Async questions must be probed explicitly.

`Stop` is not proof of blockage. `SessionEnd` is not goal completion. User
interruption is not a failure. A quiet hook stream is not proof of no progress.
Long-running unified exec commands can report `PostToolUse` later through a
`write_stdin` completion; repeated polls are not distinct successful attempts.

Background hooks have eight slots per session, can finish out of order, and
are canceled when the session ends. Prefer a short synchronous local enqueue
over network/model work inside a hook. Return no approval or continuation
decision. `Stop` output must be valid JSON; use `{}`.

App-server `thread/read` does not resume or subscribe to a thread. Documented
event subscriptions follow start/resume; do not resume a user's thread merely
to observe it. Verify passive event availability before using it as a required
input. Existing runtime flags can support bounded non-resuming reconciliation.

ntfy documents a click URL, receipt IDs, priority, scheduled messages and
sequence IDs. These do not establish iPhone display, reading, or a working
session-specific Codex link. Retain the tested generic ChatGPT URL and session
identity until a real mobile route is verified.

The published anonymous ntfy.sh daily allowance is 250 messages. Minute-by-minute
remote heartbeat replacement would make 1,440 writes per day per host. Do not
adopt that design without verifying applicable accounting and capacity. A
documented scheduled-message dead-man switch is a possible later option, not
an already accepted service guarantee.

## Chosen architecture

Hooks enqueue small local events. A host-local consumer durably tracks request
episodes and pushes verified input requests promptly. It uses targeted
read-only reconciliation, not global transcript scans, for freshness. A cheap
independent timer covers missed events, terminal failures, and monitoring loss.

Notification eligibility and deadlines must not depend on Luna availability.
Optional analysis can improve an ambiguous alert's wording or classify a stop,
but a bounded unresolved-stop notice must remain available without inference.
Describe that notice as uncertainty, not a confirmed need for credentials or
an invented root cause. Keep observation, analysis, and delivery health separate.

User scope correction at 03:59 UTC: start with Mac; the existing automatic sync
system is expected to distribute the setup. Mac is the only required deployment
and acceptance host. Keep commands portable and compatible with existing sync,
but do not add remote installation work. File sync is not evidence of hook
loading, trust, a running consumer, or notification delivery on another host.
A Mac-only monitor cannot watch an independent VPS worker merely because its
thread is accessible on the phone. Mark remote coverage unverified until a real
event and transport receipt are obtained on that host.

The contracts below are the final design decisions. Timing values are engineering
targets for an awake Mac with available source data and healthy transport, not
guarantees that a phone displays a message.

## Scope and safety constraints

- No automatic session recovery in this component. No Stop continuation,
  approval decisions, input rewriting, injected context, or tool interception.
- The process must not stop watching because its model budget expired. Service
  lifetime and model allowance are independent.
- Structured pending input bypasses model analysis. Model outage or a long queue
  must not block an honest generic attention notice.
- Suppress a normal final answer only with adequate completion evidence. Some
  generic completion-review notices are expected when analysis is unavailable.
  Unexpected inactivity must have a previously observed active work state or
  unresolved request, not just an old
  transcript with a question in it.
- An optional async question can need a reply while the agent continues working.
  Label it as an input request; do not falsely describe the whole agent as stuck.
- Use complete event/request identities when available. Repeated wording is not
  a new request; two distinct requests in one turn are not one request.
- No arbitrary transcript text, command, credential, URL, or project path in a
  push. Prefer fixed templates with a local host alias and session ID.
  Detailed content stays in the existing Codex session accessible from the phone.
- The user has authorized a redesign, not new paid notification infrastructure
  or a new externally hosted status dashboard. No need to add either to prove
  the Mac-first slice.

### Distribution finding

Live read of `/Users/nv/repos/sync-dotfiles-resolved.sh` on September 7 found
the managed list `.profile`, `.bashrc`, `.bash/.functions`, `.bash/.keys`,
`.codex/AGENTS.md`, and `.codex/agents/*`. It does not currently include
`hooks.json`, the local hook probe, or a watchdog LaunchAgent. Do not put
executable payloads in the documentation tree merely to force distribution.
Repository sync may distribute source; it does not install runtime config.
Updating the sync manifest and verifying remote acceptance remain a separate
follow-up after Mac proof. No remote coverage is part of this plan's completion.

## Event capture and durable state

Install one canonical enqueuer for SessionStart, SessionEnd, UserPromptSubmit,
PermissionRequest, Stop, Interrupt, SubagentStart, and SubagentStop. Add narrowly
matched PreToolUse/PostToolUse only for user-input tool paths proved on the
installed release. Remove the probe's general PostToolUse hook during cutover.
Do not install general tool-activity or compaction hooks as heartbeats. This
limits process overhead and avoids mistaking activity for progress.

The hook reads bounded stdin, whitelists fields, writes locally, returns `{}`,
and never supplies a control decision. Default timeout: one second; measure
end-to-end p95 below 50 ms and p99 below 200 ms on the target Mac. Benchmark 100
concurrent real enqueuer launches. If that fails, reduce capture work or address
measured launch cost; do not claim success from a fake-time benchmark.

Use a bounded file spool with 4,096 claimable slots and an 8 KiB maximum event.
Payload capacity is 32 MiB plus filesystem overhead. Claim slots exclusively,
publish atomically, and release only after reducer state is committed. Include
claim ownership so crash recovery cannot delete a live writer's claim. Bound
claim attempts; never scan unbounded history or wait indefinitely inside Codex.
The consumer drains within one second and replays idempotently after restart.

On capture failure, record a bounded loss marker if possible and return without
controlling the agent. Report failures locally without raw payloads. Full spool
preserves unprocessed events rather than overwriting approvals/stops. Disk-full
may prevent even a marker; runtime reconciliation remains necessary. This is
bounded best-effort capture, not an exactly-once delivery guarantee.

Event fields:

- Schema/event ID, locally observed time, hook and installed version, local host
  identity, and configuration namespace. Do not add environment variables.
- Raw hook session ID, separately resolved navigation/thread ID, optional child
  ID and verified parent relationship, turn ID, and available genuine request or
  source occurrence IDs. Missing identity remains explicit.
- Hook kind, bounded final text or input metadata, local source references,
  truncation markers, and verified execution-owner incarnation when available.
- Collector receipt time and evidence revision. Arrival order is not causal order.

Terminal text is private evidence, never notification content. Keep private
directories 0700 and state/event files 0600. Do not copy raw tool payloads or
credentials. A bounded source excerpt may be used by the existing configured
analyst, treated as untrusted data with no instruction authority or tools.

An episode is one unresolved condition occurrence. Key it by host, namespace,
actor, turn, condition kind, and actual request/stop occurrence. Keep episode
disposition separate from delivery state. Dispositions: candidate,
confirmed_attention, unclassified_stop, resolved, suppressed_completion, and
suppressed_intentional_pause. Persist evidence version, deadline, resolution
evidence, and notification/reminder history.

Do not use text hashes as occurrence IDs: identical same-turn questions may be
different requests. PermissionRequest does not document tool_use_id; if a real
request ID cannot be obtained, retain observations and present a pending-approval
condition with identity coverage marked partial. Do not claim an exact count.
Presentation batching may group uncertainty without deleting raw evidence.

Verified current state outranks late old events. New work supersedes an old stop,
but does not itself answer an async request. A completed goal does not override
an independent pending request. Replace `policy.ts:retired()` as a blanket gate:
currently it can discard an idle no-goal session before considering final text.
Resolve each episode using applicable evidence instead.

Support 1,024 live actors and 4,096 unresolved episodes. Compact resolved detail
after seven days, preserve bounded receipt/dedup history, and expose capacity
overflow as lost coverage. Never silently evict unresolved attention. Use
monotonic intervals while running and persisted wall-clock reservations across
restarts; clock jumps cannot create extra model allowance.

## Decision rules and timing

| Signal | Decision |
| --- | --- |
| SessionStart | Register provenance; compaction is not a new execution incarnation; no push |
| UserPromptSubmit | Reconcile previous state; not a blanket resolution of outstanding requests |
| PermissionRequest | Debounce two seconds, recheck actual pending status, then immediate model-free eligibility |
| Proven input tool start/return | Reconcile actual request; async tool return is not proof of answer |
| Stop | Open a root-stop candidate, allow five seconds for continuation, settle by 45 seconds |
| SubagentStart/Stop | Preserve child identity; ordinary parent handoff stays quiet; unresolved human input may alert |
| Interrupt | Suppress only the intentionally interrupted turn; later work remains monitored |
| SessionEnd | Record close/unload; neither completion nor crash proof; do not erase pending attention |

Confirmed pending input/approval never waits for AI. A request hint whose current
state cannot be read becomes eligible for a state-unverified notice within 15
seconds. Revalidate each member before dispatch and cancel resolved requests.

Verified terminal failure without continuation, or a blocked goal with stopped
execution, also bypasses AI. Use factual templates: "Turn failed; review session"
or "Goal reports blocked; agent is not running." Do not invent a remedy from
an error code. Transient retries and tool failures while execution continues do
not generate a blocker alert on their own.

Every root stop must be resolved, supported as ordinary completion/intentional
pause, superseded by actual continuation, or eligible for a generic notice by
45 seconds. Template: "Turn stopped; completion was not established. Review
this session." If runtime reads fail, say "Stop signal observed; current session
state could not be verified." An active goal label alone is not continuation.
An agent saying it will continue later is not an execution mechanism.

Deadline timers and outbox scheduling run independently of slow discovery,
reconciliation, and model calls. A collector that misses its own deadlines must
record degraded service rather than claiming the timing contract passed.

AI may classify ordinary completion or an explicit final request using the
latest relevant user request, final answer, runtime/turn/goal facts, and parent
context. It must not suppress a stopped agent just because the fault is
agent-correctable. Ignore late results whose evidence was superseded. Do not
send another push merely to improve an already delivered generic description.

There is an explicit recall/noise tradeoff: incomplete evidence and finite AI
capacity cannot promise both zero missed ambiguous stops and zero routine-stop
notices. This plan chooses timely, accurately labelled uncertainty over silence.
Keep healthy expected waits quiet; an alive but opaque hung operation remains
unproved and may require a later observable progress contract.

## Thin independent reconciliation

Reconcile registered actors and newly discovered active work every 30 seconds.
Use current metadata and targeted terminal facts, not whole-transcript semantic
sweeps. Maximum eight concurrent RPC reads: reserve four for urgent event
revalidation, use the others for fair background discovery/reconciliation.
Keep bounded per-request deadlines, per-source backoff, and coverage warnings.
Do not revive historical idle questions merely because the service starts.

Two failed execution-owner observations 30 seconds apart, unfinished work, and
no intentional stop/continuation can produce "Execution process is no longer
present; work completion is unverified." Prove process incarnation and ownership
first. TUI exit, PID absence/reuse, and notLoaded are not crash proof. Shared
daemon disappearance is a namespace coverage incident, not 100 invented crashes.
If per-thread execution ownership is unavailable, report loss of current state
without claiming an agent process died.

Target detectable-loss eligibility within 60 seconds and transport acceptance
within approximately 90 seconds under healthy conditions. Genuine opaque hangs,
Mac sleep, network outage, collector wedging, or ntfy outage are not covered by
that target. A watchdog-only launchd job can restart an exited collector, but
cannot make a sleeping Mac send alerts or detect its own host outage remotely.

After sleep, reconnect, or a scheduling gap, start a new observation epoch and
revalidate before alerting. Send a current digest, not a historical flood. Status
must show hook-observed, snapshot-only, unidentified, and partial coverage, not
"all agents covered" based only on the actors successfully discovered.

## Optional analysis allowance

Keep gpt-5.6-luna/medium, the existing provider/auth source, no tools, 8,192-byte
input ceiling, 2,048 requested output tokens, and a 30-second request deadline.
Use 96 attempted requests per rolling 24 hours, at most four concurrent, with up
to four independently identified episodes per request when complete evidence
fits. Remove fifteen-minute spacing. Persist reservations before dispatch;
uncertain attempts consume allowance. Restart/cutover imports recent reservations.

Batch results must name the episode ID and exact evidence revision, with one
verdict per supplied episode. The new verdict contract distinguishes supported
completion, explicit user action, expected active waiting, and unknown. Require
bounded evidence citations belonging to that episode; reject unknown/duplicate
IDs and malformed output. No model verdict can override a pending structured
request or verified terminal failure. Missing/invalid results take the generic
deadline path. Retire the old single-packet validator when cutting over rather
than keeping two incompatible analyst interfaces.

This is a design budget, not authorization to run ongoing model calls during
planning. The old rate also corresponds to 96/day, but its fixed spacing is
replaced with bounded bursts. Provider errors/backoff cannot stop notifications.

| Simultaneous ambiguous stops | Four per packet | Singleton packets |
| --- | --- | --- |
| 50 | 13 requests | 50 requests |
| 100 | 25 requests | 100 requests; at least four exceed a fresh daily budget |

At four concurrent 30-second calls, packed triage can take 120/210 seconds for
50/100 episodes. Therefore it cannot gate the 45-second fallback. The request
ceiling is 196,608 output tokens/day if enforced by the provider; input is bounded
in bytes, not verified tokens or dollars. Prioritize earliest deadlines, then
fair actor order. Expired candidates become generic notices, not a queue waiting
for tomorrow's model allowance.

## Notification delivery and phone use

Keep the existing ntfy destination and receipt-aware watchdog transport. Batch
unrelated eligible episodes into a single POST without merging their identities.
Allow up to two seconds to collect a batch and preserve the three-POST/minute
limit. Each message should be at most 3 KiB UTF-8 with counts, short collision-
checked actor IDs, and a category legend. A compact 100-episode burst must fit
or split predictably; never drop entries or wait 33 minutes on individual posts.

Target isolated confirmed request acceptance within 15 seconds. Existing pacing
can add about 20 seconds; unresolved-stop acceptance should occur in about 70
seconds. These are conditional service targets. The load test must also measure
first/last inclusion when there is existing outbox traffic and a split digest.

Default push data: local host alias, short actor ID, category, count, age, and
opaque notification ID. No raw transcript, command, file path, private URL,
repository-derived label, or AI-generated remedy. Full mapping stays local.
Use the existing generic ChatGPT click URL pending verified session navigation.
Phone acceptance must prove the user can locate that exact session among many.
If the phone cannot resolve the short ID, establish a safe existing-title mapping
or verified deep link before calling mobile acceptance complete. Do not invent
a URL or build a new dashboard to avoid this check.

Delivery states: pending → intent_recorded → dispatching → server_accepted,
definite_rejection, or uncertain. Preserve each episode's link to a shared
receipt. Revalidate before dispatch, record intent before I/O, and retain the
five-second transport deadline. A malformed success or ambiguous timeout/crash
is uncertain. A receipt proves server acceptance only.

At most two delayed retries after initial definite non-delivery, respecting
Retry-After and current state. Permanent auth/config rejection does not loop.
Never blindly resend an uncertain POST. An optional bounded cache lookup using
the opaque notification ID can establish server presence; absence cannot prove
non-delivery. Use a bounded `since` window and response limit, never the entire
topic history. This lookup is an implementation option, not a first-slice gate.

Allow one batched reminder after ten minutes for freshly verified unresolved
episodes. It is a distinct observation/attempt, not a claim that the first send
failed. No endless reminders or routine resolved/completed pushes. Keep monitoring
health notices coalesced and distinct from user-attention categories.

Published ntfy.sh daily quota is 250 messages by default; actual entitlement,
other publishers, and remaining quota are unknown. At three POSTs/minute,
continuous traffic consumes 250 in about 83 minutes. Track known watchdog sends,
warn before predicted exhaustion, and never describe that estimate as the
account's remaining allowance. Capacity increases need explicit approval.
Do not schedule a minute heartbeat on this topic: that alone is 1,440 writes/day.
Independent host-death alerts are deferred; disclose the sleeping/offline-Mac gap.

## Continuous Mac operation and cutover

The default watchdog runs until explicitly stopped, supervised by a watchdog-only
user LaunchAgent if no suitable supervisor exists. Keep the existing `--duration`
only for explicit bounded runs/tests; the service must not inherit a six-hour
expiry. No new public flags, secrets, environment variables, network listener,
broker, or dashboard are needed. Reuse existing CODEX_HOME/HOME and installed
Deno paths; generate host-local launch paths instead of distributing Mac paths
as Linux commands.

Status snapshot: host/namespace scope, latest event/reconciliation, oldest
candidate/request, per-field coverage, spool occupancy/loss, actor/episode
capacity, rolling model reservations/inflight work, outbox/receipt states,
quota uncertainty, and last start/stop/sleep gap. Keep owner-only state bounded.

On explicit stop, persist state and attempt one bounded monitoring-stopped notice.
Use normal launchd unload to keep an intentional stop from immediately restarting.
On restart, reconcile current state and retain allowance/receipts. Never stop or
restart Codex agents, Remote Control, or the shared daemon as a recovery action.

For cutover, settle the old attention publisher and hold one consumer lock.
Archive V2 state; migrate recent accepted/uncertain receipts and model reservations,
re-observe active conditions, and discard old retirement/expiry conclusions.
Replace only owned probe definitions, then trust their new definitions through
normal /hooks. Preserve unrelated hooks and their trust. Already-running sessions
remain refresh-unverified until the new hook version is observed; do not restart
them to improve coverage statistics.

## Required acceptance cases

Use actual TUI behavior for lifecycle proof and deterministic fake-time tests
for the large matrix. Do not start 100 paid model sessions for a load test.

| Case | Required observation |
| --- | --- |
| Real TUI approval pending | Local hook, verified pending request, one push, user response clears episode |
| Real synchronous input request | Prompt is open; immediate deterministic alert without waiting for PostToolUse |
| Real async question | Prove hook/tool identity and response handling; label work as possibly continuing |
| Final reply asks for user action | Alert after short continuation grace; no dependence on analyst availability |
| Normal completion with adequate evidence | No blocker push; degraded unknown-stop notices remain honestly labelled |
| Active goal automatic continuation | Continuation cancels queued unexpected-stop notice |
| Provider/auth terminal failure | Targeted reconciliation detects terminal failure even without Stop |
| Purposeful pause or interrupt | No unexpected-stop push; preserve unresolved independent requests |
| Long healthy tool or model wait | Activity does not prove progress; quiet alone does not prove user action |
| Repeated tool failures while active | No alert solely for errors while execution continues; no auto-cancellation |
| Child handback | Root ownership prevents duplicate handoff alerts; a root that fails to handle it is reconciled |
| Duplicate and reordered hooks | One durable episode; stale Stop does not overwrite newer active work |
| Two same-turn requests | Two identities; each can alert; a reply does not erase unrelated request |
| Collector restart | Pending events replay; accepted/uncertain receipt ledger retained |
| Hook or spool write failure | Visible hook failure and lost-capture health; never falsely mark covered |
| Model disabled/exhausted/429 | Deterministic and bounded generic alerts still work |
| ntfy rejection or timeout | Distinct rejected/uncertain outcomes; bounded safe retry, no blind duplicate |
| 50 and 100 simultaneous blockers | Measured time to first and last session included in accepted burst digest |
| Twenty-four-hour fake-time soak | Coverage stays on; queues, storage, and model reservations remain bounded |
| Mac sleep/network outage | Cannot promise local push while offline; recovery reports gap honestly |
| Phone acceptance | User confirms labeled push appears and can locate/respond to the correct session |

Implementation should retain proof receipts and measured latencies, not only
passing assertions. A terminal push accepted by ntfy is service proof; phone
display and successful intervention are separate acceptance states.

## Implementation order and ownership

One writer implements these steps sequentially on the planned canonical lane.
This is not authorization to delegate or to change a shared service.

1. Reconcile the base, dirty state, existing probe, trust entries, provider
   configuration, topic, and any running watchdog. Read repository instructions.
   Use this final contract and reconcile any drift explicitly.
2. Start from the proved Stop path and resolve the remaining TUI mappings only
   before claiming each corresponding capability. Do not send raw hook payloads
   to logs. Reuse the proved Stop and PostToolUse receipts; no need to rerun them
   unchanged.
3. Implement Stop → local spool → episode → AI-disabled generic fallback →
   ntfy receipt → phone navigation using one intentionally unresolved disposable
   TUI session. Prove the real push before broad load testing or cleanup. Then
   add immediate structured approval/input handling.
4. Add the minimal timer/reconciliation path for terminal failures and missing
   capture. Add bounded ambiguous-stop handling without making inference a
   prerequisite for a useful alert.
5. Wire Mac user-service lifecycle, retention, and persisted outbox recovery.
   Monitor its actual startup and one task-owned restart. Do not restart the
   shared Codex daemon or alter Remote Control pairings.
6. Run the focused failure/load matrix, then review and deliver the focused
   repository change through the required GitHub loop. Review must follow
   `~/.codex/agents/pr-review.md`; record final candidate, review disposition,
   required CI, and exact Mac-installed revision separately.
7. Stop the old attention-watchdog writer only after verifying its ownership
   and settling it. Enable exactly one new consumer. Retain pending request and
   delivery state through cutover; don't treat missing old state as all-clear.
   Replace the two probe definitions with the final owned definitions without
   deleting unrelated hooks. Use the normal trust review for changed definitions.
   Verify the final installed version through a real TUI event and receipt.

Owned source surface: `watchdog/`, its directly necessary Deno tasks, a Mac
LaunchAgent/install entry point if needed, and focused documentation. Source
filenames for new components may follow existing conventions. Do not reorganize
unrelated code or rewrite the Python recovery supervisor, TUI wrapper, global
sync system, or shared Codex service.

Planning leaves this document on the main checkout; it creates no implementation
branch or worktree. The next implementation session must first preserve this
plan and attach work to the exact planned lane rather than silently changing
main or reusing the V2 lane.

## Completion report required from implementation

Report the canonical source SHA, merged PR/review result, Mac-installed revision,
loaded/trusted hook version, running collector status, model reservation policy,
and service receipt evidence. Separately report the user-confirmed locked-phone
display and exact-session intervention. List any refresh-unverified actors,
unsupported input paths, or coverage gaps. Do not claim remote acceptance from
sync or notification success from a POST attempt. Preserve unrelated dirty work.

Planning delivery: this reviewed document is saved as an uncommitted file on the
main checkout. No implementation lane, runtime redesign, remote install, or
notification-capacity purchase was performed during the design session.
