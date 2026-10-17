"""Model-level tests with deterministic seeds."""
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pytest

from app.core import customers as cust
from app.core import forecast as fc
from app.core import metrics as mt
from app.core import recommend as rec
from app.core import routing as rt


# ---------------------------------------------------------------------------
# metrics
# ---------------------------------------------------------------------------
def test_forecast_metrics_values():
    m = mt.forecast_metrics([10, 0, 5], [8, 1, 5])
    assert m["mae"] == pytest.approx(1.0)
    assert m["rmse"] == pytest.approx(np.sqrt(5 / 3))
    assert m["wape"] == pytest.approx(3 / 15)
    assert mt.wape([0, 0], [1, 1]) is None


def test_ranking_metrics_values():
    ranked = ["a", "b", "c"]
    rel = {"b", "d"}
    assert mt.precision_at_k(ranked, rel, 2) == 0.5
    assert mt.recall_at_k(ranked, rel, 3) == 0.5
    assert mt.ndcg_at_k(ranked, rel, 3) == pytest.approx((1 / np.log2(3)) / (1 + 1 / np.log2(3)))
    assert mt.ndcg_at_k(["b", "d"], rel, 2) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# forecasting
# ---------------------------------------------------------------------------
def make_series(days, seed=1, ramadan=(), start=date(2024, 1, 1)):
    rng = np.random.default_rng(seed)
    pts = []
    for i in range(days):
        d = start + timedelta(days=i)
        lam = 30 + (15 if d.weekday() in (3, 4) else 0)
        if any(a <= d <= b for a, b in ramadan):
            lam *= 0.4
        pts.append((d, float(rng.poisson(lam))))
    return pts


def test_build_series_fills_missing_days_with_zero():
    s = fc.build_series([(date(2025, 1, 1), 3), (date(2025, 1, 4), 2), (date(2025, 1, 4), 1)], end=date(2025, 1, 6))
    assert s.y.tolist() == [3, 0, 0, 3, 0, 0]
    assert s.end == date(2025, 1, 6)


def test_seasonal_naive_repeats_last_week():
    s = fc.build_series([(date(2025, 1, 1) + timedelta(days=i), i % 7) for i in range(21)])
    assert fc.fit_predict("seasonal_naive_7", s, fc.Calendar(), 9).tolist() == [0, 1, 2, 3, 4, 5, 6, 0, 1]


def test_short_history_falls_back_to_baseline_with_reason():
    s = fc.build_series(make_series(45))
    r = fc.forecast_series(s, fc.Calendar(), 7)
    assert r["model"] in ("seasonal_naive_7", "moving_average_28")
    assert r["fallbackReason"].startswith("history_too_short")
    gbm = next(c for c in r["candidates"] if c["model"] == "hist_gbm")
    assert gbm["metrics"] is None and gbm["excluded"]


def test_very_short_history_has_no_backtest():
    s = fc.build_series(make_series(10))
    r = fc.forecast_series(s, fc.Calendar(), 7)
    assert r["backtest"]["folds"] == 0
    assert r["fallbackReason"].startswith("insufficient_history_for_backtest")
    assert r["interval"]["method"] == "poisson_normal_approximation"
    assert len(r["forecast"]) == 7


def test_gbm_is_candidate_with_long_history_and_is_deterministic():
    s = fc.build_series(make_series(220))
    a = fc.forecast_series(s, fc.Calendar(), 14, seed=3)
    b = fc.forecast_series(s, fc.Calendar(), 14, seed=3)
    assert a == b
    gbm = next(c for c in a["candidates"] if c["model"] == "hist_gbm")
    assert gbm["metrics"]["n"] == 14 * 3
    assert a["interval"]["method"] == "empirical_backtest_residuals"
    # the selected model has the lowest backtest WAPE
    best = min((c for c in a["candidates"] if c["metrics"]), key=lambda c: c["metrics"]["wape"])
    assert a["model"] == best["model"]


