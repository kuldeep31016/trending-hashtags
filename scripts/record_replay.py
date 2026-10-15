#!/usr/bin/env python3
"""Record a real pipeline run for the hosted (static) replay of the dashboard.

While the live pipeline runs, every new MapReduce window is captured exactly as the API
served it (leaderboard, health, metrics). At the end the stored history (snapshots, tags,
events, runs) is exported. The frontend's replay mode (VITE_REPLAY=1) answers its /api/*
calls from these files, so the hosted site shows recorded results, never invented ones.

    python scripts/record_replay.py --minutes 35          # writes frontend/public/replay/
"""
import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from analytics.store import DEFAULT_DB  # noqa: E402
from common import ROOT  # noqa: E402

API = "http://localhost:5050"


def get(path):
    with urllib.request.urlopen(API + path, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def export_db(db, source):
    c = sqlite3.connect(db)
    c.row_factory = sqlite3.Row
    rows = lambda q, *a: [dict(r) for r in c.execute(q, a)]  # noqa: E731
    snaps = rows("SELECT * FROM snapshots WHERE source=? ORDER BY end_ts", source)
    for s in snaps:
        s["sentiment"] = json.loads(s["sentiment"]) if s["sentiment"] else None
    ids = [s["id"] for s in snaps]
    tags = rows(f"SELECT * FROM snapshot_tags WHERE snapshot_id IN ({','.join('?' * len(ids))})", *ids) if ids else []
    events = rows("SELECT * FROM events WHERE source=? ORDER BY end_ts, id", source)
    for e in events:
        e["detail"] = json.loads(e["detail"] or "{}")
    runs = rows("SELECT * FROM runs WHERE source=? ORDER BY started_at", source)
    return {"snapshots": snaps, "snapshot_tags": tags, "events": events, "runs": runs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=35)
    ap.add_argument("--out", default=os.path.join(ROOT, "frontend", "public", "replay"))
    ap.add_argument("--db", default=DEFAULT_DB)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    frames, last, end = [], None, time.time() + a.minutes * 60
    meta = get("/api/meta")
    while time.time() < end:
        try:
            lb = get("/api/leaderboard")
            key = (lb.get("generated_at"), lb.get("window_end"))
            if lb.get("top") and key != last:
                last = key
                frames.append({"leaderboard": lb, "health": get("/api/health"), "metrics": get("/api/metrics"),
                               "captured_at": time.time()})
                print(f"frame {len(frames)}: window {time.strftime('%H:%M:%S', time.localtime(lb['window_end']))} "
                      f"top={[e['tag'] for e in lb['top'][:3]]}", flush=True)
        except OSError as e:
            print("api unavailable:", e, flush=True)
        time.sleep(5)

    source = frames[-1]["leaderboard"]["source"] if frames else "hadoop"
    with open(os.path.join(a.out, "frames.json"), "w") as f:
        json.dump(frames, f)
    with open(os.path.join(a.out, "db.json"), "w") as f:
        json.dump(export_db(a.db, source), f)
    with open(os.path.join(a.out, "meta.json"), "w") as f:
        json.dump({**meta, "recorded_at": time.time(), "frames": len(frames)}, f)
    print(f"wrote {len(frames)} frames to {a.out}")


if __name__ == "__main__":
    main()
