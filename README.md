# Codex goal 5xx supervisor

## Managed interactive sessions

`codex-managed` keeps an interactive Codex session inside tmux. An SSH
disconnect detaches the client but leaves Codex running. Repeating the same
command attaches to the same session, and a dead pane is respawned with the
same command.

Install the harness beside the Codex executable:

```bash
mkdir -p "$HOME/.local/bin"
install -m 0755 codex-managed "$HOME/.local/bin/codex-managed"
install -m 0755 codex-managed-pane "$HOME/.local/bin/codex-managed-pane"
```

The harness expects the Codex executable at `$HOME/.local/bin/codex` and tmux
on `PATH`. If tmux is unavailable, it runs Codex directly. It also bypasses
tmux for `codex exec` and whenever standard input or output is not a terminal.

Start or resume Codex normally through the harness:

```bash
codex-managed
codex-managed --new
codex-managed resume SESSION_ID
```

`codex-managed --new` always starts a fresh tmux session. Resume commands use a
stable tmux session named `codex-resume-SESSION_ID`. Normal new sessions use a
stable name derived from the working directory. The tmux status
bar says `supervised session`. The pane stays available after a normal exit.
The pane supervisor catches SIGHUP and SIGTERM and retries Codex after signal
exit statuses 129, 137, and 143.
Run the same `codex-managed` command again to reattach or respawn a dead pane.
A normal Codex exit removes its dead pane, so it returns to a usable shell
instead of leaving a `Pane is dead` screen. You do not need to detach tmux
manually before closing SSH. Mouse-wheel scrolling is enabled; keyboard
scrollback is available with `Ctrl-b [` followed by `PageUp` or the arrow keys.

This is a best-effort persistence harness, not a security boundary. It cannot
prevent the same user from killing the tmux server, deleting the session, using
SIGKILL, or terminating other Codex processes.

To route interactive `codex` commands through the harness, add this function to
the host's shell startup file:

```bash
function codex {
  command "$HOME/.local/bin/codex-managed" "$@"
}
```

## Elevator pitch

Automatically recover Codex goals stopped by a transient provider 5xx error.
The supervisor finds the affected non-archived thread, sends the existing
session a `/goal resume` prompt (including headed, GUI, and remote-control
sessions), and retries at most four threads per sweep. It respects per-thread
writer locks and duplicate-resume checks, and never kills a Codex process or
stops the shared app-server.

## User-service setup

The checked-in user service uses systemd's `%h` home-directory specifier and a
standard per-user data directory. Clone the repository there, or copy the unit
to a local drop-in and change the two repository paths if you use another
layout.

```bash
set -Eeuo pipefail

repo="$HOME/.local/share/codex-goal-supervisor"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

if [ -d "$repo/.git" ]; then
  test "$(git -C "$repo" branch --show-current)" = main
  test -z "$(git -C "$repo" status --porcelain)"
  git -C "$repo" pull --ff-only origin main
elif [ ! -e "$repo" ]; then
  command -v git >/dev/null
  mkdir -p "$(dirname "$repo")"
  git clone https://github.com/0x4007/codex-goal-supervisor.git "$repo"
else
  printf 'Refusing to use non-Git path: %s\n' "$repo" >&2
  exit 1
fi

command -v codex >/dev/null
test -r "$HOME/.codex/state_5.sqlite"
python3 -m py_compile "$repo/codex_goal_supervisor.py"

# Read-only proof before enabling live retries.
python3 "$repo/codex_goal_supervisor.py" \
  --once --dry-run --skip-app-server-start

install -D -m 0644 "$repo/codex-goal-supervisor.service" \
  "$unit_dir/codex-goal-supervisor.service"
systemctl --user daemon-reload
systemctl --user enable --now codex-goal-supervisor.service
systemctl --user --no-pager --full status codex-goal-supervisor.service
```

The service uses the current user's `$CODEX_HOME` and inherits normal Codex
authentication from that account. It does not access a project-specific
Telegram bridge or create, copy, or log bearer tokens.

`codex_goal_supervisor.py` watches every non-archived Codex thread in
`$CODEX_HOME/state_5.sqlite`. It resumes a thread only when the latest visible
turn ended with a timestamped provider 5xx error in the last hour (or an
unfinished retry after one), and it keeps retrying until a later turn is no
longer a 5xx. Older brownouts are ignored.

The supervisor does not use a hand-maintained session list. Its default prompt
is exactly `/goal resume`; pass `--prompt "/goal resume resume"` when the
consumer has no active goal. It can send the prompt to a headed, GUI, or
remote-control session when that
thread has a recent provider 5xx failure. It skips individual threads with a
held Codex writer lock or an existing resume process. It launches at most four
new resumes per sweep so a provider outage cannot flood the VPS. It never sends
a kill signal or stops the app-server.

The service runs continuously under systemd. Its child processes are not killed
when the supervisor service is restarted; systemd uses `KillMode=process`.
Resume output and the bounded rollout scan cache are stored under
`.supervisor-state/`.

