# Watchdog session handoff — 2026-09-19

Scout result for the owner: every Codex session log from the last week (2026-09-12 →
2026-09-19) whose content actually concerns a watchdog, across the Mac (`nv@m1.local`)
and the VPS (`codex@vps.pavlovcik.com`), with the capability each one delivers and the
owner requests still outstanding.

Scope note: a raw keyword match on `watchdog` is dominated by injected agent
instructions and by ambient hook sessions, so rows below are filtered to sessions that
contain a real owner request or produced a watchdog artifact. Raw counts are shown only
where they justify inclusion.

## The watchdog fleet (what exists today)

| System | Location | Owner | Cadence | State |
| --- | --- | --- | --- | --- |
| Pi Codex remote watchdog | `/home/pi/ops/codex-remote-watchdog/` (not Git-tracked) + units `codex-remote-watchdog.{timer,service}` | Pi `pi:pi` | VPS 300 s, Mac 3600 s | Live; last VPS cycle 2026-09-19 21:45Z `ok` |
| Pi Codex remote watchdog, branch 2 | `~/repos/0x4007/codex-goal-supervisor` (`watchdog/`, public GitHub `0x4007/codex-goal-supervisor`) | Mac/VPS | hook-driven | Live on VPS only; **not installed on the Mac** |
| Attention watchdog (hook V2) | VPS `/home/codex/.codex/attention-watchdog/releases/760750adb4…`; Mac has no release dir in use | VPS | hook events | Live on VPS; Mac `com.nv.codex-attention` unloaded since 2026-09-08 |
| Weekly backup watchdog | Pi `weekly-backup-watchdog.{timer,service}`, `/home/pi/ops/weekly-backup-controller/` | Pi | hourly | Live, independent of Codex |
| Wi-Fi watchdog | `0x4007/wifi-watchdog` (private GitHub) | Pi | 60 s | Unrelated to Codex; listed only to prevent mis-attribution |

Note that two different codebases are both called "the watchdog". The Pi service probes
Remote, credentials, and the provider gateway. The hook V2 monitor watches Codex
sessions and notifies. They do not share code, state, or a repository.

## Sessions, most relevant first

### 1. `01a0aae9-8448-79c3-b995-b18adbff27fa` — origin of the Pi watchdog

- Mac, `~/.codex/sessions/2026/09/16/rollout-2026-09-16T11-50-25-01a0aae9-8448-79c3-b995-b18adbff27fa.jsonl`
- 2026-09-16 15:50Z, cwd `/Users/nv`, `codex_chatgpt_ios_remote`, gpt-6-astra
- Capability: created, installed, and verified the Pi-owned `codex-remote-watchdog` — read-only client probe against the Mac and VPS app-server sockets, offline/asleep skip, same-account credential repair, zero inference. Install/handback record at `/Users/nv/.codex/tasks/codex-remote-watchdog-20260916/FINAL.md`.
- Owner requests captured: `make a service on pi that acts as a codex-remote watchdog every five minutes for vps and every hour for mac but also detect and gracefully handle if the machines are offline/asleep`; `It should also sync the working codex subscriptions as sometimes they fall out of sync on either Mac or vps`.

### 2. `01a0b491-b2ed-7491-8ba5-ccdf224b088d` — the densest watchdog request set

- VPS, `/home/codex/.codex/sessions/2026/09/18/rollout-2026-09-18T12-50-42-01a0b491-b2ed-7491-8ba5-ccdf224b088d.jsonl`
- 2026-09-18 12:50Z → 21:51Z, cwd `/home/codex/Documents/Codex/2026-09-18/all-my-codex-sessions-broke-on`, Codex Desktop, gpt-6-astra
- Capability: diagnosed four hanging Mac Codex threads, then extended the Pi watchdog with a Mac provider-gateway probe and a bounded `stale_definition` reload of exactly one launchd job (`com.ubiquity.ai.local`). Added `watchdog/gateway_test.ts` (20 offline tests), the no-paid-inference `AGENTS.md` rule, and `DECISIONS.md`.
- Evidence on the VPS: `watchdog-candidate/evidence/FINAL-HANDBACK.md`, `final-7999-{references,test}.txt`; backup `/home/pi/ops/backups/codex-remote-watchdog-pre-final-20260918T214841Z`.
- Owner requests captured:
  - `hunt down the codex watchdog service on the pi and update it to automatically handle this problem as well` (the hanging-thread failure class)
  - `The pi watchdog add to its agents.md of wherever that repo lives that it's not allowed to test with live inference calls on a clock … it runs like every five minutes for the vps`
  - gateway port question — `What happens if we want to move the port number for inference gateway? Will watchdog need to be updated as well? … it should be :7999 and reserve 8xxx for temporary development projects`
  - `let's set :7999 to be ai gateway on vps first, update watchdog to understand this, then restart codex server so that vps codex still works and update the config.toml`
  - `make sure that the watchdog handles codex updates gracefully`
  - `Teach the watchdog on raspberry pi your findings`

