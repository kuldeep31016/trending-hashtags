"""API schemas, validation, error format and staleness, via Flask's test client.

The background cluster health monitor is not started, so no Kafka/Hadoop is contacted.
"""
import datetime as dt
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
TMP = tempfile.mkdtemp()
os.environ["LEADERBOARD"] = os.path.join(TMP, "leaderboard.json")
os.environ["DB_PATH"] = os.path.join(TMP, "api.db")
os.environ["DATA_META"] = os.path.join(TMP, "missing.meta.json")

with mock.patch("dashboard.health.HealthMonitor.start"):
    from dashboard import app as appmod  # noqa: E402
from driver import sliding_window as sw  # noqa: E402

BASE = 1_700_000_040


def write_windows(n, source="hadoop", **extra):
    if os.path.exists(os.environ["LEADERBOARD"]):
        os.remove(os.environ["LEADERBOARD"])
    appmod.store.clear_source(source)
    snap = None
    for i in range(n):
        counts = {"__TOTAL__": 1000, "__SENT__|positive": 600, "__SENT__|negative": 400,
                  "__TS__|alpha|positive": 30, "alpha": 50 + 40 * i, "beta": 80, "gamma": 20}
        snap = sw.update_leaderboard(os.environ["LEADERBOARD"], counts, BASE + 60 * i, 5, 10, job_secs=42.0,
                                     source=source, store=appmod.store)
    return snap


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = appmod.app.test_client()

    def get(self, path, status=200):
        r = self.c.get(path)
        self.assertEqual(r.status_code, status, r.get_data(as_text=True))
        return r.get_json()

    def test_empty_state(self):
        if os.path.exists(os.environ["LEADERBOARD"]):
            os.remove(os.environ["LEADERBOARD"])
        d = self.get("/api/leaderboard")
        self.assertEqual(d["top"], [])
        self.assertEqual(d["status"], "waiting for first window")
        self.assertEqual(d["freshness"]["mode"], "empty")

    def test_leaderboard_backward_compatible(self):
        write_windows(3)
        d = self.get("/api/leaderboard")
        for k in ("generated_at", "window_minutes", "window_start", "window_end", "total_tweets", "job_seconds", "top"):
            self.assertIn(k, d)
        for k in ("rank", "tag", "count", "delta", "series"):
            self.assertIn(k, d["top"][0])
        self.assertNotIn("history", d)
        self.assertNotIn("state", d)
        self.assertEqual(d["sentiment"]["labeled"], 1000)

    def test_trends_modes_and_validation(self):
        write_windows(7)
        v = self.get("/api/trends?mode=velocity&limit=2")
        self.assertEqual(v["items"][0]["tag"], "alpha")
        self.assertLessEqual(len(v["items"]), 2)
        e = self.get("/api/trends?mode=sideways", 400)
        self.assertEqual(e["error"]["code"], "invalid_parameter")
        self.get("/api/trends?limit=abc", 400)
        self.get("/api/trends?limit=999", 400)

    def test_history_and_snapshot(self):
        write_windows(4)
        d = self.get("/api/history?tags=alpha,%23Beta")
        self.assertEqual(d["tags"], ["alpha", "beta"])
        self.assertEqual(len(d["snapshots"]), 4)
        self.assertEqual([p["count"] for p in d["series"]["alpha"]], [50, 90, 130, 170])
        self.assertEqual(d["retention"]["snapshots"], 4)
        s = self.get(f"/api/history/snapshot?at={BASE + 61}")
        self.assertEqual(s["snapshot"]["end_ts"], BASE + 60)
        self.get("/api/history/snapshot", 400)
        self.get(f"/api/history/snapshot?at={BASE - 999}", 404)

    def test_hashtag_detail_search_and_404(self):
        write_windows(3)
        d = self.get("/api/hashtags/%23ALPHA")
        self.assertEqual(d["tag"], "alpha")
        self.assertEqual(d["overview"]["windows"], 3)
        self.assertEqual(d["current"]["count"], 130)
        self.assertEqual(self.get("/api/hashtags?q=alp")["items"][0]["tag"], "alpha")
        self.assertEqual(self.get("/api/hashtags/nope", 404)["error"]["code"], "not_found")

    def test_sentiment_and_events(self):
        write_windows(3)
        s = self.get("/api/sentiment")
        self.assertTrue(s["available"])
        self.assertEqual(s["current"]["positive"], 600)
        self.assertEqual(len(s["series"]), 3)
        self.assertIn("items", self.get("/api/events"))

    def test_health_and_staleness(self):
        write_windows(2)
        h = self.get("/api/health")
        self.assertEqual(set(h["stages"]), {"kafka", "hdfs", "mapreduce", "api"})
        self.assertEqual(h["freshness"]["mode"], "live")
        self.assertIn(h["status"], {"healthy", "degraded", "down", "unknown"})
        # age the snapshot: the API must call it stale, not healthy
        p = os.environ["LEADERBOARD"]
        lb = json.load(open(p))
        lb["generated_at"] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)).isoformat()
        json.dump(lb, open(p, "w"))
        os.utime(p, (time.time() + 1, time.time() + 1))
        h = self.get("/api/health")
        self.assertEqual(h["data_mode"], "stale")
        self.assertEqual(h["stages"]["api"]["state"], "degraded")
        self.assertNotEqual(h["status"], "healthy")

    def test_simulation_marks_cluster_stages_unused(self):
        write_windows(2, source="local-sim")
        h = self.get("/api/health")
        self.assertEqual(h["source"], "local-sim")
        self.assertFalse(h["stages"]["kafka"]["in_use"])
        self.assertFalse(h["stages"]["hdfs"]["in_use"])

    def test_metrics_and_runs(self):
        write_windows(2)
        appmod.store.record_run("hadoop", time.time() - 5, "success", 1, 42.0, BASE, 0.5, 5)
        m = self.get("/api/metrics")
        self.assertEqual(m["processing"]["last_job_s"], 42.0)
        self.assertGreaterEqual(m["api"]["requests_since_start"], 0)
        self.assertEqual(self.get("/api/runs")["items"][-1]["status"], "success")

    def test_unknown_api_route_is_json(self):
        self.assertEqual(self.get("/api/nothing-here", 404)["error"]["code"], "not_found")


if __name__ == "__main__":
    unittest.main()
