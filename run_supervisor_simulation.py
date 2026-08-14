#!/usr/bin/env python3
"""End-to-end proof that the supervisor recovers a Codex turn after a 503."""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from codex_goal_supervisor import terminal_5xx


ROOT = Path(__file__).resolve().parent
RUN = ROOT / ".simulation"
PROFILE = "supervisor-5xx-sim"
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.I)


def wait_for(path: Path, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.is_file() and path.stat().st_size:
            return
        time.sleep(0.1)
    raise RuntimeError(f"timed out waiting for {path}")


def session_id(output: str) -> str:
    for line in output.splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        value = record.get("thread_id")
        if isinstance(value, str) and UUID.fullmatch(value):
            return value.lower()
    match = UUID.search(output)
    if not match:
        raise RuntimeError("Codex output did not include a session ID")
    return match.group(0).lower()


def control(port: int, mode: str) -> None:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/__control/{mode}", data=b"", method="POST"
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        if response.status != 200:
            raise RuntimeError(f"proxy control returned {response.status}")


def main() -> int:
    if not os.environ.get("UOS_AI_TOKEN"):
        raise RuntimeError("UOS_AI_TOKEN is required for the healthy pass-through phase")

    shutil.rmtree(RUN, ignore_errors=True)
    codex_home = RUN / "codex-home"
    work = RUN / "work"
    state = RUN / "supervisor-state"
    for path in (codex_home, work, state):
        path.mkdir(parents=True, mode=0o700)

    ready = RUN / "proxy.port"
    proxy_log = RUN / "proxy.jsonl"
    proxy_output = (RUN / "proxy.output.log").open("wb")
    proxy = subprocess.Popen(
        [
            sys.executable,
            str(ROOT / "fake_responses_proxy.py"),
            "--log",
            str(proxy_log),
            "--ready-file",
            str(ready),
        ],
        stdout=proxy_output,
        stderr=subprocess.STDOUT,
    )
    supervisor = None
    try:
        wait_for(ready, 5)
        port = int(ready.read_text(encoding="utf-8").strip())
        (codex_home / "config.toml").write_text(
            f'''model = "gpt-5.6-sol"
model_provider = "supervisor_sim_proxy"

[model_providers.supervisor_sim_proxy]
name = "Local supervisor 5xx simulation"
base_url = "http://127.0.0.1:{port}/v1"
env_key = "UOS_AI_TOKEN"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
''',
            encoding="utf-8",
        )
        (codex_home / f"{PROFILE}.config.toml").write_text(
            '''model = "gpt-5.6-sol"
model_provider = "supervisor_sim_proxy"
model_reasoning_effort = "low"
''',
            encoding="utf-8",
        )

        environment = os.environ.copy()
        environment["CODEX_HOME"] = str(codex_home)
        initial = subprocess.run(
            [
                "codex",
                "exec",
                "--profile",
                PROFILE,
                "--json",
                "--skip-git-repo-check",
                "-C",
                str(work),
                "Reply exactly INITIAL_CALL_SHOULD_NOT_SUCCEED.",
            ],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=60,
        )
        (RUN / "initial-codex.jsonl").write_text(initial.stdout, encoding="utf-8")
        if initial.returncode == 0:
            raise RuntimeError("injected 503 did not fail the initial Codex turn")
        thread_id = session_id(initial.stdout)

        database = codex_home / "state_5.sqlite"
        wait_for(database, 5)
        with sqlite3.connect(database) as connection:
            row = connection.execute(
                "SELECT rollout_path FROM threads WHERE lower(id) = ?", (thread_id,)
            ).fetchone()
        if row is None:
            raise RuntimeError("failed session was not persisted in the isolated Codex home")
        rollout = Path(row[0])
        failed, reason = terminal_5xx(rollout)
        if not failed:
            raise RuntimeError(f"supervisor detector rejected simulated failure: {reason}")

        control(port, "pass")
        supervisor_log = (RUN / "supervisor.log").open("wb")
        supervisor = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "codex_goal_supervisor.py"),
                "--codex-home",
                str(codex_home),
                "--state-dir",
                str(state),
                "--codex-profile",
                PROFILE,
                "--skip-app-server-start",
                "--interval",
                "2",
                "--duration",
                "90s",
                "--prompt",
                "Resume after the simulated provider outage. Reply exactly SIMULATION_RECOVERED.",
            ],
            env=environment,
            stdout=supervisor_log,
            stderr=subprocess.STDOUT,
        )

        deadline = time.monotonic() + 80
        evidence = ""
        child_output = state / f"{thread_id}.log"
        while time.monotonic() < deadline:
            supervisor_log.flush()
            evidence = (RUN / "supervisor.log").read_text(encoding="utf-8", errors="replace")
            response = (
                child_output.read_text(encoding="utf-8", errors="replace")
                if child_output.exists()
                else ""
            )
            if "resume process exited 0" in evidence and "SIMULATION_RECOVERED" in response:
                break
            if supervisor.poll() is not None:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("timed out waiting for the supervisor recovery")

        response = child_output.read_text(encoding="utf-8", errors="replace")
        if "detected provider failure" not in evidence or "started resume pid" not in evidence:
            raise RuntimeError("supervisor log lacks detection/start evidence")
        if "resume process exited 0" not in evidence:
            raise RuntimeError("resumed Codex process did not exit successfully")
        if "SIMULATION_RECOVERED" not in response:
            raise RuntimeError("resumed session did not produce the expected response")
        still_failed, final_reason = terminal_5xx(rollout)
        if still_failed:
            raise RuntimeError(f"session still ends in a 5xx state: {final_reason}")

        records = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        if not any(record["mode"] == "fail" and record["status"] == 503 for record in records):
            raise RuntimeError("proxy log lacks the injected 503")
        if not any(record["mode"] == "pass" and record["status"] == 200 for record in records):
            raise RuntimeError("proxy log lacks a successful recovery request")

        print("PASS: supervisor recovered the simulated 503-stopped Codex session")
        print(f"session_id={thread_id}")
        print(f"profile={PROFILE}")
        print(f"artifacts={RUN}")
        return 0
    finally:
        if supervisor is not None and supervisor.poll() is None:
            supervisor.terminate()
            try:
                supervisor.wait(timeout=5)
            except subprocess.TimeoutExpired:
                supervisor.kill()
        if proxy.poll() is None:
            proxy.terminate()
            try:
                proxy.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proxy.kill()
        proxy_output.close()


if __name__ == "__main__":
    raise SystemExit(main())