### 3. `01a0b67c-5dfc-7dc1-8042-f37b048a87be` — unresolved patch request, then a poisoned thread

- VPS, `/home/codex/.codex/sessions/2026/09/18/rollout-2026-09-18T21-46-38-01a0b67c-5dfc-7dc1-8042-f37b048a87be.jsonl`
- 2026-09-18 21:46Z → 2026-09-19 21:19Z, cwd `/home/codex`, `codex_chatgpt_ios_remote`, now `deepseek-flash`
- Capability: delivered the Mac no-auth / LAN-auth / VPS-auth gateway contract and wrote it into the Pi watchdog `DECISIONS.md`. Then failed.
- Failure evidence: two `task_complete` errors at 2026-09-19 01:52:40Z and 01:52:53Z — `unexpected status 403 Forbidden: user quota is not enough … http://127.0.0.1:7999/v1/responses`; `last_agent_message: null`. A later turn at 21:19:02Z failed in 293 ms with `input item type 'web_search_call' is not supported` (`invalid_request_error`, `param: input.type`). App-server reports all three turns `status: "failed"` via `thread/turns/list`; `thread/goal/get` is `null`.
- Owner requests captured: `fix it and update pi watchdog with mac is no auth and vps has auth i guess cause vps is public`; **`Audit and patch watchdog to handle this`** (never executed — the same 403 killed that turn); `can the watchdog do this now`.
- Blocker for anyone editing this thread: only 4 `web_search_call` items exist in the whole session, and the stale one now fails every new turn. Strip it or fork past it before reuse.

### 4. `01a0bb8a-ac71-7740-82ab-61800748ed86` — this audit (the answer to "can the watchdog do this now")

- Mac, `~/.codex/sessions/2026/09/19/rollout-2026-09-19T17-20-22-01a0bb8a-ac71-7740-82ab-61800748ed86.jsonl`
- 2026-09-19 21:20Z, cwd `/Users/nv`, `codex_chatgpt_ios_remote`, deepseek-flash
- Capability: proved the hook V2 attention watchdog does **not** cover failed turns.
- Findings to carry forward: the only notification gate is `isNotifiable = (p) => p.kind === "blocked"` (`watchdog/main.ts:20`, identical on VPS release `760750adb4…` and Mac `origin/main` `cbbed0b`), and dispatch additionally requires `snapshot?.goal === "blocked"` (`main.ts:333–347`). The `failed` path already exists but is unreachable: `engine.ts:208–214,249–258` build a `failed` episode from `s.terminal === "failed"`, and `policy.ts:48,56` already hold `"Turn failed; review session."` / `"Turn failed"`. In this incident no episode was built at all because the watchdog never re-read the session after the 403s (`lastRead == snapshot.at == 1789771447661`), since urgent reads fire only on `Stop`/`PermissionRequest`/`PreToolUse`. `hook-events.jsonl` shows no dispatch after 2026-09-16T04:27Z. No patch exists on any branch or worktree.

### 5. `01a0b63f-06f8-7b52-b76f-81199388324d` — the watchdog's own agent leg

- VPS, `/home/codex/.codex/sessions/2026/09/18/rollout-2026-09-18T20-39-39-01a0b63f-06f8-7b52-b76f-81199388324d.jsonl`
- 2026-09-18 20:39Z, cwd `/home/codex/repos/ubiquity/prospector-capture-monorepo`, originator literally `codex-remote-watchdog`, 187 lines, 8 `exec_command` + 14 `write_stdin`
- Capability: evidence that the Pi watchdog drives a real Codex client whose session is attributed to `codex-remote-watchdog`. Useful for anyone reasoning about what the watchdog's own traffic looks like in session state, and a caution that watchdog-generated sessions can be mistaken for owner work.

### 6. Ambient hook-V2 sessions (no owner request; listed to bound the search)

These contain `watchdog` only because the attention watchdog fired, injected context, or was read. They are not handoff material, but they show where hook V2 has actually run.

