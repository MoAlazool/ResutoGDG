"""Resuto Intelligence HTTP service.

Stateless: the Resuto API sends minimal tenant-scoped data per request; this service has no
database access and stores nothing. Every /v1 endpoint except /v1/health requires
``Authorization: Bearer <AI_SERVICE_TOKEN>``. The service refuses to start without a token unless
``AI_SERVICE_ALLOW_NO_AUTH=1`` (local tests only).
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import re
import sys
import time
import uuid
from datetime import timezone

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from . import __version__
from .core import customers as cust
from .core import forecast as fc
from .core import recommend as rec
from .core import routing as rt
from .schemas import ChurnRequest, ForecastRequest, RecommendRequest, RouteRequest, SegmentRequest

MAX_BODY_BYTES = int(os.environ.get("AI_SERVICE_MAX_BODY_BYTES", str(16 * 1024 * 1024)))


class BodyLimit:
    """ASGI middleware: rejects request bodies above MAX_BODY_BYTES (with or without Content-Length)."""

    def __init__(self, app, limit: int):
        self.app = app
        self.limit = limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        for k, v in scope.get("headers", []):
            if k == b"content-length" and v.isdigit() and int(v) > self.limit:
                return await self._reject(send)
        seen = 0

        async def limited():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > self.limit:
                    raise _TooLarge()
            return msg

        try:
            await self.app(scope, limited, send)
        except _TooLarge:
            await self._reject(send)

    async def _reject(self, send):
        await send({"type": "http.response.start", "status": 413, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": b'{"detail":"request body too large"}'})


class _TooLarge(Exception):
    pass


REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{8,64}$")
_access = logging.getLogger("resuto.ai.access")
if not _access.handlers:
    _handler = logging.StreamHandler(sys.stderr)
    _handler.setFormatter(logging.Formatter("%(message)s"))
    _access.addHandler(_handler)
    _access.setLevel(logging.INFO)
    _access.propagate = False


class RequestId:
    """ASGI middleware: correlation id + structured access log (audit PS-15).

    The Resuto API forwards its request id as X-Request-Id on every call (API request, outbox handler or job run);
    a well-formed id is kept, anything else is replaced by a new UUID. The id is echoed on the response and written
    with method, path, status and duration as one JSON line on stderr. Bodies are never logged.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        given = next((v.decode("latin-1") for k, v in scope.get("headers", []) if k == b"x-request-id"), "")
        request_id = given if REQUEST_ID_PATTERN.match(given) else str(uuid.uuid4())
        scope.setdefault("state", {})["request_id"] = request_id
        started = time.perf_counter()
        status = {"code": 500}

        async def send_with_id(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
                message = {**message, "headers": [*message.get("headers", []), (b"x-request-id", request_id.encode()),
                                                   (b"x-build", _BUILD_HEADER)]}
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            path = scope.get("path", "")
            if not (path == "/v1/health" and status["code"] < 400):
                _access.info(json.dumps({"requestId": request_id, "method": scope.get("method"), "path": path,
                                         "status": status["code"], "ms": round((time.perf_counter() - started) * 1000, 1)}))


_SHA = re.compile(r"^[0-9a-fA-F]{7,40}$")
_STARTED_AT = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def build_info(env: dict | None = None) -> dict:
    """Deployed commit and build time (audit CR-07). Render sets RENDER_GIT_COMMIT; BUILD_TIME, when the build sets it,
    wins over the modification time of this file (the image build writes it)."""
    env = os.environ if env is None else env
    raw = next((v.strip() for v in (env.get("RENDER_GIT_COMMIT"), env.get("GIT_COMMIT_SHA"), env.get("SOURCE_VERSION"))
                if v and _SHA.match(v.strip())), None)
    commit = raw.lower() if raw else None
    built_at = env.get("BUILD_TIME") or None
    if not built_at:
        try:
            built_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(os.path.getmtime(__file__)))
        except OSError:
            built_at = None
    branch = (env.get("RENDER_GIT_BRANCH") or env.get("GIT_BRANCH") or "").strip()
    return {"commit": commit, "branch": branch if re.match(r"^[\w./-]{1,100}$", branch) else None,
            "builtAt": built_at, "startedAt": _STARTED_AT}


def build_header(info: dict | None = None) -> bytes:
    info = info or build_info()
    return f"ai@{(info['commit'] or 'local')[:12]}".encode()


_BUILD_HEADER = build_header()


