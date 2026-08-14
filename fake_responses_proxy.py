#!/usr/bin/env python3
"""Loopback fault-injection proxy for a Responses API endpoint."""

from __future__ import annotations

import argparse
import json
import shutil
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}


class FaultProxy(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler, upstream: str, log_path: Path, mode: str):
        super().__init__(address, handler)
        self.upstream = upstream.rstrip("/")
        self.log_path = log_path
        self.mode = mode
        self.state_lock = threading.Lock()

    def set_mode(self, mode: str) -> None:
        with self.state_lock:
            self.mode = mode

    def get_mode(self) -> str:
        with self.state_lock:
            return self.mode

    def audit(self, path: str, mode: str, status: int) -> None:
        record = {
            "time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "method": "POST",
            "path": path,
            "mode": mode,
            "status": status,
        }
        with self.state_lock:
            with self.log_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(record, sort_keys=True) + "\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args) -> None:
        return

    @property
    def proxy(self) -> FaultProxy:
        return self.server  # type: ignore[return-value]

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/__control/status":
            self.send_json(200, {"mode": self.proxy.get_mode()})
            return
        self.forward()

    def do_POST(self) -> None:
        if self.path in {"/__control/fail", "/__control/pass"}:
            mode = self.path.rsplit("/", 1)[-1]
            self.proxy.set_mode(mode)
            self.send_json(200, {"mode": mode})
            return
        self.forward()

    def forward(self) -> None:
        mode = self.proxy.get_mode()
        if mode == "fail":
            status = 503
            self.send_json(
                status,
                {
                    "error": {
                        "message": "simulated provider outage",
                        "type": "server_error",
                        "code": "simulated_503",
                    }
                },
            )
            self.proxy.audit(self.path, mode, status)
            return

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else None
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in HOP_BY_HOP | {"host", "content-length"}
        }
        request = urllib.request.Request(
            self.proxy.upstream + self.path,
            data=body,
            headers=headers,
            method=self.command,
        )
        try:
            response = urllib.request.urlopen(request, timeout=360)
        except urllib.error.HTTPError as error:
            response = error
        except urllib.error.URLError as error:
            status = 502
            self.send_json(status, {"error": {"message": str(error), "type": "proxy_error"}})
            self.proxy.audit(self.path, mode, status)
            return

        status = response.status
        self.send_response(status)
        for key, value in response.headers.items():
            if key.lower() not in HOP_BY_HOP | {"content-length"}:
                self.send_header(key, value)
        self.send_header("Connection", "close")
        self.end_headers()
        shutil.copyfileobj(response, self.wfile)
        response.close()
        self.proxy.audit(self.path, mode, status)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--upstream", default="https://ai.ubq.fi")
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--ready-file", type=Path, required=True)
    parser.add_argument("--mode", choices=("fail", "pass"), default="fail")
    args = parser.parse_args()
    args.log.parent.mkdir(parents=True, exist_ok=True)
    server = FaultProxy(("127.0.0.1", args.port), Handler, args.upstream, args.log, args.mode)
    args.ready_file.write_text(f"{server.server_port}\n", encoding="utf-8")
    server.serve_forever()


if __name__ == "__main__":
    main()