def test_backtest_uses_only_past_data():
    """Changing values after the last fold's window cannot change any backtest metric, and changing
    values inside the evaluation windows never changes the fitted predictions of earlier folds."""
    pts = make_series(150)
    s1 = fc.build_series(pts)
    bt1 = fc.backtest(s1, fc.Calendar(), 7, ["seasonal_naive_7", "moving_average_28"], folds=2)
    o_last = len(s1.y) - 7
    y2 = s1.y.copy()
    y2[o_last:] += 1000  # perturb only the final evaluation window
    s2 = fc.Series(start=s1.start, y=y2)
    bt2 = fc.backtest(s2, fc.Calendar(), 7, ["seasonal_naive_7", "moving_average_28"], folds=2)
    # fold-1 residuals (first 7) identical; fold-2 actuals shift by exactly +1000 with identical predictions
    for m in ("seasonal_naive_7", "moving_average_28"):
        assert np.allclose(bt1.residuals[m][:7], bt2.residuals[m][:7])
        assert np.allclose(bt2.residuals[m][7:] - bt1.residuals[m][7:], 1000)


def test_ramadan_flag_helps_gbm_on_ramadan_window():
    ram = ((date(2024, 3, 11), date(2024, 4, 9)), (date(2025, 3, 1), date(2025, 3, 29)))
    pts = make_series(456, seed=5, ramadan=ram)  # 2024-01-01 .. 2025-03-31
    s = fc.build_series(pts)
    origin = (date(2025, 3, 8) - s.start).days
    train = fc.Series(start=s.start, y=s.y[:origin])
    actual = s.y[origin:origin + 14]
    with_flag = fc.fit_predict("hist_gbm", train, fc.Calendar(ramadan=ram), 14)
    without = fc.fit_predict("hist_gbm", train, fc.Calendar(ramadan=ram, use_ramadan=False), 14)
    assert mt.mae(actual, with_flag) < mt.mae(actual, without)


def test_weekend_flag_uses_friday_saturday():
    cal = fc.Calendar()
    assert cal.is_weekend(date(2025, 10, 17)) == 1  # Friday
    assert cal.is_weekend(date(2025, 10, 18)) == 1  # Saturday
    assert cal.is_weekend(date(2025, 10, 19)) == 0  # Sunday (working day in EG/SA)


# ---------------------------------------------------------------------------
# customers
# ---------------------------------------------------------------------------
NOW = datetime(2025, 6, 30, 12, tzinfo=timezone.utc)


def orders_for(cid, days_ago, amount):
    return [cust.Order(cid, NOW - timedelta(days=d), amount) for d in days_ago]


def test_quintile_scores_share_ties():
    s = cust.quintile_scores([1, 1, 1, 5, 10])
    assert s[0] == s[1] == s[2]
    assert s[4] == 5
    assert cust.quintile_scores([3]).tolist() == [3]


def test_rfm_segments_named_rules():
    orders = []
    orders += orders_for("champ", [1, 5, 9, 14, 20, 26, 33, 40], 50000)
    orders += orders_for("new", [3], 8000)
    orders += orders_for("sleepy", [300], 1000)
    orders += orders_for("risk", [150, 160, 170, 180, 190, 200], 40000)
    for i in range(10):
        orders += orders_for(f"mid{i}", [40 + i * 5, 80 + i * 5], 10000 + i * 500)
    r = cust.rfm_segments(orders, NOW)
    seg = {c["customerId"]: c["segment"] for c in r["customers"]}
    assert seg["champ"] == "champions"
    assert seg["new"] == "new"
    assert seg["sleepy"] == "hibernating"
    assert seg["risk"] == "at_risk"
    assert sum(r["segments"].values()) == 14


def synthetic_churn_orders(n=400, seed=11):
    rng = np.random.default_rng(seed)
    orders = []
    for i in range(n):
        rate = rng.gamma(2.0, 1 / 20)  # orders per day
        churn_day = rng.uniform(0, 365) if rng.random() < 0.45 else 10**9
        t = rng.uniform(0, 60)
        while t < 365:
            if t > churn_day:
                break
            orders.append(cust.Order(f"c{i}", NOW - timedelta(days=365 - t), int(rng.integers(5000, 30000))))
            t += rng.exponential(1 / rate)
    return orders


def test_churn_logistic_regression_when_labels_derivable():
    r = cust.churn_scores(synthetic_churn_orders(), NOW, window_days=60, seed=42)
    assert r["method"] == "logistic_regression"
    assert r["evaluation"]["rocAuc"] > 0.6
    assert r["labelCohort"]["churned"] >= cust.MIN_CLASS
    risks = [c["risk"] for c in r["customers"]]
    assert risks == sorted(risks, reverse=True)
    again = cust.churn_scores(synthetic_churn_orders(), NOW, window_days=60, seed=42)
    assert again["customers"] == r["customers"]