def create_app(token: str | None = None, allow_no_auth: bool | None = None) -> FastAPI:
    token = token if token is not None else os.environ.get("AI_SERVICE_TOKEN", "")
    allow = allow_no_auth if allow_no_auth is not None else os.environ.get("AI_SERVICE_ALLOW_NO_AUTH") == "1"
    if not token and not allow:
        raise RuntimeError("AI_SERVICE_TOKEN is required (set AI_SERVICE_ALLOW_NO_AUTH=1 only for local tests)")
    if token and len(token) < 16:
        raise RuntimeError("AI_SERVICE_TOKEN must be at least 16 characters")
    expected = f"Bearer {token}".encode() if token else None

    def require_token(request: Request) -> None:
        if expected is None:
            return
        got = request.headers.get("authorization", "").encode()
        if not hmac.compare_digest(got, expected):
            raise HTTPException(status_code=401, detail="invalid or missing bearer token")

    app = FastAPI(title="Resuto Intelligence", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(BodyLimit, limit=MAX_BODY_BYTES)
    app.add_middleware(RequestId)  # added last = outermost: also ids 413 and 401 responses
    auth = [Depends(require_token)]

    @app.get("/v1/health")
    def health():
        return {"status": "ok", "version": __version__, "auth": expected is not None, "build": build_info(),
                "models": {"forecast": list(fc.MODEL_ORDER), "segment": "rfm_quintiles", "churn": ["logistic_regression", "heuristic"],
                           "recommend": "association_rules+popularity", "routing": "nearest_neighbour+2opt"}}

    @app.post("/v1/forecast/demand", dependencies=auth)
    def forecast_demand(body: ForecastRequest):
        t0 = time.perf_counter()
        cal = fc.Calendar(weekend_days=tuple(body.weekend_days), ramadan=tuple((r.start, r.end) for r in body.ramadan),
                          use_ramadan=body.use_ramadan)
        results = []
        for s in body.series:
            series = fc.build_series(((p.date, p.quantity) for p in s.history), end=body.end)
            r = fc.forecast_series(series, cal, body.horizon, models=body.models, folds=body.folds,
                                   level=body.interval_level, seed=body.seed)
            results.append({"id": s.id, **r})
        return {"results": results, "computationMs": round((time.perf_counter() - t0) * 1000, 2)}

    def _orders(items):
        return [cust.Order(customer_id=o.customer_id, at=o.at if o.at.tzinfo else o.at.replace(tzinfo=timezone.utc),
                           total_minor=o.total_minor) for o in items]

    @app.post("/v1/customers/segment", dependencies=auth)
    def customers_segment(body: SegmentRequest):
        t0 = time.perf_counter()
        r = cust.rfm_segments(_orders(body.orders), body.as_of)
        return {**r, "method": "rfm_quintiles", "computationMs": round((time.perf_counter() - t0) * 1000, 2)}

    @app.post("/v1/customers/churn", dependencies=auth)
    def customers_churn(body: ChurnRequest):
        t0 = time.perf_counter()
        r = cust.churn_scores(_orders(body.orders), body.as_of, window_days=body.window_days, seed=body.seed)
        return {**r, "computationMs": round((time.perf_counter() - t0) * 1000, 2)}

    @app.post("/v1/recommend/items", dependencies=auth)
    def recommend_items(body: RecommendRequest):
        t0 = time.perf_counter()
        model = rec.CooccurrenceModel.from_baskets(b.items for b in body.baskets)
        unavailable = set(body.unavailable)
        weights = body.weights.model_dump() if body.weights else rec.DEFAULT_WEIGHTS
        items = {i: model.associations(i, body.k, exclude=unavailable, min_pair_count=body.min_pair_count) for i in body.items}
        customers = {}
        if body.customers:
            wanted = set(body.customers)
            hist: dict[str, list] = {c: [] for c in body.customers}
            for idx, b in enumerate(body.baskets):
                if b.customer_id in wanted:
                    hist[b.customer_id].append((b.at.timestamp() if b.at else float(idx), b.items))
            for c, hs in hist.items():
                hs.sort(key=lambda x: x[0])
                customers[c] = model.recommend_for_customer([h for _, h in hs], body.k, exclude=unavailable, weights=weights)
        return {
            "method": "association_rules", "weights": weights,
            "items": items, "customers": customers, "popular": model.popular(body.k, exclude=unavailable),
            "stats": {"baskets": model.n_baskets, "distinctItems": len(model.item_count),
                      "pairs": sum(len(v) for v in model.pair_count.values()) // 2},
            "computationMs": round((time.perf_counter() - t0) * 1000, 2),
        }

    @app.post("/v1/routing/optimize", dependencies=auth)
    def routing_optimize(body: RouteRequest):
        problem = rt.Problem(
            start=(body.start.lat, body.start.lng),
            stops=[rt.Stop(id=s.id, lat=s.lat, lng=s.lng, window_start=s.window_start, window_end=s.window_end,
                           service_minutes=s.service_minutes) for s in body.stops],
            depart_at=body.depart_at, speed_kmh=body.speed_kmh, road_factor=body.road_factor, return_to_start=body.return_to_start,
        )
        if body.depart_at is None and any(s.window_end or s.window_start for s in body.stops):
            raise HTTPException(status_code=422, detail="departAt is required when stops have time windows")
        return rt.optimize(problem, body.objective)

    @app.exception_handler(ValueError)
    async def value_error(_: Request, exc: ValueError):
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    return app


def _lazy_app():
    return create_app()


# `uvicorn app.main:app` — created at import so misconfiguration fails at startup.
app = _lazy_app() if os.environ.get("AI_SERVICE_SKIP_IMPORT_APP") != "1" else None
