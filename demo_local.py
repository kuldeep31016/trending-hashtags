#!/usr/bin/env python3
"""End-to-end demo with NO Kafka and NO Hadoop.

Replays tweets minute by minute on a simulated clock: write the minute's tweets to a
folder that mimics HDFS, run the same mapper/reducer, recompute the 5-minute window and
update the leaderboard that the dashboard reads. Run the dashboard in another terminal.

Results are tagged source="local-sim", so the dashboard labels them as a simulation and
never mixes them with the live Hadoop pipeline's history. Each run replaces only the
previous simulation's rows in the SQLite store; HDFS is never touched.

    python demo_local.py --delay 2
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

from analytics.store import DEFAULT_DB, Store
from common import ROOT, LocalStorage, minute_key, window_keys
from driver.sliding_window import DEFAULT_OUT, update_leaderboard
from mapreduce.runner import run_local

SOURCE = "local-sim"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(ROOT, "data", "tweets.jsonl"))
    ap.add_argument("--minutes", type=int, default=45, help="simulated minutes to replay")
    ap.add_argument("--per-minute", type=int, default=400, help="tweets per simulated minute")
    ap.add_argument("--delay", type=float, default=2.0, help="real seconds between simulated minutes")
    ap.add_argument("--window", type=int, default=5)
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--root", default=os.path.join(ROOT, "data", "hdfs_local"))
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--db", default=DEFAULT_DB)
    a = ap.parse_args()

    if not os.path.exists(a.data):
        subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "prepare_data.py")], check=True)
    with open(a.data) as f:
        lines = f.read().splitlines()

    shutil.rmtree(a.root, ignore_errors=True)  # fresh run
    if os.path.exists(a.out):
        os.remove(a.out)
    storage = LocalStorage(a.root)
    store = Store(a.db)
    store.clear_source(SOURCE)
    start_min = int(time.time() // 60) - a.minutes + 1
    idx = 0
    for m in range(a.minutes):
        t0 = (start_min + m) * 60
        recs = []
        for j in range(a.per_minute):
            rec = json.loads(lines[idx % len(lines)])
            idx += 1
            rec["ts"] = t0 + j * 60.0 / a.per_minute
            recs.append(rec)
        storage.put(minute_key(t0), f"part-{m:05d}.jsonl",
                    ("\n".join(json.dumps(r) for r in recs) + "\n").encode())
        end_ts = t0 + 59
        t1 = time.time()
        store.heartbeat("demo", "running", minute=m + 1, minutes=a.minutes, delay=a.delay, pid=os.getpid())
        counts = run_local(storage, window_keys(end_ts, a.window))
        snap = update_leaderboard(a.out, counts, end_ts, a.window, a.top, round(time.time() - t1, 2),
                                  source=SOURCE, store=store)
        store.record_run(SOURCE, t1, "success", 1, time.time() - t1, end_ts, 0.0, a.window)
        top3 = ", ".join(f"#{e['tag']}={e['count']}" for e in snap["top"][:3])
        print(f"minute {m + 1:>3}/{a.minutes}  window tweets={snap['total_tweets']:>5}  top: {top3}", flush=True)
        time.sleep(a.delay)
    store.heartbeat("demo", "finished", minute=a.minutes, minutes=a.minutes, delay=a.delay, pid=os.getpid())
    print("done")


if __name__ == "__main__":
    main()