def test_churn_heuristic_is_flagged():
    orders = orders_for("a", [1, 10, 20], 1000) + orders_for("b", [200], 1000)
    r = cust.churn_scores(orders, NOW)
    assert r["method"] == "heuristic" and r["isHeuristic"]
    assert r["reason"].startswith("labels_not_derivable")
    risk = {c["customerId"]: c["risk"] for c in r["customers"]}
    assert risk["b"] > risk["a"]


# ---------------------------------------------------------------------------
# recommendations
# ---------------------------------------------------------------------------
def test_association_rule_values():
    m = rec.CooccurrenceModel.from_baskets([["a", "b"], ["a", "b"], ["a", "c"], ["b"], ["d"]])
    rules = m.associations("a", 3, min_pair_count=1)
    top = rules[0]
    assert top["itemId"] == "b"
    assert top["confidence"] == pytest.approx(2 / 3)
    assert top["lift"] == pytest.approx((2 / 3) / (3 / 5))
    assert top["support"] == pytest.approx(2 / 5)
    # min pair count filters 'c'; fallback fills with popularity
    rules = m.associations("a", 3, min_pair_count=2)
    assert [r["source"] for r in rules] == ["association", "popularity", "popularity"]
    assert "a" not in [r["itemId"] for r in rules]


def test_unavailable_items_never_recommended():
    m = rec.CooccurrenceModel.from_baskets([["a", "b"], ["a", "b"], ["a", "c"]])
    assert all(r["itemId"] != "b" for r in m.associations("a", 5, exclude={"b"}, min_pair_count=1))
    assert all(r["itemId"] != "b" for r in m.recommend_for_customer([["a", "b"]], 5, exclude={"b"}))


def test_customer_recommendations_prefer_personal_history():
    m = rec.CooccurrenceModel.from_baskets([["a", "b"]] * 10 + [["x"]] * 3)
    recs = m.recommend_for_customer([["x"], ["x"]], 2)
    assert recs[0]["itemId"] == "x"


# ---------------------------------------------------------------------------
# routing
# ---------------------------------------------------------------------------
def random_problem(n, seed, windows=False):
    rng = np.random.default_rng(seed)
    depart = datetime(2025, 6, 1, 19, tzinfo=timezone.utc)
    stops = [rt.Stop(id=f"s{i}", lat=30.0 + rng.uniform(-0.05, 0.05), lng=31.2 + rng.uniform(-0.05, 0.05),
                     window_end=depart + timedelta(minutes=float(rng.uniform(15, 60))) if windows else None) for i in range(n)]
    return rt.Problem(start=(30.0, 31.2), stops=stops, depart_at=depart)


def test_haversine_known_distance():
    # Cairo (Tahrir) to Giza pyramids ≈ 12.7 km great-circle
    assert rt.haversine_km((30.0444, 31.2357), (29.9792, 31.1342)) == pytest.approx(12.3, abs=0.6)


@pytest.mark.parametrize("seed", [1, 2, 3, 4, 5])
def test_two_opt_never_worse_than_naive_and_near_optimal(seed):
    p = random_problem(7, seed)
    r = rt.optimize(p)
    assert r["route"]["distanceKm"] <= r["naive"]["distanceKm"] + 1e-9
    assert r["route"]["distanceKm"] <= r["nearestNeighbour"]["distanceKm"] + 1e-9
    opt = rt.evaluate(p, rt.brute_force(p))
    assert r["route"]["distanceKm"] <= opt["distanceKm"] * 1.10  # within 10 % of optimum on 7 stops
    assert sorted(r["route"]["order"]) == sorted(s.id for s in p.stops)


def test_time_window_violations_reported_and_lateness_objective():
    p = random_problem(8, 9, windows=True)
    dist_r = rt.optimize(p, "distance")
    late_r = rt.optimize(p, "lateness")
    assert late_r["route"]["totalLatenessMinutes"] <= dist_r["route"]["totalLatenessMinutes"] + 1e-9
    for v in dist_r["route"]["violations"]:
        assert v["lateMinutes"] > 0
    # deterministic apart from the measured computation time
    a, b = rt.optimize(p), rt.optimize(p)
    a.pop("computationMs"), b.pop("computationMs")
    assert a == b
