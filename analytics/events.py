"""Trend events derived by comparing consecutive leaderboard snapshots.

    new_leader   the #1 hashtag changed
    entered_top  a hashtag entered the top TOP_K (5: churn at ranks 9-10 is noise, not news)
    left_top     a hashtag dropped out of the top TOP_K
    surge        trend score crossed SURGE_SCORE (reported once per crossing, not every window)

Events describe what the pipeline detected in the stream. With the demo dataset the
underlying bursts are injected on purpose, so the dashboard labels them as simulated.
"""
SURGE_SCORE = 8.0
TOP_K = 5


def detect(prev_top, cur_top, scored, prev_surging, surge_score=SURGE_SCORE, top_k=TOP_K):
    """prev_top/cur_top: ranked tag lists. Returns (events, surging set for next call)."""
    events = []
    prev_top, cur_top = list(prev_top)[:top_k] if prev_top else prev_top, list(cur_top)[:top_k]
    if prev_top and cur_top and prev_top[0] != cur_top[0]:
        events.append({"kind": "new_leader", "tag": cur_top[0],
                       "detail": {"previous": prev_top[0], "count": scored.get(cur_top[0], {}).get("count")}})
    if prev_top:
        prev_set, cur_set = set(prev_top), set(cur_top)
        for i, t in enumerate(cur_top, start=1):
            if t not in prev_set:
                events.append({"kind": "entered_top", "tag": t,
                               "detail": {"rank": i, "count": scored.get(t, {}).get("count")}})
        for t in prev_top:
            if t not in cur_set:
                events.append({"kind": "left_top", "tag": t,
                               "detail": {"previous_rank": prev_top.index(t) + 1,
                                          "count": scored.get(t, {}).get("count", 0)}})
    surging = {t for t, s in scored.items()
               if s.get("trend_score") is not None and s["trend_score"] >= surge_score}
    for t in sorted(surging - set(prev_surging), key=lambda t: -scored[t]["trend_score"]):
        s = scored[t]
        events.append({"kind": "surge", "tag": t,
                       "detail": {"count": s["count"], "baseline_count": s["baseline_count"],
                                  "growth": s["growth"], "trend_score": s["trend_score"]}})
    return events, surging
