#!/usr/bin/env python3
"""Sliding-window driver: every minute, count hashtags over the last 5 minutes.

Each tick:
  1. pick the 5 minute-directories that make up the window
  2. run the MapReduce job over them (real Hadoop Streaming, or the local simulation)
  3. sort the counts, keep the top 10, add rank movement + a sparkline series
     + velocity / burst scores, sentiment aggregates and trend events
  4. write dashboard/leaderboard.json atomically (the classic dashboard just reads this file)
     and record the snapshot, run and events in the SQLite store (history for the new UI)

Resilience:
  * a failed job is retried a bounded number of times with exponential backoff, and a
    failed window never overwrites the last good snapshot (the UI shows it as stale)
  * a window with no input folders at all (sink stopped, HDFS emptied) is recorded as
    "skipped" and does not publish: an empty leaderboard would look like real data
  * one job at a time: the loop is sequential, a lock file stops a second driver, and
    leftover YARN apps from a killed driver are killed on start-up
  * the next run is scheduled from when the previous one FINISHED (slow jobs skip ticks
    instead of piling up)
  * SIGINT/SIGTERM finish the current job and exit; a second signal exits immediately
"""
import argparse
import datetime as dt
import fcntl
import json
import os
import signal
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from analytics import events as trend_events  # noqa: E402
from analytics.scoring import DEFAULT_K, DEFAULT_MIN_COUNT, rank_by_velocity, score_tags  # noqa: E402
from analytics.store import DEFAULT_DB, Store  # noqa: E402
from common import ROOT, add_storage_args, get_logger, kv, make_storage, window_keys  # noqa: E402
from mapreduce.runner import JobFailed, NoInput, kill_running_jobs, run_hadoop, run_local  # noqa: E402

TOTAL = "__TOTAL__"
DEFAULT_OUT = os.path.join(ROOT, "dashboard", "leaderboard.json")
HISTORY_LEN = 30        # snapshots kept inside leaderboard.json
HISTORY_TAGS = 200      # tags kept per history entry (sparklines + velocity baseline)
SERIES_LEN = 12
SENTIMENTS = ("positive", "neutral", "negative")

log = get_logger("driver")


def top_n(counts, n):
    items = [(t, c) for t, c in counts.items() if not t.startswith("__")]
    return sorted(items, key=lambda x: (-x[1], x[0]))[:n]  # ties broken alphabetically


def split_counts(counts):
    """MapReduce output -> (hashtag counts, overall sentiment or None, per-tag sentiment)."""
    tags, overall, per_tag = {}, dict.fromkeys(SENTIMENTS, 0), {}
    for key, n in counts.items():
        if key.startswith("__SENT__|"):
            label = key.split("|", 1)[1]
            if label in overall:
                overall[label] += n
        elif key.startswith("__TS__|"):
            _, tag, label = key.split("|", 2)
            if label in SENTIMENTS:
                per_tag.setdefault(tag, dict.fromkeys(SENTIMENTS, 0))[label] += n
        elif not key.startswith("__"):
            tags[key] = n
    labeled = sum(overall.values())
    sentiment = None
    if labeled:
        sentiment = {**overall, "labeled": labeled, "unlabeled": max(counts.get(TOTAL, 0) - labeled, 0)}
    return tags, sentiment, per_tag


