"""Correctness tests: the MapReduce output must equal a brute-force count.

    python -m unittest discover -s tests -v
"""
import collections
import html
import json
import os
import random
import re
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import LocalStorage, minute_key, window_keys  # noqa: E402
from driver.sliding_window import top_n, update_leaderboard  # noqa: E402
from mapreduce.runner import run_local  # noqa: E402

BASE = 1_700_000_040  # a fixed minute boundary


def put(storage, ts, texts, name="part-0.jsonl"):
    data = "\n".join(json.dumps({"text": t, "ts": ts}) for t in texts) + "\n"
    storage.put(minute_key(ts), name, data.encode())


class WindowTests(unittest.TestCase):
    def test_window_keys(self):
        keys = window_keys(BASE + 30, 5)
        self.assertEqual(len(keys), 5)
        self.assertEqual(keys[-1], minute_key(BASE))
        self.assertEqual(keys[0], minute_key(BASE - 4 * 60))

    def test_mapper_rules(self):
        with tempfile.TemporaryDirectory() as d:
            s = LocalStorage(d)
            put(s, BASE, ["Love #Python and #python!", "no tags here", "&#39;quoted&#39; #AI #ai #123",
                          "price#tag is not a hashtag", "x" * 3 + " #a"])
            c = run_local(s, [minute_key(BASE)])
        self.assertEqual(c["python"], 1)   # case-insensitive, once per tweet
        self.assertEqual(c["ai"], 1)
        self.assertEqual(c["__TOTAL__"], 5)
        self.assertNotIn("123", c)         # numeric "tags" (HTML entities) ignored
        self.assertNotIn("tag", c)         # '#' glued to a word is not a hashtag
        self.assertNotIn("a", c)           # 1-char tags ignored

    def test_matches_bruteforce_and_excludes_old_minutes(self):
        rng = random.Random(1)
        tags = ["alpha", "beta", "gamma", "delta", "eps"]
        expected = collections.Counter()
        with tempfile.TemporaryDirectory() as d:
            s = LocalStorage(d)
            for m in range(-8, 1):  # 9 minutes of data, only the last 5 are in the window
                texts = []
                for _ in range(200):
                    chosen = rng.sample(tags, rng.randint(0, 3))
                    texts.append("tweet " + " ".join("#" + t.upper() for t in chosen))
                    if m > -5:
                        expected.update(set(chosen))
                put(s, BASE + m * 60, texts, name=f"part-{m + 8}.jsonl")
            end = BASE + 10
            got = run_local(s, window_keys(end, 5))
        got.pop("__TOTAL__")
        self.assertEqual(got, dict(expected))

    def test_multiple_files_per_minute(self):
        with tempfile.TemporaryDirectory() as d:
            s = LocalStorage(d)
            put(s, BASE, ["#foo"], name="part-a.jsonl")
            put(s, BASE + 5, ["#foo", "#bar"], name="part-b.jsonl")
            c = run_local(s, [minute_key(BASE)])
        self.assertEqual(c["foo"], 2)
        self.assertEqual(c["bar"], 1)

    def test_top10_and_rank_movement(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "lb.json")
            c1 = {f"t{i}": 100 - i for i in range(15)}
            c1["__TOTAL__"] = 999
            s1 = update_leaderboard(out, c1, BASE, 5, 10)
            self.assertEqual(len(s1["top"]), 10)
            self.assertEqual(s1["top"][0]["tag"], "t0")
            self.assertTrue(all(e["delta"] is None for e in s1["top"]))  # first snapshot: all new
            c2 = dict(c1)
            c2["t5"] = 500  # t5 jumps to #1
            s2 = update_leaderboard(out, c2, BASE + 60, 5, 10)
            self.assertEqual(s2["top"][0]["tag"], "t5")
            self.assertEqual(s2["top"][0]["delta"], 5)   # was rank 6, now rank 1
            self.assertEqual(s2["top"][1]["delta"], -1)  # t0 slipped one place
            self.assertNotIn("__TOTAL__", [e["tag"] for e in s2["top"]])

    def test_tie_break_is_stable(self):
        self.assertEqual(top_n({"b": 3, "a": 3, "c": 1}, 2), [("a", 3), ("b", 3)])


if __name__ == "__main__":
    unittest.main()