Run one read-only detection sweep:

```bash
python3 codex_goal_supervisor.py --once --dry-run
```

Run continuously:

```bash
python3 codex_goal_supervisor.py
```

Useful options:

```text
--interval SECONDS              Polling interval (default: 60)
--duration DURATION             Optional runtime limit such as 12h
--once                          Perform one sweep and exit
--dry-run                       Detect failures without resuming threads
--codex-home DIR                Use a different Codex state directory
--state-dir DIR                 Store state and logs elsewhere
--codex-profile ID              Layer a named Codex profile onto resumed sessions
--skip-app-server-start         Do not bootstrap the local app-server daemon
```

The resume mechanism is the installed CLI's supported noninteractive form:
`codex exec resume SESSION_ID PROMPT`.

## Isolated 5xx recovery simulation

Run the end-to-end fault-injection proof without touching production state:

```bash
python3 run_supervisor_simulation.py
```

The runner creates an isolated Codex home, injects a 503, switches the proxy to
pass-through mode, and checks that the same thread resumes and no longer has a
terminal 5xx state.

## Session attention watchdog

Run a bounded, read-only monitor alongside the recovery service:

```sh
deno task watchdog --duration 6h
```

It checks the existing Codex daemon every minute, scans bounded recent evidence
at five-minute intervals, and considers ten minutes without progress suspicious.
Current approvals/input requests bypass the model. Ambiguous cases use the
configured provider's `gpt-5.6-luna` with medium reasoning. V2 makes one credit
available immediately and replenishes it fifteen minutes after each reserved
attempt. Credits do not accumulate: at most 24 attempts fit in a six-hour run.
Failed or uncertain requests consume their reserved attempt. Unchanged semantic
evidence is not repeatedly analyzed; a stated expected wait can receive one
bounded recheck. A fair queue gives older eligible sessions the next credit.
No model tools are enabled. The monitor never starts, resumes, interrupts or
edits watched threads. Active work and blocked goals remain watched; explicit
paused, archived, completed or interrupted work retires. Missing data does not
prove retirement. Distinct requests within one turn can notify separately.


Existing configuration is reused: `~/.codex/config.toml` (or `CODEX_HOME`), its
provider auth helper or API key, and `~/.config/codex-nudge/topic`. The ntfy topic
must already exist locally. Only concise blocker/action summaries are sent.
Notifications open ChatGPT and include the thread ID; a mobile link that selects
a local Codex thread is not verified. A topic name is not authenticated privacy.

State, OS lock, reserved model calls and alert receipts live in
`$CODEX_HOME/attention-watchdog/` (default `~/.codex/attention-watchdog/`). Restart
an unfinished run with the same command to preserve its original expiry/budget.
Once it has expired, the command starts a new bounded run. The lock prevents two
watchdogs; its file may remain after exit. Alert attempts are saved before
sending, and uncertain delivery is not automatically retried. Logs omit message
bodies and credentials. Ordinary historical idle questions are not reactivated.

`--once` performs one real check (it can notify or call the model). `--smoke`
reads actual session metadata, sends one synthetic blocker to Luna, and sends a
labeled ntfy test; it consumes one separate model request. Use it only when that
live test is authorized. Normal tests use synthetic evidence and a local fake Unix-socket daemon, with no model or ntfy traffic:

```sh
deno task watchdog:test
deno task watchdog:check
```

Only sessions visible to this host's shared daemon are covered. Independently
running VPS processes require evidence through their supervising sessions.
A sleeping/offline host cannot monitor; this is not an external uptime service.
V2 tracks observation, analysis and delivery health separately. Failed reads
receive per-source backoff and a coverage warning after three minutes; an
unreadable goal field does not hide a current approval flag. Overdue analysis
queues generate a coalesced delay notice. Temporary provider failures enter
recoverable, credit-limited backoff; authentication/configuration rejection
requires repair and an explicit restart. Direct checks remain available.

`events.jsonl` records decision/skip reasons, source failures, analysis attempts
and returned usage, health transitions, and notification acceptance/rejection or
uncertainty. Every five minutes it writes a coverage summary. Logs rotate at
10 MiB with two older files; the last ten expired run summaries are retained.
State V2 preserves the original deadline and credit time across restarts. V1
unfinished state receives an explicit cutover notice and no immediate free
credit. Invalid state is rejected rather than silently reset.

The outbox limits posts to three per minute, coalesces monitoring-health bursts,
and rechecks session evidence before sending. A definite rate-limit rejection
can receive two delayed retries; an uncertain POST is never blindly repeated.
Service acceptance is not proof that an iPhone displayed or read a notification.
A final summary is attempted before normal expiry. Sudden process or machine
death cannot be reported reliably by that same process. Usage caps are not
verified dollar prices.

See [V2 acceptance evidence](docs/watchdog-v2-acceptance.md) for the bounded
replay, runtime checks, and known coverage limits.
