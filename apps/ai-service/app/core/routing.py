"""Single-driver multi-stop routing: nearest neighbour construction + 2-opt improvement.

Distances are great-circle (haversine) kilometres multiplied by ``road_factor`` (default 1.3, a
common circuity approximation for urban road networks; set 1.0 for straight-line). Travel time is
distance / ``speed_kmh``; each stop adds ``service_minutes``. Time windows are *reported*, not
guaranteed: arriving after ``window_end`` is a violation (lateness in minutes); arriving before
``window_start`` waits until it opens. The objective is total distance (``objective="distance"``)
or total lateness then distance (``objective="lateness"``). The result is compared with the naive
order (the order the stops were supplied in, e.g. order placement time).
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Sequence

EARTH_RADIUS_KM = 6371.0088


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(min(1.0, h)))


@dataclass(frozen=True)
class Stop:
    id: str
    lat: float
    lng: float
    window_start: datetime | None = None
    window_end: datetime | None = None
    service_minutes: float = 3.0


@dataclass(frozen=True)
class Problem:
    start: tuple[float, float]
    stops: Sequence[Stop]
    depart_at: datetime | None = None
    speed_kmh: float = 25.0
    road_factor: float = 1.3
    return_to_start: bool = False

    def matrix(self) -> list[list[float]]:
        pts = [self.start] + [(s.lat, s.lng) for s in self.stops]
        return [[haversine_km(p, q) * self.road_factor for q in pts] for p in pts]


def evaluate(problem: Problem, order: Sequence[int], dist: list[list[float]] | None = None) -> dict:
    """order: indices into problem.stops."""
    d = dist or problem.matrix()
    t = problem.depart_at
    minutes = 0.0
    total = 0.0
    prev = 0
    legs = []
    violations = []
    lateness = 0.0
    for idx in order:
        node = idx + 1
        km = d[prev][node]
        total += km
        travel = km / problem.speed_kmh * 60
        minutes += travel
        stop = problem.stops[idx]
        arrive = t + timedelta(minutes=minutes) if t else None
        wait = 0.0
        if arrive and stop.window_start and arrive < stop.window_start:
            wait = (stop.window_start - arrive).total_seconds() / 60
            minutes += wait
            arrive = stop.window_start
        late = 0.0
        if arrive and stop.window_end and arrive > stop.window_end:
            late = (arrive - stop.window_end).total_seconds() / 60
            lateness += late
            violations.append({"stopId": stop.id, "lateMinutes": round(late, 2)})
        legs.append({"stopId": stop.id, "distanceKm": round(km, 4), "arrivalMinute": round(minutes, 2),
                     "arrivesAt": arrive.isoformat() if arrive else None, "waitMinutes": round(wait, 2), "lateMinutes": round(late, 2)})
        minutes += stop.service_minutes
        prev = node
    if problem.return_to_start and order:
        km = d[prev][0]
        total += km
        minutes += km / problem.speed_kmh * 60
    return {"order": [problem.stops[i].id for i in order], "distanceKm": round(total, 4), "durationMinutes": round(minutes, 2),
            "violations": violations, "totalLatenessMinutes": round(lateness, 2), "legs": legs}


def _cost(problem: Problem, order: Sequence[int], dist, objective: str) -> tuple[float, float]:
    if objective == "lateness":
        r = evaluate(problem, order, dist)
        return (r["totalLatenessMinutes"], r["distanceKm"])
    total, prev = 0.0, 0
    for idx in order:
        total += dist[prev][idx + 1]
        prev = idx + 1
    if problem.return_to_start and order:
        total += dist[prev][0]
    return (0.0, total)


def _better(a: tuple[float, float], b: tuple[float, float], eps: float = 1e-9) -> bool:
    if a[0] < b[0] - eps:
        return True
    return abs(a[0] - b[0]) <= eps and a[1] < b[1] - eps


def nearest_neighbour(problem: Problem, dist) -> list[int]:
    remaining = set(range(len(problem.stops)))
    order, cur = [], 0
    while remaining:
        nxt = min(remaining, key=lambda i: (dist[cur][i + 1], i))
        order.append(nxt)
        remaining.remove(nxt)
        cur = nxt + 1
    return order


def two_opt(problem: Problem, order: list[int], dist, objective: str = "distance", max_passes: int = 50) -> list[int]:
    best = list(order)
    best_cost = _cost(problem, best, dist, objective)
    n = len(best)
    for _ in range(max_passes):
        improved = False
        for i in range(n - 1):
            for j in range(i + 1, n):
                cand = best[:i] + best[i:j + 1][::-1] + best[j + 1:]
                c = _cost(problem, cand, dist, objective)
                if _better(c, best_cost):
                    best, best_cost, improved = cand, c, True
        if not improved:
            break
    return best


def optimize(problem: Problem, objective: str = "distance") -> dict:
    t0 = time.perf_counter()
    dist = problem.matrix()
    naive = list(range(len(problem.stops)))
    nn = nearest_neighbour(problem, dist)
    improved = two_opt(problem, nn, dist, objective)
    elapsed_ms = (time.perf_counter() - t0) * 1000
    best = evaluate(problem, improved, dist)
    base = evaluate(problem, naive, dist)
    nn_eval = evaluate(problem, nn, dist)
    saving = (base["distanceKm"] - best["distanceKm"]) / base["distanceKm"] if base["distanceKm"] > 0 else 0.0
    return {
        "method": "nearest_neighbour+2opt",
        "objective": objective,
        "distanceModel": {"kind": "haversine", "roadFactor": problem.road_factor, "speedKmh": problem.speed_kmh},
        "route": best,
        "nearestNeighbour": {"distanceKm": nn_eval["distanceKm"], "durationMinutes": nn_eval["durationMinutes"], "violations": len(nn_eval["violations"])},
        "naive": {"order": base["order"], "distanceKm": base["distanceKm"], "durationMinutes": base["durationMinutes"],
                  "violations": base["violations"], "totalLatenessMinutes": base["totalLatenessMinutes"]},
        "distanceSavingPct": round(saving * 100, 2),
        "computationMs": round(elapsed_ms, 3),
    }


def brute_force(problem: Problem, objective: str = "distance") -> list[int]:
    """Exact optimum by enumeration (research only; n ≤ 9)."""
    import itertools

    if len(problem.stops) > 9:
        raise ValueError("brute force limited to 9 stops")
    dist = problem.matrix()
    return list(min(itertools.permutations(range(len(problem.stops))), key=lambda p: _cost(problem, p, dist, objective)))
