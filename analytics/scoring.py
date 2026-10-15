"""Trend scoring on top of the MapReduce hashtag counts.

Volume ranking (the academic baseline) is just "highest count in the 5-minute window".
Velocity ranking answers a different question: which hashtags are GROWING fastest?

    growth      g = (c - p) / (p + k)
    trend score s = g * log2(1 + c)        (only when c >= min_count)

    c = count in the current window
    p = count in the comparable baseline window, scaled to the current stream volume:
        p = p_raw * (T_now / T_base), T = tweets in the window. The baseline is the most
        recent snapshot whose window ended at least `lookback` seconds earlier (default:
        one full window, so the two windows do not overlap). The volume scaling stops a
        tag from "surging" only because the whole stream got busier (e.g. while the first
        window is still filling up, or when the producer rate changes). A baseline must be
        comparable: it needs at least MIN_BASELINE_RATIO of the current window's tweets,
        otherwise there is no baseline (and no velocity) yet - scaling up a nearly empty
        window would turn noise into "surges".
    k = smoothing constant (default 20): damps tiny baselines, so 1 -> 2 mentions gives
        g = 0.05, not +100%
    log2(1 + c) rewards absolute activity, so 0 -> 100 outranks 0 -> 12

Burst score (heuristic, needs >= MIN_BURST_OBS earlier snapshots):

    z = (c - mean) / (std + 1)

over the hashtag's counts in earlier snapshots. Consecutive windows overlap, so the
observations are correlated: this is a ranking heuristic, NOT a significance test.
"""
import math
import statistics

DEFAULT_K = 20.0
MIN_BASELINE_RATIO = 0.5
DEFAULT_MIN_COUNT = 10
MIN_BURST_OBS = 5
BURST_LOOKBACK = 10  # earlier snapshots used for mean/std


def is_tag(key):
    return not key.startswith("__")


def find_baseline(history, end_ts, lookback, total=None):
    """Latest history entry whose window ended >= lookback seconds before end_ts.

    With `total` given, it must also be comparable (see MIN_BASELINE_RATIO); entries
    without a recorded total are accepted as they are (older leaderboard files).
    """
    best = None
    for h in history:
        if h["end_ts"] <= end_ts - lookback and (best is None or h["end_ts"] > best["end_ts"]):
            best = h
    if best is not None and total and "total" in best and best["total"] < MIN_BASELINE_RATIO * total:
        return None
    return best


def growth(c, p, k=DEFAULT_K):
    return (c - p) / (p + k)


def trend_score(c, p, k=DEFAULT_K, min_count=DEFAULT_MIN_COUNT):
    """Returns None when the hashtag is below the minimum-volume threshold."""
    if c < min_count:
        return None
    return growth(c, p, k) * math.log2(1 + c)


def burst_score(c, earlier):
    if len(earlier) < MIN_BURST_OBS:
        return None
    mean = statistics.fmean(earlier)
    std = statistics.pstdev(earlier)
    return (c - mean) / (std + 1.0)


def score_tags(counts, history, end_ts, lookback, k=DEFAULT_K, min_count=DEFAULT_MIN_COUNT, total=None):
    """Velocity components for every hashtag in `counts`.

    `history` holds earlier snapshots only: [{"end_ts": float, "counts": {tag: n}, "total": n}].
    A tag missing from a stored snapshot counts as 0 there. Without totals on both sides the
    baseline is used unscaled.
    """
    base = find_baseline(history, end_ts, lookback, total)
    scale = 1.0
    if base and total and base.get("total"):
        scale = total / base["total"]
    earlier = sorted((h for h in history if h["end_ts"] < end_ts), key=lambda h: h["end_ts"])
    earlier = earlier[-BURST_LOOKBACK:]
    out = {}
    for tag, c in counts.items():
        if not is_tag(tag):
            continue
        p = base["counts"].get(tag, 0) * scale if base else None
        out[tag] = {
            "count": c,
            "baseline_count": None if p is None else round(p, 2),
            "growth": None if p is None else round(growth(c, p, k), 4),
            "trend_score": None if p is None else _round(trend_score(c, p, k, min_count)),
            "burst_score": _round(burst_score(c, [h["counts"].get(tag, 0) for h in earlier])),
            "eligible": c >= min_count,
        }
    return out, (base["end_ts"] if base else None), (round(scale, 4) if base else None)


def rank_by_velocity(scored, n):
    """Eligible tags with a baseline, highest trend score first, ties alphabetical."""
    items = [(t, s) for t, s in scored.items() if s["trend_score"] is not None]
    items.sort(key=lambda x: (-x[1]["trend_score"], -x[1]["count"], x[0]))
    return items[:n]


def _round(x):
    return None if x is None else round(x, 4)