def update_leaderboard(path, counts, end_ts, window, topn, job_secs=None, source="local",
                       k=DEFAULT_K, min_count=DEFAULT_MIN_COUNT, lookback=None, store=None):
    prev = {}
    try:
        with open(path) as f:
            prev = json.load(f)
    except (OSError, ValueError):
        pass
    if prev.get("source", source) != source:
        prev = {}  # never mix the local simulation's history with the live pipeline's
    elif prev.get("window_end", end_ts) < end_ts - 2 * window * 60:
        prev = {}  # a snapshot from an earlier run: rank moves/events against it would be fiction
    tags, sentiment, tag_sentiment = split_counts(counts)
    history = [h for h in prev.get("history", []) if h["end_ts"] < end_ts]
    lookback = window * 60 if lookback is None else lookback
    scored, baseline_end, baseline_scale = score_tags(tags, history, end_ts, lookback, k, min_count,
                                                      total=counts.get(TOTAL, 0))

    prev_rank = {e["tag"]: e["rank"] for e in prev.get("top", [])}
    history.append({"end_ts": end_ts, "total": counts.get(TOTAL, 0), "counts": dict(top_n(tags, HISTORY_TAGS))})
    history = history[-HISTORY_LEN:]
    series = lambda tag: [h["counts"].get(tag, 0) for h in history[-SERIES_LEN:]]  # noqa: E731

    top = []
    for i, (tag, c) in enumerate(top_n(tags, topn), start=1):
        old = prev_rank.get(tag)
        s = scored[tag]
        top.append({"rank": i, "tag": tag, "count": c,
                    "delta": None if old is None else old - i,  # +ve = moved up, None = new
                    "series": series(tag),
                    "baseline_count": s["baseline_count"], "growth": s["growth"],
                    "trend_score": s["trend_score"], "burst_score": s["burst_score"],
                    "sentiment": tag_sentiment.get(tag)})
    volume_rank = {t: i for i, (t, _) in enumerate(top_n(tags, len(tags)), start=1)}
    trending = [{"rank": i, "tag": t, "count": s["count"], "baseline_count": s["baseline_count"],
                 "growth": s["growth"], "trend_score": s["trend_score"], "burst_score": s["burst_score"],
                 "volume_rank": volume_rank[t], "series": series(t), "sentiment": tag_sentiment.get(t)}
                for i, (t, s) in enumerate(rank_by_velocity(scored, topn), start=1)]

    found, surging = trend_events.detect([e["tag"] for e in prev.get("top", [])], [e["tag"] for e in top],
                                         scored, prev.get("state", {}).get("surging", []))
    end_min = int(end_ts // 60)
    previous = None
    if prev.get("top") is not None and "window_end" in prev:
        previous = {k_: prev.get(k_) for k_ in ("window_end", "total_tweets", "distinct_tags",
                                                "tag_mentions", "job_seconds", "generated_at")}
    snap = {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "source": source,
            "window_minutes": window,
            "window_start": (end_min - window + 1) * 60,
            "window_end": end_ts,
            "total_tweets": counts.get(TOTAL, 0),
            "distinct_tags": len(tags),
            "tag_mentions": sum(tags.values()),
            "job_seconds": job_secs,
            "top": top,
            "trending": trending,
            "sentiment": sentiment,
            "previous": previous,
            "scoring": {"k": k, "min_count": min_count, "lookback_seconds": lookback,
                        "baseline_end": baseline_end, "baseline_scale": baseline_scale,
                        "surge_score": trend_events.SURGE_SCORE},
            "events": found,
            "state": {"surging": sorted(surging)},
            "history": history}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(snap, f)
    os.replace(tmp, path)  # atomic: the dashboard never reads a half-written file
    if store is not None:
        store.save_snapshot(source, snap, tags, tag_sentiment)
        store.add_events(source, end_ts, found)
    return snap


def source_of(storage):
    return "hadoop" if storage.kind == "hdfs" else "local"


def run_once(storage, a, end_ts, store=None):
    keys = window_keys(end_ts, a.window)
    t0 = time.time()
    if storage.kind == "hdfs":
        counts = run_hadoop(storage, keys, a.streaming_jar, a.mr_dir, str(int(end_ts)), timeout=a.job_timeout)
    else:
        counts = run_local(storage, keys)
    return update_leaderboard(a.out, counts, end_ts, a.window, a.top, round(time.time() - t0, 2),
                              source=source_of(storage), k=a.velocity_k, min_count=a.min_count,
                              lookback=a.lookback_minutes * 60 if a.lookback_minutes else None, store=store)


class Driver:
    def __init__(self, a, storage, store):
        self.a, self.storage, self.store = a, storage, store
        self.source = source_of(storage)
        self.stop = threading.Event()
        self.state = {"status": "starting", "pid": os.getpid(), "interval": a.interval,
                      "backend": storage.kind, "consecutive_failures": 0,
                      "last_success": None, "last_error": None, "next_run_at": None}

    def beat(self):
        try:
            self.store.heartbeat("driver", self.state["status"],
                                 **{k: v for k, v in self.state.items() if k != "status"})
        except Exception:  # noqa: BLE001 - a heartbeat must never take the driver down
            log.exception("heartbeat failed")

    def _heartbeat_loop(self):
        while not self.stop.wait(10):
            self.beat()

    def attempt(self, planned):
        started, delay = time.time(), max(0.0, time.time() - planned)
        end_ts, err = started, None
        for attempt in range(1, self.a.retries + 1):
            self.state["status"] = "running"
            self.beat()
            try:
                t0 = time.time()
                snap = run_once(self.storage, self.a, end_ts, self.store)
            except NoInput as e:
                log.warning("no input data, keeping last snapshot", extra=kv(window_end=int(end_ts), detail=e))
                self.store.record_run(self.source, started, "skipped", attempt, None, end_ts, round(delay, 2), 0,
                                      "no input data in the window (is the sink writing to HDFS?)")
                self.state["last_error"] = {"at": time.time(), "message": "no input data in the window"}
                return False
            except (JobFailed, subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError, ValueError) as e:
                err = f"{type(e).__name__}: {e}"
                log.error("window failed", extra=kv(attempt=attempt, of=self.a.retries, error=err,
                                                    window_end=int(end_ts)))
                if attempt < self.a.retries:
                    wait = min(self.a.retry_backoff * 2 ** (attempt - 1), 120)
                    self.state["status"] = "retrying"
                    self.beat()
                    if self.stop.wait(wait):
                        break
                continue
            top3 = ", ".join(f"#{e['tag']}={e['count']}" for e in snap["top"][:3]) or "(no data yet)"
            log.info("window done", extra=kv(tweets=snap["total_tweets"], tags=snap["distinct_tags"],
                                             top=top3, job_s=snap["job_seconds"], attempt=attempt,
                                             schedule_delay_s=round(delay, 1), events=len(snap["events"])))
            self.store.record_run(self.source, started, "success", attempt, time.time() - t0, end_ts,
                                  round(delay, 2), len(window_keys(end_ts, self.a.window)))
            self.state.update(consecutive_failures=0, last_success=time.time(), last_error=None)
            return True
        self.store.record_run(self.source, started, "failed", attempt, None, end_ts, round(delay, 2), None, err)
        self.state["consecutive_failures"] += 1
        self.state["last_error"] = {"at": time.time(), "message": err}
        log.warning("keeping last good snapshot", extra=kv(consecutive_failures=self.state["consecutive_failures"]))
        return False

    def run(self):
        if self.storage.kind == "hdfs" and self.a.kill_orphans:
            killed = kill_running_jobs(self.storage)
            if killed:
                log.warning("killed orphaned YARN jobs", extra=kv(apps=",".join(killed)))
        threading.Thread(target=self._heartbeat_loop, daemon=True).start()
        planned = time.time()
        while not self.stop.is_set():
            self.attempt(planned)
            self.store.prune()
            if self.a.once or self.stop.is_set():
                break
            # next interval boundary after the job FINISHED (+2 s so the last minute is flushed)
            now = time.time()
            planned = (int(now // self.a.interval) + 1) * self.a.interval + 2
            self.state.update(status="idle", next_run_at=planned)
            self.beat()
            self.stop.wait(max(1.0, planned - now))
        self.state.update(status="stopped", next_run_at=None)
        self.beat()
        log.info("driver stopped")


def acquire_lock(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fh = open(path, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(f"another driver is already running (lock {path}); stop it first")
    fh.write(str(os.getpid()))
    fh.flush()
    return fh


def main():
    ap = argparse.ArgumentParser()
    add_storage_args(ap)
    ap.add_argument("--window", type=int, default=5, help="window length in minutes")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--interval", type=int, default=60, help="seconds between updates")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--db", default=DEFAULT_DB, help="SQLite store for history, runs and events")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--retries", type=int, default=3, help="attempts per window")
    ap.add_argument("--retry-backoff", type=float, default=10, help="first retry wait (s), doubles each try")
    ap.add_argument("--job-timeout", type=float, default=900, help="seconds before a Hadoop job is killed")
    ap.add_argument("--no-kill-orphans", dest="kill_orphans", action="store_false",
                    help="do not kill this project's still-running YARN jobs on start-up")
    ap.add_argument("--velocity-k", type=float, default=DEFAULT_K, help="growth smoothing constant")
    ap.add_argument("--min-count", type=int, default=DEFAULT_MIN_COUNT, help="min mentions for velocity rank")
    ap.add_argument("--lookback-minutes", type=float, default=None,
                    help="baseline window age for velocity (default: one window length)")
    ap.add_argument("--streaming-jar",
                    default="/opt/hadoop/share/hadoop/tools/lib/hadoop-streaming-3.3.6.jar")
    ap.add_argument("--mr-dir", default="/project/mapreduce",
                    help="path of the mapreduce/ folder as seen by the hadoop client")
    a = ap.parse_args()
    lock = acquire_lock(os.path.join(os.path.dirname(os.path.abspath(a.db)), "driver.lock"))  # noqa: F841
    driver = Driver(a, make_storage(a), Store(a.db))

    def on_signal(signum, _frame):
        if driver.stop.is_set():
            log.warning("second signal, exiting now")
            raise SystemExit(1)
        log.info("stopping after the current job", extra=kv(signal=signal.Signals(signum).name))
        driver.stop.set()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    log.info("driver started", extra=kv(backend=a.backend, window_min=a.window, interval_s=a.interval,
                                        retries=a.retries, db=a.db))
    driver.run()


if __name__ == "__main__":
    main()