- VPS, `codex_hook_attention` originator, cwd under `repos/ubiquity/…` unless noted: `01a09f29-fac8-7351-b0f8-ea8b3f8d8c9d` (2026-09-14, read `observe.ts`), `01a0a158-7294-76c0-b19b-cb405e9e3e1a`, `01a0a00b-88ff-7d82-8aff-27b87fe7d80a`, `01a0a046-630f-7f60-b22e-04a5f04d002d`, `01a0a065-47e4-7120-b018-2a37d2c14e48`, `01a0a1a5-7142-7170-9f82-68ac9ef115b6`, `01a0a224-bbd6-7171-8452-186407281e8e`, `01a0a38a-f070-7b83-a0d7-a5e4df94f067`, `01a0a5c2-cb83-7e90-a506-31d8a7f0d160`, `01a0a66f-f689-7b82-85d8-1f5bfe43066f`, `01a0a842-a216-7002-9c03-23a87ea479de`, `01a0a8b6-8fce-7412-9b9d-b1979ba98dc3`, `01a0a8c8-8f4b-7183-a15d-428339ea9ae8`, `01a0aae2-fe11-7ec0-bbb8-070efbe3d723`, `01a0ac87-8594-7b33-ae38-aea4ea7a7e1d`, `01a0ac9f-0632-70c3-9903-52d290fe4786`
- VPS, `codex_exec` workers in other people's worktrees that read watchdog sources: `01a09708-4764-7be0-bcce-c80bd01438c4`, `01a096ff-11cf-7432-b571-a87519781943`, `01a09715-9c17-7601-9ae0-e057d94c2d59`
- Mac, sessions referencing `codex-attention.service` or `watchdog/main.ts`: `01a09713-1b31-7322-b4ec-6d21b45a604e`, `01a0971f-56f2-7952-9df8-b3a5f9ef87d6`, `01a09748-d5fd-7e83-831c-a125ec4c61cc`, `01a09753-dd31-7e72-ab51-6966c3ef6c11`, `01a0975f-e4b7-71d0-8a17-c5580f5d31c7`, `01a097eb-f378-7620-90bf-5a48d2cd6519`, `01a098a3-23e0-7402-b5bd-b077e6241a9c`, `01a0ace5-d5f0-7860-85bd-bb0c22fb8602`, `01a0ad79-6f82-7ed1-a178-8b17b4dab4ee`, `01a0b445-0fbc-78b0-aff1-7ce55f6e35d1`, `01a0b63f-d9d7-78f2-87d4-153194218cc9` (VPS Codex unavailable), `01a0b642-515f-7f10-acc8-dc0deefe9fa5` (Prospector), `01a0b87c-886c-7140-ac6f-85c211c804a2`, `01a0ab4f-7535-73a1-8a33-58e90c72f9f4`

## Owner requests to implement (handoff checklist)

Ordered by dependency, not by priority.

1. Cover failed turns in the notification path. Widen the gate so a turn that terminates with an error and no assistant message notifies. The classification scaffolding already exists (`failed` category, `engine.ts` terminal-`failed` branch); what is missing is the `isNotifiable` widening, dropping the extra `goal === "blocked"` requirement for `failed`, and a read trigger on turn termination. Include the `error.message` from `thread/turns/list`, which the app-server does expose. **Unresolved; this is what `01a0b67c` asked for and `01a0bb8a` proved absent.**
2. Also cover a turn that ends with no assistant output at all, not only a typed error.
3. Keep the no-paid-inference-on-a-clock rule enforced in code, not only in `AGENTS.md` (sha256 `a0fed97095063e1f4aab134affa4715fbceed89189287b42b276c204068d5ca5` on the Pi).
4. Keep Codex version skew informational; never restart the app-server or daemon for it.
5. Preserve the `:7999` gateway contract and the Mac no-auth / LAN-auth / VPS-auth split as the single source of truth; keep `8xxx` reserved for temporary development.
6. Confirm graceful offline/asleep handling and subscription sync still hold after any change, without new inference.
7. Decide whether the hook V2 monitor should be installed on the Mac again (currently unloaded since 2026-09-08, `status.json` `running:false`, and the Mac `hooks.json` has no watchdog hook).

## Sources and how this was produced

- Mac sessions: `/Users/nv/.codex/sessions/2026/09/1[2-9]/*.jsonl`; 32 files matched `watchdog`; 2+13 substantive hits.
- VPS sessions: `/home/codex/.codex/sessions/2026/09/1[2-9]/*.jsonl`; 46 files matched; 2 sessions carry essentially all owner requests.
- Live state checked read-only: VPS `codex-attention.service` release `760750adb4…` and `status.json`; Mac `launchctl list` and `~/.codex/attention-watchdog/status.json`; Pi `codex-remote-watchdog.{timer,service}` and `~/.local/state/codex-remote-watchdog/state.json` (vps `ok` 2026-09-19 21:45Z, mac `ok` 21:00Z, pin `78fed7bd0e91d696`).
- No files were modified, no service was restarted, and no credential value was read or printed.
