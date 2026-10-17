"""Basket recommendations: item-to-item association rules with a popularity fallback, and a
per-customer next-basket scorer.

Association rules (Agrawal et al., 1993) over baskets (one order = one basket, items de-duplicated):

* ``support(A)      = baskets containing A / all baskets``
* ``confidence(A→B) = baskets containing A and B / baskets containing A``
* ``lift(A→B)       = confidence(A→B) / support(B)``

"Frequently bought with A" ranks B by confidence, then lift, keeping pairs seen at least
``min_pair_count`` times. When fewer than ``k`` rules qualify, the list is filled with the most
popular items (``source="popularity"``). Items the caller marks unavailable are never returned.

Customer next-basket score for item *j* (weights chosen on a validation split in
``research/recommendations``; see that README):

``score(j) = w_personal · share of the customer's past baskets containing j
           + w_assoc · mean confidence(i→j) over items i in the customer's latest basket
           + w_pop · support(j)``
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Iterable, Sequence

# Chosen by grid search on the validation split (second-to-last basket) of the synthetic
# research dataset — research/recommendations/results/<run-id>/metrics.json, "selectedWeights".
DEFAULT_WEIGHTS = {"personal": 0.6, "assoc": 0.3, "pop": 0.1}


class CooccurrenceModel:
    def __init__(self) -> None:
        self.n_baskets = 0
        self.item_count: Counter[str] = Counter()
        self.pair_count: dict[str, Counter[str]] = defaultdict(Counter)

    def add_basket(self, items: Iterable[str]) -> None:
        uniq = sorted(set(items))
        if not uniq:
            return
        self.n_baskets += 1
        for i in uniq:
            self.item_count[i] += 1
        for a in uniq:
            row = self.pair_count[a]
            for b in uniq:
                if a != b:
                    row[b] += 1

    @classmethod
    def from_baskets(cls, baskets: Iterable[Iterable[str]]) -> "CooccurrenceModel":
        m = cls()
        for b in baskets:
            m.add_basket(b)
        return m

    def support(self, item: str) -> float:
        return self.item_count[item] / self.n_baskets if self.n_baskets else 0.0

    def confidence(self, a: str, b: str) -> float:
        ca = self.item_count[a]
        return self.pair_count[a][b] / ca if ca else 0.0

    def popular(self, k: int, exclude: set[str] = frozenset()) -> list[dict]:
        ranked = sorted(self.item_count.items(), key=lambda kv: (-kv[1], kv[0]))
        out = []
        for item, c in ranked:
            if item in exclude:
                continue
            out.append({"itemId": item, "support": round(c / self.n_baskets, 6), "count": c, "source": "popularity"})
            if len(out) >= k:
                break
        return out

    def associations(self, item: str, k: int, exclude: set[str] = frozenset(), min_pair_count: int = 2) -> list[dict]:
        rules = []
        for b, c in self.pair_count.get(item, {}).items():
            if c < min_pair_count or b in exclude or b == item:
                continue
            conf = self.confidence(item, b)
            sup_b = self.support(b)
            rules.append({
                "itemId": b, "pairCount": c, "support": round(c / self.n_baskets, 6), "confidence": round(conf, 6),
                "lift": round(conf / sup_b, 6) if sup_b else None, "source": "association",
            })
        rules.sort(key=lambda r: (-r["confidence"], -(r["lift"] or 0), r["itemId"]))
        rules = rules[:k]
        if len(rules) < k:
            taken = {r["itemId"] for r in rules} | set(exclude) | {item}
            rules += self.popular(k - len(rules), exclude=taken)
        return rules

    # -- customer next-basket ------------------------------------------------
    def customer_scores(self, history: Sequence[Iterable[str]], weights: dict[str, float] = DEFAULT_WEIGHTS) -> dict[str, float]:
        hist = [set(b) for b in history if b]
        scores: dict[str, float] = defaultdict(float)
        if weights.get("pop") and self.n_baskets:
            for item, c in self.item_count.items():
                scores[item] += weights["pop"] * c / self.n_baskets
        if hist and weights.get("personal"):
            share = Counter(i for b in hist for i in b)
            for item, c in share.items():
                scores[item] += weights["personal"] * c / len(hist)
        if hist and weights.get("assoc"):
            last = hist[-1]
            acc: dict[str, float] = defaultdict(float)
            for i in last:
                ci = self.item_count[i]
                if not ci:
                    continue
                for j, c in self.pair_count.get(i, {}).items():
                    acc[j] += c / ci
            for j, v in acc.items():
                scores[j] += weights["assoc"] * v / len(last)
        return scores

    def recommend_for_customer(self, history: Sequence[Iterable[str]], k: int, exclude: set[str] = frozenset(),
                               weights: dict[str, float] = DEFAULT_WEIGHTS) -> list[dict]:
        scores = self.customer_scores(history, weights)
        ranked = sorted(((j, s) for j, s in scores.items() if j not in exclude), key=lambda kv: (-kv[1], kv[0]))[:k]
        out = [{"itemId": j, "score": round(s, 6), "source": "hybrid"} for j, s in ranked]
        if len(out) < k:
            taken = {r["itemId"] for r in out} | set(exclude)
            out += [{"itemId": p["itemId"], "score": 0.0, "source": "popularity"} for p in self.popular(k - len(out), exclude=taken)]
        return out


def rank_items(scores: dict[str, float], k: int, exclude: set[str] = frozenset()) -> list[str]:
    return [j for j, _ in sorted(((j, s) for j, s in scores.items() if j not in exclude), key=lambda kv: (-kv[1], kv[0]))[:k]]
