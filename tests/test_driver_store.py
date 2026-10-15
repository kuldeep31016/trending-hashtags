"""Sentiment aggregation, snapshot persistence, driver retries and leaderboard safety.

No Kafka or Hadoop needed: MapReduce runs through the local map -> sort -> reduce pipe.
"""
import argparse
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from analytics.store import Store  # noqa: E402
from common import LocalStorage, minute_key  # noqa: E402
from driver import sliding_window as sw  # noqa: E402
from mapreduce.runner import JobFailed, NoInput, run_local  # noqa: E402

BASE = 1_700_000_040


def put(storage, ts, recs, name="part-0.jsonl"):
    storage.put(minute_key(ts), name, ("\n".join(json.dumps(r) for r in recs) + "\n").encode())


class SentimentAggregationTests(unittest.TestCase):
    def test_labels_counted_and_invalid_labels_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            s = LocalStorage(d)
            put(s, BASE, [
                {"text": "great #Alpha", "sentiment": "positive"},
                {"text": "meh #alpha #beta", "sentiment": "Neutral"},     # case-insensitive
                {"text": "bad #beta", "sentiment": "negative"},
                {"text": "odd #beta", "sentiment": "angry"},         # unknown label
                {"text": "none #beta"},                              # missing label
                {"text": "num #beta", "sentiment": 4},               # wrong type
            ])
            counts = run_local(s, [minute_key(BASE)])
        tags, overall, per_tag = sw.split_counts(counts)
        self.assertEqual(tags, {"alpha": 2, "beta": 5})
        self.assertEqual(overall, {"positive": 1, "neutral": 1, "negative": 1, "labeled": 3, "unlabeled": 3})
        self.assertEqual(per_tag["alpha"], {"positive": 1, "neutral": 1, "negative": 0})
        self.assertEqual(per_tag["beta"], {"positive": 0, "neutral": 1, "negative": 1})

    def test_no_labels_means_unavailable(self):
        _, overall, per_tag = sw.split_counts({"__TOTAL__": 3, "a": 2})
        self.assertIsNone(overall)
        self.assertEqual(per_tag, {})

    def test_sentiment_keys_never_rank(self):
        top = sw.top_n({"a": 1, "__SENT__|positive": 99, "__TS__|a|positive": 99, "__TOTAL__": 9}, 5)
        self.assertEqual(top, [("a", 1)])


class LeaderboardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "lb.json")
        self.store = Store(os.path.join(self.tmp.name, "t.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def counts(self, **tags):
        return {"__TOTAL__": 1000, **tags}

    def test_snapshots_persist_and_query(self):
        for i in range(3):
            sw.update_leaderboard(self.out, self.counts(a=100 + i, b=50), BASE + 60 * i, 5, 10,
                                  job_secs=1.5, source="hadoop", store=self.store)
        snaps, series = self.store.tag_series("hadoop", ["a", "zzz"])
        self.assertEqual(len(snaps), 3)
        self.assertEqual([p[1] for p in series["a"]], [100, 101, 102])
        self.assertEqual([p[1] for p in series["zzz"]], [0, 0, 0])  # absent = 0, not missing
        self.assertEqual(self.store.bounds("hadoop")["n"], 3)
        self.assertEqual(self.store.search_tags("hadoop", "A")[0]["tag"], "a")
        self.assertEqual(self.store.tag_overview("hadoop", "b")["windows"], 3)
        self.assertEqual(snaps[0]["distinct_tags"], 2)

    def test_sources_are_kept_apart(self):
        sw.update_leaderboard(self.out, self.counts(a=5), BASE, 5, 10, source="local-sim", store=self.store)
        snap = sw.update_leaderboard(self.out, self.counts(a=5), BASE + 60, 5, 10, source="hadoop", store=self.store)
        self.assertIsNone(snap["top"][0]["delta"])          # no rank move against the other source
        self.assertEqual(len(snap["history"]), 1)
        self.store.clear_source("local-sim")
        self.assertEqual(self.store.snapshots("local-sim"), [])
        self.assertEqual(len(self.store.snapshots("hadoop")), 1)

    def test_old_previous_snapshot_is_ignored(self):
        sw.update_leaderboard(self.out, self.counts(a=5, b=4), BASE, 5, 10)
        snap = sw.update_leaderboard(self.out, self.counts(b=9), BASE + 3600, 5, 10)  # an hour later
        self.assertEqual(snap["events"], [])
        self.assertIsNone(snap["previous"])
        self.assertIsNone(snap["top"][0]["delta"])

    def test_velocity_published_once_history_exists(self):
        found = []
        for i in range(7):
            snap = sw.update_leaderboard(self.out, self.counts(steady=100, riser=10 + 60 * i), BASE + 60 * i, 5, 10)
            self.assertEqual(bool(snap["trending"]), i >= 5)   # needs a baseline 5 minutes back
            found += snap["events"]
        self.assertEqual(snap["trending"][0]["tag"], "riser")
        self.assertEqual(snap["scoring"]["baseline_end"], BASE + 60)
        surges = [e for e in found if e["kind"] == "surge"]
        self.assertEqual([e["tag"] for e in surges], ["riser"])  # once, not every window


class DriverRetryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "lb.json")
        self.store = Store(os.path.join(self.tmp.name, "t.db"))
        self.args = argparse.Namespace(window=5, top=10, interval=60, out=self.out, once=True, retries=3,
                                       retry_backoff=0.01, job_timeout=5, kill_orphans=False, velocity_k=20.0,
                                       min_count=10, lookback_minutes=None)
        self.storage = LocalStorage(os.path.join(self.tmp.name, "hdfs"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_failed_window_keeps_last_good_snapshot(self):
        good = sw.update_leaderboard(self.out, {"__TOTAL__": 1, "keep": 7}, BASE, 5, 10)
        drv = sw.Driver(self.args, self.storage, self.store)
        with mock.patch.object(sw, "run_once", side_effect=JobFailed("exit 1: boom")) as run:
            ok = drv.attempt(time.time())
        self.assertFalse(ok)
        self.assertEqual(run.call_count, 3)                      # bounded retries
        with open(self.out) as f:
            self.assertEqual(json.load(f)["generated_at"], good["generated_at"])
        runs = self.store.runs()
        self.assertEqual(runs[-1]["status"], "failed")
        self.assertIn("boom", runs[-1]["error"])
        self.assertEqual(drv.state["consecutive_failures"], 1)

    def test_retry_then_success_resets_failures(self):
        drv = sw.Driver(self.args, self.storage, self.store)
        drv.state["consecutive_failures"] = 2
        snap = {"top": [], "total_tweets": 0, "distinct_tags": 0, "job_seconds": 0.1, "events": []}
        with mock.patch.object(sw, "run_once", side_effect=[OSError("hdfs blip"), snap]) as run:
            ok = drv.attempt(time.time())
        self.assertTrue(ok)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(drv.state["consecutive_failures"], 0)
        self.assertEqual(self.store.runs()[-1]["attempts"], 2)

    def test_window_without_input_is_skipped_not_published(self):
        good = sw.update_leaderboard(self.out, {"__TOTAL__": 1, "keep": 7}, BASE, 5, 10)
        drv = sw.Driver(self.args, self.storage, self.store)   # empty storage: no minute folders
        self.assertFalse(drv.attempt(time.time()))
        with open(self.out) as f:
            self.assertEqual(json.load(f)["generated_at"], good["generated_at"])
        self.assertEqual(self.store.runs()[-1]["status"], "skipped")
        self.assertEqual(drv.state["consecutive_failures"], 0)   # not a job failure

    def test_no_input_raised_only_when_no_folders(self):
        with self.assertRaises(NoInput):
            run_local(self.storage, ["20231114/2214"])
        self.storage.put("20231114/2214", "part-0.jsonl", b"")
        self.assertEqual(run_local(self.storage, ["20231114/2214"]), {})  # folder exists, no tweets

    def test_heartbeat_written(self):
        drv = sw.Driver(self.args, self.storage, self.store)
        drv.beat()
        hb = self.store.heartbeats()["driver"]
        self.assertEqual(hb["status"], "starting")
        self.assertEqual(hb["detail"]["backend"], "local")


if __name__ == "__main__":
    unittest.main()
