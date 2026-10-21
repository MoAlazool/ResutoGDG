"""Optional error tracking for the AI service (audit CR-14), without a dependency.

Events are posted in the Sentry envelope format (Sentry, GlitchTip and compatible services accept it) when
ERROR_TRACKING_DSN is set; off otherwise. Same rules as the API (apps/api/src/common/observability/error-tracking.ts):
an event carries only the error type, a scrubbed message, scrubbed stack frames (file, function, line), the route
PATTERN, the request id, the service, the deployed commit and the environment. Never request bodies (tenant data),
headers, query strings, emails, phone numbers or tokens. Best effort: sent from a daemon thread with a 3 s timeout, at
most 30 events a minute, identical errors once a minute; it never raises and never delays the response.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import traceback
import urllib.request
import uuid
from urllib.parse import urlsplit

_SCRUBBERS = [
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.I), "Bearer [redacted]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*"), "[jwt]"),
    (re.compile(r"\b(?:rmcp|rsk|sk|pk|whsec)_[A-Za-z0-9_-]{8,}"), "[key]"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[email]"),
    (re.compile(r"(?:\+|00)?\d[\d\s-]{7,}\d"), "[number]"),
    (re.compile(r"\b[A-Za-z0-9_-]{32,}\b"), "[token]"),
    (re.compile(r"([?&][^=\s&]+)=[^\s&]+"), r"\1=[redacted]"),
]


def scrub(text, limit: int = 500) -> str:
    out = str(text if text is not None else "")
    for pattern, repl in _SCRUBBERS:
        out = pattern.sub(repl, out)
    return out if len(out) <= limit else out[:limit] + "…"


def parse_dsn(raw: str | None):
    if not raw:
        return None
    try:
        u = urlsplit(raw)
    except ValueError:
        return None
    if u.scheme not in ("http", "https") or not u.username:
        return None
    parts = u.path.rstrip("/").split("/")
    project = parts.pop() if parts else ""
    if not project.isdigit():
        return None
    host = u.hostname + (f":{u.port}" if u.port else "")
    return {"endpoint": f"{u.scheme}://{host}{'/'.join(parts)}/api/{project}/envelope/", "public_key": u.username,
            "raw": f"{u.scheme}://{u.username}@{host}{u.path}"}


def _frames(error: BaseException) -> list[dict]:
    frames = []
    for fs in traceback.extract_tb(error.__traceback__)[-30:]:
        m = re.search(r"((?:apps|packages)/.+)$", fs.filename)
        name = m.group(1) if m else "/".join(fs.filename.split("/")[-2:])
        frames.append({"filename": scrub(name, 200), "function": scrub(fs.name, 120), "lineno": fs.lineno,
                       "in_app": "site-packages" not in fs.filename})
    return frames


def build_event(error: BaseException, *, route: str | None, request_id: str | None, environment: str, release: str | None) -> dict:
    tags = {"service": "ai", "source": "ai"}
    if route:
        tags["route"] = scrub(route, 200)
    if request_id:
        tags["request_id"] = request_id[:64]
    event = {"event_id": uuid.uuid4().hex, "timestamp": time.time(), "platform": "python", "level": "error",
             "environment": environment, "tags": tags,
             "exception": {"values": [{"type": scrub(type(error).__name__, 80), "value": scrub(error),
                                       "stacktrace": {"frames": _frames(error)}}]}}
    if release:
        event["release"] = release
    return event


class ErrorReporter:
    def __init__(self, raw_dsn: str | None, environment: str = "development", release: str | None = None, sender=None):
        self.dsn = parse_dsn(raw_dsn)
        self.environment = environment
        self.release = release
        self._send = sender or self._post
        self._window = [0.0, 0]
        self._recent: dict[str, float] = {}
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self.dsn is not None

    def capture(self, error: BaseException, *, route: str | None = None, request_id: str | None = None) -> str:
        """Queues the event on a daemon thread; returns 'queued' or 'skipped' (never raises)."""
        if not self.dsn:
            return "skipped"
        now = time.time()
        key = f"{type(error).__name__}:{error}:{route or ''}"[:300]
        with self._lock:
            if now - self._window[0] > 60:
                self._window = [now, 0]
            if self._recent.get(key, 0) > now - 60 or self._window[1] >= 30:
                return "skipped"
            self._window[1] += 1
            self._recent[key] = now
            if len(self._recent) > 500:
                self._recent.clear()
        try:
            event = build_event(error, route=route, request_id=request_id, environment=self.environment, release=self.release)
            body = "\n".join([json.dumps({"event_id": event["event_id"], "dsn": self.dsn["raw"]}), json.dumps({"type": "event"}),
                              json.dumps(event)]).encode()
            threading.Thread(target=self._safe_send, args=(body,), daemon=True).start()
            return "queued"
        except Exception:  # noqa: BLE001 - reporting must never break a response
            return "skipped"

    def _safe_send(self, body: bytes) -> None:
        try:
            self._send(self.dsn["endpoint"], body, self.dsn["public_key"])
        except Exception:  # noqa: BLE001
            pass

    @staticmethod
    def _post(endpoint: str, body: bytes, public_key: str) -> None:
        req = urllib.request.Request(endpoint, data=body, method="POST", headers={
            "Content-Type": "application/x-sentry-envelope",
            "X-Sentry-Auth": f"Sentry sentry_version=7, sentry_key={public_key}, sentry_client=resuto-ai/1.0"})
        urllib.request.urlopen(req, timeout=3).close()  # noqa: S310 - the DSN host is operator configuration


_reporter: ErrorReporter | None = None


def reporter() -> ErrorReporter:
    global _reporter
    if _reporter is None:
        commit = next((v.strip().lower() for v in (os.environ.get("RENDER_GIT_COMMIT"), os.environ.get("GIT_COMMIT_SHA"))
                       if v and re.match(r"^[0-9a-fA-F]{7,40}$", v.strip())), None)
        _reporter = ErrorReporter(os.environ.get("ERROR_TRACKING_DSN"), os.environ.get("AI_SERVICE_ENV", os.environ.get("ENVIRONMENT", "development")), commit)
    return _reporter


def configure(next_reporter: ErrorReporter | None) -> None:
    global _reporter
    _reporter = next_reporter
