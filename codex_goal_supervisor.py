#!/usr/bin/env python3
"""Retry every non-archived Codex goal that stopped on a provider 5xx error."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_STATE_DIR = Path(__file__).with_name(".supervisor-state")
DEFAULT_PROMPT = "/goal resume"
STATUS_5XX = re.compile(
    r"(?:unexpected\s+status|status(?:\s+code)?|http(?:/\d(?:\.\d)?)?)?"
    r"[^\n]{0,80}\b5\d\d\b|"
    r"internal server error|bad gateway|service unavailable|gateway timeout",
    re.IGNORECASE,
)
AUTO_CONTINUE = b"1\n"
START_EVENTS = {"task_started", "turn_started"}
COMPLETE_EVENTS = {"task_complete", "turn_complete"}
THREAD_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.IGNORECASE)
ROLLOUT_TAIL_BYTES = 8 * 1024 * 1024
MAX_NEW_RESUMES_PER_SWEEP = 4
MAX_FAILURE_AGE_SECONDS = 60 * 60


def log(message: str) -> None:
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"{stamp} {message}", flush=True)


def codex_environment(codex_home: Path) -> dict[str, str]:
    """Build a Codex environment without creating or copying credentials."""
    environment = os.environ.copy()
    environment["CODEX_HOME"] = str(codex_home)
    return environment


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", type=Path, default=Path.home() / ".codex")
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    parser.add_argument(
        "--codex-profile",
        help="Codex config profile to layer onto each resumed session",
    )
    parser.add_argument("--interval", type=int, default=60, help="seconds between sweeps")
    parser.add_argument(
        "--duration",
        type=parse_duration,
        help="maximum runtime, using s/m/h suffixes (for example: 12h)",
    )
    parser.add_argument("--once", action="store_true", help="perform one sweep and exit")
    parser.add_argument("--dry-run", action="store_true", help="detect without resuming")
    parser.add_argument(
        "--skip-app-server-start",
        action="store_true",
        help="do not bootstrap the local Codex app-server daemon",
    )
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    return parser.parse_args()


def parse_duration(value: str) -> int:
    match = re.fullmatch(r"(\d+)([smh]?)", value.strip().lower())
    if not match:
        raise argparse.ArgumentTypeError("duration must look like 30m, 12h, or 3600")
    amount = int(match.group(1))
    multiplier = {"": 1, "s": 1, "m": 60, "h": 3600}[match.group(2)]
    seconds = amount * multiplier
    if seconds < 1:
        raise argparse.ArgumentTypeError("duration must be at least one second")
    return seconds


def thread_records(database: Path) -> dict[str, tuple[Path, Path]]:
    query = "SELECT id, rollout_path, cwd FROM threads WHERE archived = 0 ORDER BY created_at, id"
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        return {
            row[0].lower(): (Path(row[1]), Path(row[2]))
            for row in connection.execute(query)
        }


def event_name(record: dict) -> str | None:
    if record.get("type") == "event_msg":
        payload = record.get("payload") or {}
        return payload.get("type")
    return record.get("type")


def _read_rollout_tail(path: Path) -> str:
    with path.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        stream.seek(max(0, size - ROLLOUT_TAIL_BYTES))
        data = stream.read()
    text = data.decode("utf-8", errors="replace")
    if size > ROLLOUT_TAIL_BYTES:
        _, separator, text = text.partition("\n")
        if not separator:
            return ""
    return text


def _record_timestamp(record: dict) -> float | None:
    value = record.get("timestamp")
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    payload = record.get("payload") or {}
    for key in ("completed_at", "started_at"):
        value = payload.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None


def _terminal_5xx_details(
    path: Path, cache: dict[str, dict] | None = None
) -> tuple[bool, str, float | None]:
    """Return the latest visible provider 5xx and its event timestamp."""
    stat = path.stat()
    cache_key = str(path)
    cached = cache.get(cache_key) if cache is not None else None
    metadata = {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
    if cached and all(cached.get(key) == value for key, value in metadata.items()):
        failure_at = cached.get("failure_at")
        return bool(cached["failed"]), str(cached["reason"]), failure_at

    latest_start = -1
    latest_complete = -1
    latest_error = ""
    latest_error_at: float | None = None
    for line_number, line in enumerate(_read_rollout_tail(path).splitlines(), 1):
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        name = event_name(record)
        if name in START_EVENTS:
            latest_start = line_number
        if name in COMPLETE_EVENTS:
            latest_complete = line_number
            payload = record.get("payload") or {}
            error = payload.get("error")
            latest_error = json.dumps(error, ensure_ascii=True) if error else ""
            latest_error_at = _record_timestamp(record) if error else None

    if latest_complete < 0:
        result = (False, "no terminal turn event in rollout tail", None)
    elif latest_start > latest_complete:
        if latest_error and STATUS_5XX.search(latest_error):
            result = (True, "unfinished retry after provider 5xx", latest_error_at)
        else:
            result = (False, "turn is running", None)
    elif latest_error and STATUS_5XX.search(latest_error):
        match = STATUS_5XX.search(latest_error)
        result = (True, match.group(0) if match else "provider 5xx", latest_error_at)
    else:
        result = (False, "latest turn did not end with a provider 5xx", None)

    if cache is not None:
        cache[cache_key] = {
            **metadata,
            "failed": result[0],
            "reason": result[1],
            "failure_at": result[2],
        }
    return result


def terminal_5xx(path: Path, cache: dict[str, dict] | None = None) -> tuple[bool, str]:
    """Return true only when the latest visible turn state is a provider 5xx."""
    failed, reason, _ = _terminal_5xx_details(path, cache)
    return failed, reason


def load_scan_cache(path: Path) -> dict[str, dict]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def write_scan_cache(path: Path, cache: dict[str, dict]) -> None:
    temporary = path.with_suffix(".next")
    temporary.write_text(json.dumps(cache, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, path)


def writer_lock_held(codex_home: Path, thread_id: str) -> bool:
    lock_path = codex_home / "thread-writer-locks" / f"{thread_id}.lock"
    try:
        with lock_path.open("r+") as lock_stream:
            try:
                fcntl.flock(lock_stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            finally:
                try:
                    fcntl.flock(lock_stream, fcntl.LOCK_UN)
                except OSError:
                    pass
    except FileNotFoundError:
        return False
    return False


def process_lines() -> list[tuple[str, str]]:
    try:
        result = subprocess.run(
            ["/usr/bin/ps", "-eo", "tty=,args="],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
    except OSError:
        return []
    lines: list[tuple[str, str]] = []
    for line in result.stdout.splitlines():
        value = line.strip()
        if not value:
            continue
        parts = value.split(None, 1)
        if len(parts) == 2:
            lines.append((parts[0], parts[1]))
    return lines


def running_resume_thread_ids() -> set[str]:
    result: set[str] = set()
    for _, command in process_lines():
        if "codex" not in command or "resume" not in command:
            continue
        result.update(value.lower() for value in THREAD_ID.findall(command))
    return result


def ensure_app_server(codex: str, codex_home: Path) -> None:
    environment = codex_environment(codex_home)
    try:
        result = subprocess.run(
            [codex, "app-server", "daemon", "start"],
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        log(f"unable to start Codex app-server daemon: {error}")
        return
    if result.returncode != 0:
        details = result.stderr.strip().replace("\n", " ")
        log(f"Codex app-server daemon start failed ({result.returncode}): {details[:240]}")


def resume(
    codex: str,
    thread_id: str,
    prompt: str,
    cwd: Path,
    state_dir: Path,
    codex_home: Path,
    codex_profile: str | None,
) -> subprocess.Popen[bytes]:
    command = [codex, "exec"]
    if codex_profile:
        command.extend(["--profile", codex_profile])
    command.extend(["resume", thread_id, prompt])
    log(f"resuming {thread_id}")
    output = (state_dir / f"{thread_id}.log").open("ab")
    try:
        child_environment = codex_environment(codex_home)
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=child_environment,
            stdin=subprocess.PIPE,
            stdout=output,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            process.stdin.write(AUTO_CONTINUE)
            process.stdin.flush()
        except BrokenPipeError:
            pass
        except OSError:
            pass
        finally:
            process.stdin.close()
        return process
    finally:
        output.close()


def main() -> int:
    args = parse_args()
    if args.interval < 1:
        raise ValueError("--interval must be at least 1 second")
    database = args.codex_home / "state_5.sqlite"
    state_dir = args.state_dir
    state_dir.mkdir(mode=0o700, exist_ok=True)
    lock_stream = (state_dir / "supervisor.lock").open("w", encoding="utf-8")
    try:
        fcntl.flock(lock_stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("another supervisor instance is already running")
        return 2

    scan_cache_path = state_dir / "scan-cache.json"
    scan_cache = load_scan_cache(scan_cache_path)

    cursor_path = state_dir / "cursor"
    try:
        cursor = int(cursor_path.read_text(encoding="utf-8").strip())
    except (FileNotFoundError, ValueError):
        cursor = 0
    codex = os.environ.get("CODEX_BIN", "codex")
    deadline = time.monotonic() + args.duration if args.duration else None
    active_resumes: dict[str, subprocess.Popen[bytes]] = {}

    while True:
        if deadline is not None and time.monotonic() >= deadline:
            log("runtime limit reached; supervisor exiting")
            return 0
        if not args.skip_app_server_start:
            ensure_app_server(codex, args.codex_home)
        for thread_id, child in list(active_resumes.items()):
            return_code = child.poll()
            if return_code is not None:
                log(f"resume process exited {return_code}: {thread_id}")
                active_resumes.pop(thread_id, None)
        records = thread_records(database)
        targets = sorted(records)
        if not targets:
            log("no non-archived Codex threads found")
            time.sleep(args.interval)
            continue
        cursor %= len(targets)
        ordered = targets[cursor:] + targets[:cursor]
        running_ids = running_resume_thread_ids()
        launched = 0
        deferred = 0
        protected = 0
        healthy = 0
        stale = 0
        recent_failures = 0
        for thread_id in ordered:
            record = records.get(thread_id)
            if record is None:
                log(f"skipping {thread_id}: rollout not found")
                continue
            path, cwd = record
            if not path.is_file():
                log(f"skipping {thread_id}: rollout not found")
                continue
            if not cwd.is_dir():
                log(f"skipping {thread_id}: working directory not found: {cwd}")
                continue
            active = active_resumes.get(thread_id)
            if active is not None:
                protected += 1
                continue
            if thread_id in running_ids:
                protected += 1
                continue
            if writer_lock_held(args.codex_home, thread_id):
                protected += 1
                continue
            failed, reason, failure_at = _terminal_5xx_details(path, scan_cache)
            if not failed:
                healthy += 1
                continue
            if failure_at is None:
                stale += 1
                continue
            failure_age = max(0.0, time.time() - failure_at)
            if failure_age > MAX_FAILURE_AGE_SECONDS:
                stale += 1
                continue
            recent_failures += 1
            log(f"detected provider failure for {thread_id}: {reason}")
            if not args.dry_run and launched < MAX_NEW_RESUMES_PER_SWEEP:
                child = resume(
                    codex,
                    thread_id,
                    args.prompt,
                    cwd,
                    state_dir,
                    args.codex_home,
                    args.codex_profile,
                )
                active_resumes[thread_id] = child
                running_ids.add(thread_id)
                launched += 1
                log(f"started resume pid {child.pid}: {thread_id}")
            elif not args.dry_run:
                deferred += 1

        write_scan_cache(scan_cache_path, scan_cache)
        log(
            f"sweep threads={len(ordered)} healthy={healthy} stale={stale} "
            f"protected={protected} recent_5xx={recent_failures} "
            f"launched={launched} deferred={deferred}"
        )
        cursor = (cursor + 1) % len(targets)
        cursor_path.write_text(f"{cursor}\n", encoding="utf-8")
        if args.once:
            return 0
        sleep_for = args.interval
        if deadline is not None:
            sleep_for = min(sleep_for, max(0, deadline - time.monotonic()))
        time.sleep(sleep_for)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, sqlite3.Error) as error:
        print(f"codex-goal-supervisor: {error}", file=sys.stderr)
        raise SystemExit(1)
