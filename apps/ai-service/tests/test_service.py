"""HTTP-level tests: auth, limits, and one happy path per endpoint."""
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pytest

from app.main import create_app


def weekly_series(days=200, seed=7, start=date(2025, 1, 1)):
    rng = np.random.default_rng(seed)
    out = []
    for i in range(days):
        d = start + timedelta(days=i)
        base = 20 + (12 if d.weekday() in (3, 4) else 0) + (6 if d.weekday() == 5 else 0)
        out.append({"date": d.isoformat(), "quantity": float(rng.poisson(base))})
    return out


def test_health_is_public(client):
    r = client.get("/v1/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert r.json()["auth"] is True


@pytest.mark.parametrize("header", [None, "Bearer wrong-token-0000000000", "test-token-0123456789abcdef"])
def test_rejects_missing_or_wrong_token(client, header):
    headers = {"Authorization": header} if header else {}
    r = client.post("/v1/routing/optimize", json={"start": {"lat": 30, "lng": 31}, "stops": [{"id": "a", "lat": 30.01, "lng": 31}]}, headers=headers)
    assert r.status_code == 401


def test_refuses_to_start_without_token(monkeypatch):
    monkeypatch.delenv("AI_SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("AI_SERVICE_ALLOW_NO_AUTH", raising=False)
    with pytest.raises(RuntimeError, match="AI_SERVICE_TOKEN is required"):
        create_app()
    with pytest.raises(RuntimeError, match="at least 16"):
        create_app(token="short")
    assert create_app(token="", allow_no_auth=True) is not None


def test_rejects_oversized_bodies(client, auth):
    from app import main

    big = "x" * (main.MAX_BODY_BYTES + 10)
    r = client.post("/v1/forecast/demand", content=big, headers={**auth, "content-type": "application/json"})
    assert r.status_code == 413


def test_validation_limits(client, auth):
    r = client.post("/v1/forecast/demand", json={"series": [{"id": "p1", "history": weekly_series(30)}], "horizon": 60}, headers=auth)
    assert r.status_code == 422
    r = client.post("/v1/forecast/demand", json={"series": [{"id": "p1", "history": weekly_series(30)}], "weekendDays": [9]}, headers=auth)
    assert r.status_code == 422
    r = client.post("/v1/recommend/items", json={"baskets": [{"items": []}]}, headers=auth)
    assert r.status_code == 422
    r = client.post("/v1/routing/optimize", json={"start": {"lat": 30, "lng": 31}, "stops": []}, headers=auth)
    assert r.status_code == 422
    r = client.post("/v1/customers/segment", json={"orders": [], "asOf": "2025-01-01T00:00:00Z", "name": "x"}, headers=auth)
    assert r.status_code == 422  # unknown fields (e.g. personal data) are rejected


def test_forecast_endpoint(client, auth):
    body = {"series": [{"id": "p1", "history": weekly_series(200)}], "horizon": 14, "seed": 42}
    r = client.post("/v1/forecast/demand", json=body, headers=auth)
    assert r.status_code == 200, r.text
    res = r.json()["results"][0]
    assert res["id"] == "p1"
    assert len(res["forecast"]) == 14
    assert res["model"] in {"seasonal_naive_7", "moving_average_28", "hist_gbm"}
    assert {c["model"] for c in res["candidates"]} == {"seasonal_naive_7", "moving_average_28", "hist_gbm"}
    assert all(c["metrics"]["wape"] is not None for c in res["candidates"])
    for p in res["forecast"]:
        assert 0 <= p["lower"] <= p["yhat"] <= p["upper"]
    # Fri/Sat weekend
    first = date.fromisoformat(res["forecast"][0]["date"])
    assert first == date(2025, 1, 1) + timedelta(days=200)
    assert all(p["isWeekend"] == (date.fromisoformat(p["date"]).weekday() in (4, 5)) for p in res["forecast"])
    # deterministic
    again = client.post("/v1/forecast/demand", json=body, headers=auth).json()["results"][0]
    assert again["forecast"] == res["forecast"]


def test_segment_churn_recommend_routing_endpoints(client, auth):
    as_of = "2025-06-30T12:00:00Z"
    orders = [{"customerId": f"c{i}", "at": f"2025-06-{(i % 28) + 1:02d}T12:00:00Z", "totalMinor": 1000 * (i + 1)} for i in range(20)]
    r = client.post("/v1/customers/segment", json={"orders": orders, "asOf": as_of}, headers=auth)
    assert r.status_code == 200
    assert sum(r.json()["segments"].values()) == 20

    r = client.post("/v1/customers/churn", json={"orders": orders, "asOf": as_of}, headers=auth)
    assert r.status_code == 200
    assert r.json()["method"] == "heuristic" and r.json()["isHeuristic"] is True

    baskets = [{"items": ["burger", "fries"]}] * 5 + [{"items": ["burger", "soda"]}] * 2 + [{"items": ["salad"]}]
    r = client.post("/v1/recommend/items", json={"baskets": baskets, "items": ["burger"], "unavailable": ["soda"], "k": 3}, headers=auth)
    assert r.status_code == 200
    recs = r.json()["items"]["burger"]
    assert recs[0]["itemId"] == "fries" and recs[0]["source"] == "association"
    assert all(x["itemId"] != "soda" for x in recs)

    stops = [{"id": "far", "lat": 30.10, "lng": 31.0}, {"id": "near", "lat": 30.01, "lng": 31.0}, {"id": "mid", "lat": 30.05, "lng": 31.0}]
    r = client.post("/v1/routing/optimize", json={"start": {"lat": 30.0, "lng": 31.0}, "stops": stops}, headers=auth)
    assert r.status_code == 200
    j = r.json()
    assert j["route"]["order"] == ["near", "mid", "far"]
    assert j["route"]["distanceKm"] <= j["naive"]["distanceKm"]
    assert j["computationMs"] >= 0

    r = client.post("/v1/routing/optimize", json={"start": {"lat": 30.0, "lng": 31.0},
                                                  "stops": [{**stops[0], "windowEnd": "2025-06-30T12:00:00Z"}]}, headers=auth)
    assert r.status_code == 422  # windows need departAt


def test_request_id_is_kept_or_generated_and_logged(client, auth):
    import logging
    records = []

    class Keep(logging.Handler):
        def emit(self, record):
            records.append(record.getMessage())

    keep = Keep()
    logging.getLogger("resuto.ai.access").addHandler(keep)
    try:
        _request_id_calls(client, auth)
    finally:
        logging.getLogger("resuto.ai.access").removeHandler(keep)
    import json as _json
    entries = [_json.loads(m) for m in records]
    logged = {(e["requestId"], e["status"]) for e in entries}
    assert ("evt:route-check-0001", 200) in logged
    assert ("job:denied-0000001", 401) in logged
    assert not any(e["path"] == "/v1/health" for e in entries)


def _request_id_calls(client, auth):
    r = client.get("/v1/health", headers={"X-Request-Id": "api-req-12345678"})
    assert r.headers["x-request-id"] == "api-req-12345678"
    r = client.get("/v1/health", headers={"X-Request-Id": "bad id <script>"})
    assert r.headers["x-request-id"] != "bad id <script>"
    assert len(r.headers["x-request-id"]) == 36
    body = {"start": {"lat": 30, "lng": 31}, "stops": [{"id": "a", "lat": 30.01, "lng": 31}]}
    r = client.post("/v1/routing/optimize", json=body, headers={**auth, "X-Request-Id": "evt:route-check-0001"})
    assert r.status_code == 200
    assert r.headers["x-request-id"] == "evt:route-check-0001"
    denied = client.post("/v1/routing/optimize", json=body, headers={"X-Request-Id": "job:denied-0000001"})
    assert denied.status_code == 401 and denied.headers["x-request-id"] == "job:denied-0000001"
