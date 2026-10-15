"""Velocity / burst scoring and trend-event detection.

    python -m unittest discover -s tests -v
"""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from analytics import events  # noqa: E402
from analytics.scoring import (DEFAULT_K, burst_score, find_baseline, growth, rank_by_velocity,  # noqa: E402
                               score_tags, trend_score)

END = 1_700_000_400.0
LOOK = 300  # one 5-minute window


def hist(*entries):
    return [{"end_ts": ts, "total": tot, "counts": c} for ts, tot, c in entries]


class GrowthFormulaTests(unittest.TestCase):
    def test_tiny_counts_are_damped(self):
        self.assertAlmostEqual(growth(2, 1), 1 / (1 + DEFAULT_K))  # 1 -> 2 is not "+100%"
        self.assertIsNone(trend_score(2, 1))                        # and below the volume floor

    def test_zero_baseline_is_finite(self):
        g = growth(100, 0)
        self.assertTrue(math.isfinite(g))
        self.assertAlmostEqual(g, 100 / DEFAULT_K)

    def test_negative_growth(self):
        self.assertLess(growth(50, 200), 0)
        self.assertLess(trend_score(50, 200), 0)

    def test_volume_rewarded(self):
        self.assertGreater(trend_score(100, 0), trend_score(12, 0))

    def test_min_count_threshold(self):
        self.assertIsNone(trend_score(9, 0, min_count=10))
        self.assertIsNotNone(trend_score(10, 0, min_count=10))


class BaselineTests(unittest.TestCase):
    def test_baseline_is_latest_non_overlapping_window(self):
        h = hist((END - 400, 1000, {}), (END - 300, 1000, {}), (END - 60, 1000, {}))
        self.assertEqual(find_baseline(h, END, LOOK)["end_ts"], END - 300)

    def test_no_baseline_without_history(self):
        scored, base_end, scale = score_tags({"a": 50}, [], END, LOOK)
        self.assertIsNone(base_end)
        self.assertIsNone(scale)
        self.assertIsNone(scored["a"]["growth"])
        self.assertIsNone(scored["a"]["trend_score"])

    def test_baseline_scaled_to_stream_volume(self):
        # stream doubled, tag kept its share: no growth
        h = hist((END - 300, 500, {"a": 50}))
        scored, _, scale = score_tags({"a": 100, "__TOTAL__": 1000}, h, END, LOOK, total=1000)
        self.assertEqual(scale, 2.0)
        self.assertEqual(scored["a"]["baseline_count"], 100)
        self.assertEqual(scored["a"]["growth"], 0)

    def test_incomparable_baseline_rejected(self):
        # a nearly empty warm-up window must not become a baseline
        h = hist((END - 300, 40, {"a": 1}))
        scored, base_end, _ = score_tags({"a": 100}, h, END, LOOK, total=1000)
        self.assertIsNone(base_end)
        self.assertIsNone(scored["a"]["trend_score"])

    def test_internal_keys_ignored(self):
        scored, _, _ = score_tags({"a": 20, "__TOTAL__": 99, "__SENT__|positive": 5}, [], END, LOOK)
        self.assertEqual(set(scored), {"a"})


class RankingTests(unittest.TestCase):
    def test_velocity_ranking_prefers_growth_and_breaks_ties(self):
        h = hist((END - 300, 1000, {"steady": 500, "riser": 10, "b": 0, "a": 0}))
        counts = {"steady": 500, "riser": 300, "b": 40, "a": 40, "tiny": 3}
        scored, _, _ = score_tags(counts, h, END, LOOK, total=1000)
        ranked = [t for t, _ in rank_by_velocity(scored, 10)]
        self.assertEqual(ranked[0], "riser")
        self.assertLess(ranked.index("a"), ranked.index("b"))  # equal scores: alphabetical
        self.assertNotIn("tiny", ranked)                        # below min volume
        self.assertEqual(ranked[-1], "steady")                  # no growth sorts last

    def test_burst_needs_history(self):
        self.assertIsNone(burst_score(100, [1, 2, 3]))
        self.assertGreater(burst_score(100, [10, 12, 9, 11, 10]), 10)


class EventTests(unittest.TestCase):
    def scored(self, **counts):
        return {t: {"count": c, "trend_score": s, "baseline_count": 0, "growth": 1.0}
                for t, (c, s) in counts.items()}

    def test_leader_and_top5_changes(self):
        prev = ["a", "b", "c", "d", "e", "f"]
        cur = ["f", "a", "b", "c", "d", "e"]
        found, _ = events.detect(prev, cur, self.scored(f=(10, 1.0)), [])
        kinds = {(e["kind"], e["tag"]) for e in found}
        self.assertIn(("new_leader", "f"), kinds)
        self.assertIn(("entered_top", "f"), kinds)
        self.assertIn(("left_top", "e"), kinds)            # pushed from #5 to #6
        self.assertNotIn(("entered_top", "a"), kinds)

    def test_churn_below_top5_is_not_an_event(self):
        prev = ["a", "b", "c", "d", "e", "f", "g"]
        cur = ["a", "b", "c", "d", "e", "g", "f"]
        found, _ = events.detect(prev, cur, {}, [])
        self.assertEqual(found, [])

    def test_surge_reported_once_per_crossing(self):
        s = self.scored(x=(500, 50.0))
        first, surging = events.detect(["x"], ["x"], s, [])
        again, surging = events.detect(["x"], ["x"], s, surging)
        self.assertEqual([e["kind"] for e in first], ["surge"])
        self.assertEqual(again, [])
        calm, surging = events.detect(["x"], ["x"], self.scored(x=(500, 1.0)), surging)
        back, _ = events.detect(["x"], ["x"], s, surging)
        self.assertEqual([e["kind"] for e in back], ["surge"])

    def test_first_snapshot_has_no_events(self):
        found, _ = events.detect([], ["a", "b"], {}, [])
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main()
