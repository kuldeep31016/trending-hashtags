#!/usr/bin/env python3
"""Dashboard API + web app.

The browser only ever reads results the scheduled pipeline already produced:
leaderboard.json (latest window) and the SQLite store (history, runs, events, metrics).
No request ever starts a Hadoop job.

    GET /api/leaderboard         latest window (backward compatible + extra fields)
    GET /api/trends              ranking by volume or velocity
    GET /api/history             snapshots + per-hashtag series in a time range
    GET /api/history/snapshot    the full leaderboard of one past snapshot
    GET /api/hashtags?q=         hashtag search
    GET /api/hashtags/<tag>      one hashtag: current stats, history, events
    GET /api/sentiment           sentiment aggregates (when the data carries labels)
    GET /api/events              detected trend events
    GET /api/runs                MapReduce run history
    GET /api/health              application + pipeline health
    GET /api/metrics             measured operational metrics
    GET /api/meta                dataset provenance + pipeline configuration
    GET /api/stream              Server-Sent Events: leaderboard + health pushes

The React app (frontend/, built into dashboard/static/app) is served at /; the original
single-page dashboard stays available at /classic.
"""
import collections
import json
import math
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from flask import Flask, Response, abort, g, jsonify, render_template, request, send_from_directory  # noqa: E402
from werkzeug.exceptions import HTTPException  # noqa: E402

from analytics.store import DEFAULT_DB, Store  # noqa: E402
from common import ROOT  # noqa: E402
from dashboard.health import HealthMonitor  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
LEADERBOARD = os.environ.get("LEADERBOARD", os.path.join(HERE, "leaderboard.json"))
META = os.environ.get("DATA_META", os.path.join(ROOT, "data", "tweets.meta.json"))
SPA_DIR = os.path.join(HERE, "static", "app")
DRIVER_INTERVAL = int(os.environ.get("DRIVER_INTERVAL", 60))
RETENTION_DAYS = 7
HEARTBEAT_STALE_S = 45
SINK_STALE_S = 60

app = Flask(__name__)
app.json.sort_keys = False
store = Store(os.environ.get("DB_PATH", DEFAULT_DB))
monitor = HealthMonitor()
_latency = collections.deque(maxlen=1000)  # (ts, ms) of recent API requests
_requests = {"count": 0}
_lb_cache = {"mtime": None, "data": None}
_lb_lock = threading.Lock()


# ---- helpers --------------------------------------------------------------------------

class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def load_leaderboard():
    """Parsed leaderboard.json, cached by mtime (the driver replaces it atomically)."""
    try:
        mtime = os.stat(LEADERBOARD).st_mtime_ns
    except OSError:
        return None
    with _lb_lock:
        if _lb_cache["mtime"] != mtime:
            try:
                with open(LEADERBOARD) as f:
                    _lb_cache.update(mtime=mtime, data=json.load(f))
            except (OSError, ValueError):
                return _lb_cache["data"]
        return _lb_cache["data"]


def load_meta():
    try:
        with open(META) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def current_source():
    lb = load_leaderboard()
    return (lb or {}).get("source") or request.args.get("source") or "hadoop"


def arg_float(name, default=None, lo=None, hi=None):
    raw = request.args.get(name)
    if raw in (None, ""):
        return default
    try:
        v = float(raw)
    except ValueError:
        raise ApiError(400, "invalid_parameter", f"'{name}' must be a number") from None
    if not math.isfinite(v) or (lo is not None and v < lo) or (hi is not None and v > hi):
        raise ApiError(400, "invalid_parameter", f"'{name}' out of range")
    return v


def arg_int(name, default, lo, hi):
    return int(arg_float(name, default, lo, hi))


def generated_ts(lb):
    try:
        from datetime import datetime
        return datetime.fromisoformat(lb["generated_at"]).timestamp()
    except (KeyError, TypeError, ValueError):
        return None


def freshness(lb):
    """How old the latest snapshot is and whether it should be treated as stale."""
    if not lb:
        return {"age_seconds": None, "stale": None, "stale_after": None, "mode": "empty"}
    age = time.time() - (generated_ts(lb) or 0)
    source = lb.get("source", "hadoop")
    if source == "local-sim":
        demo = store.heartbeats().get("demo")
        running = bool(demo and demo["status"] == "running"
                       and time.time() - demo["ts"] < max(30, 3 * demo["detail"].get("delay", 2) + 10))
        return {"age_seconds": round(age, 1), "stale": False, "stale_after": None,
                "mode": "simulation" if running else "simulation-finished"}
    stale_after = max(180.0, 2 * (DRIVER_INTERVAL + (lb.get("job_seconds") or 0)))
    stale = age > stale_after
    return {"age_seconds": round(age, 1), "stale": stale, "stale_after": round(stale_after),
            "mode": "stale" if stale else "live"}


def public_leaderboard(lb):
    if not lb:
        return {"top": [], "status": "waiting for first window", "freshness": freshness(None)}
    data = {k: v for k, v in lb.items() if k not in ("history", "state")}
    data["freshness"] = freshness(lb)
    return data


def series_points(series):
    return [{"end_ts": ts, "count": c, "rank": r} for ts, c, r in series]


# ---- request plumbing -----------------------------------------------------------------

@app.before_request
def _t0():
    g.t0 = time.perf_counter()


@app.after_request
def _timing(resp):
    if request.path.startswith("/api/") and request.path != "/api/stream":
        ms = (time.perf_counter() - g.t0) * 1000
        _latency.append((time.time(), ms))
        _requests["count"] += 1
        resp.headers["Server-Timing"] = f"app;dur={ms:.1f}"
        resp.headers.setdefault("Cache-Control", "no-store")
    return resp


@app.errorhandler(ApiError)
def _api_error(e):
    return jsonify({"error": {"code": e.code, "message": e.message}}), e.status


@app.errorhandler(HTTPException)
def _http_error(e):
    if request.path.startswith("/api/"):
        return jsonify({"error": {"code": e.name.lower().replace(" ", "_"), "message": e.description}}), e.code
    return e


# ---- data endpoints -------------------------------------------------------------------

@app.get("/api/leaderboard")
def leaderboard():
    return jsonify(public_leaderboard(load_leaderboard()))


@app.get("/api/trends")
def trends():
    mode = request.args.get("mode", "volume")
    if mode not in ("volume", "velocity"):
        raise ApiError(400, "invalid_parameter", "mode must be 'volume' or 'velocity'")
    limit = arg_int("limit", 10, 1, 50)
    lb = load_leaderboard()
    if not lb:
        return jsonify({"mode": mode, "items": [], "status": "waiting for first window"})
    items = lb.get("top", []) if mode == "volume" else lb.get("trending", [])
    return jsonify({"mode": mode, "source": lb.get("source"), "window_end": lb.get("window_end"),
                    "scoring": lb.get("scoring"), "items": items[:limit],
                    "note": None if mode == "volume" or lb.get("trending") else
                    "velocity needs a baseline window: available once one full window of history exists"})


@app.get("/api/history")
def history():
    source = current_source()
    since, until = arg_float("from"), arg_float("to")
    limit = arg_int("limit", 240, 1, 2000)
    tags = [t.strip().lstrip("#").lower() for t in request.args.get("tags", "").split(",") if t.strip()][:10]
    if not tags:
        lb = load_leaderboard() or {}
        tags = [e["tag"] for e in lb.get("top", [])[:5]]
    snaps, series = store.tag_series(source, tags, since, until, limit)
    bounds = store.bounds(source)
    return jsonify({
        "source": source,
        "tags": tags,
        "snapshots": [{k: s[k] for k in ("id", "end_ts", "window_start", "window_minutes", "total_tweets",
                                          "distinct_tags", "tag_mentions", "job_seconds", "sentiment")}
                      for s in snaps],
        "series": {t: series_points(v) for t, v in series.items()},
        "retention": {"days": RETENTION_DAYS, "oldest": bounds["oldest"], "newest": bounds["newest"],
                      "snapshots": bounds["n"]},
    })


@app.get("/api/history/snapshot")
def history_snapshot():
    source = current_source()
    at = arg_float("at")
    if at is None:
        raise ApiError(400, "missing_parameter", "'at' (window end timestamp) is required")
    snaps = store.snapshots(source, until=at, limit=1)
    if not snaps:
        raise ApiError(404, "not_found", "no snapshot at or before that time")
    s = snaps[-1]
    return jsonify({"snapshot": {k: v for k, v in s.items()},
                    "top": store.snapshot_tags(s["id"], arg_int("limit", 10, 1, 200))})


@app.get("/api/hashtags")
def hashtag_search():
    q = request.args.get("q", "").strip().lstrip("#")
    if len(q) > 50:
        raise ApiError(400, "invalid_parameter", "query too long")
    return jsonify({"query": q, "items": store.search_tags(current_source(), q, arg_int("limit", 20, 1, 100))})


@app.get("/api/hashtags/<tag>")
def hashtag_detail(tag):
    tag = tag.strip().lstrip("#").lower()
    if not tag or len(tag) > 50:
        raise ApiError(400, "invalid_parameter", "invalid hashtag")
    source = current_source()
    overview = store.tag_overview(source, tag)
    if not overview:
        raise ApiError(404, "not_found", f"#{tag} has not appeared in any stored window")
    lb = load_leaderboard() or {}
    current = next((e for e in lb.get("top", []) if e["tag"] == tag), None)
    velocity = next((e for e in lb.get("trending", []) if e["tag"] == tag), None)
    snaps, series = store.tag_series(source, [tag], limit=arg_int("limit", 240, 1, 2000))
    latest = series[tag][-1] if series[tag] else None
    return jsonify({
        "tag": tag,
        "source": source,
        "current": {
            "window_end": lb.get("window_end"),
            "count": latest[1] if latest else 0,
            "rank": latest[2] if latest else None,
            "in_top": current is not None,
            "delta": current["delta"] if current else None,
            "growth": (current or velocity or {}).get("growth"),
            "trend_score": (current or velocity or {}).get("trend_score"),
            "baseline_count": (current or velocity or {}).get("baseline_count"),
            "burst_score": (current or velocity or {}).get("burst_score"),
            "velocity_rank": velocity["rank"] if velocity else None,
            "sentiment": (current or velocity or {}).get("sentiment"),
        },
        "overview": overview,
        "series": series_points(series[tag]),
        "events": store.events(source, tag=tag, limit=50),
    })


@app.get("/api/sentiment")
def sentiment():
    lb = load_leaderboard() or {}
    meta = load_meta() or {}
    labels = meta.get("sentiment_labels") or {}
    source = current_source()
    snaps = store.snapshots(source, since=arg_float("from"), limit=arg_int("limit", 240, 1, 2000))
    series = [{"end_ts": s["end_ts"], **{k: s["sentiment"].get(k, 0) for k in ("positive", "neutral", "negative")}}
              for s in snaps if s.get("sentiment")]
    current = lb.get("sentiment")
    return jsonify({
        "available": bool(current),
        "reason": None if current else
        "the tweets in the current window carry no sentiment labels (regenerate data with "
        "scripts/prepare_data.py, which now keeps them)",
        "provenance": labels.get("provenance"),
        "note": labels.get("note"),
        "current": current,
        "by_tag": [{"tag": e["tag"], "count": e["count"], **(e.get("sentiment") or {})}
                   for e in lb.get("top", []) if e.get("sentiment")],
        "series": series,
    })


@app.get("/api/events")
def events():
    return jsonify({"source": current_source(),
                    "items": store.events(current_source(), arg_float("from"), arg_float("to"),
                                          arg_int("limit", 50, 1, 500), request.args.get("tag"))})


@app.get("/api/runs")
def runs():
    source = current_source()
    return jsonify({"source": source, "items": store.runs(source, arg_float("from"), arg_int("limit", 100, 1, 1000)),
                    "stats": store.run_stats(source)})


@app.get("/api/meta")
def meta():
    lb = load_leaderboard() or {}
    return jsonify({
        "dataset": load_meta(),
        "pipeline": {"window_minutes": lb.get("window_minutes", 5), "interval_seconds": DRIVER_INTERVAL,
                     "source": lb.get("source"), "scoring": lb.get("scoring"),
                     "retention_days": RETENTION_DAYS},
        "endpoints": {"hdfs_ui": os.environ.get("HDFS_UI", "http://localhost:9870"),
                      "yarn_ui": os.environ.get("YARN_UI", "http://localhost:8088")},
    })


# ---- health & metrics -----------------------------------------------------------------

def _api_latency(window_s=300):
    cutoff = time.time() - window_s
    vals = sorted(ms for ts, ms in list(_latency) if ts >= cutoff)
    if not vals:
        return None
    return {"requests": len(vals), "avg_ms": round(sum(vals) / len(vals), 1),
            "p95_ms": round(vals[min(len(vals) - 1, int(len(vals) * 0.95))], 1)}


def _stage(state, summary, **details):
    return {"state": state, "summary": summary, **details}


def build_health():
    now = time.time()
    lb = load_leaderboard()
    fresh = freshness(lb)
    source = (lb or {}).get("source", "hadoop")
    live_pipeline = source == "hadoop"
    cluster = monitor.snapshot()
    beats = store.heartbeats()
    flushes = store.ingest(now - 300)
    last_runs = store.runs(source if lb else None, limit=20)

    # Kafka stage: broker + topic (cluster check) and producer activity (heartbeat)
    k = cluster.get("kafka")
    prod = beats.get("producer")
    prod_age = now - prod["ts"] if prod else None
    if k is None:
        kafka = _stage("unknown", "first check pending")
    else:
        kafka = _stage(k["state"], k.get("error") or f"topic '{k.get('topic')}' with {k.get('partitions')} partitions",
                       check=k)
        if k["state"] == "healthy" and live_pipeline and (prod is None or prod_age > 60 or prod["status"] != "running"):
            kafka = _stage("degraded", "broker up, but no producer activity in the last minute", check=k)
    kafka["producer"] = {**prod["detail"], "status": prod["status"], "last_seen": prod["ts"]} if prod else None

    # HDFS stage: NameNode/DataNodes (cluster check) and the sink's recent writes
    h = cluster.get("hdfs")
    sink = beats.get("sink")
    last_flush = flushes[-1]["ts"] if flushes else None
    if h is None:
        hdfs = _stage("unknown", "first check pending")
    else:
        hdfs = _stage(h["state"], h.get("error") or f"{h.get('live_datanodes')} live DataNode(s), FS {h.get('fs_state')}",
                      check=h)
        if h["state"] == "healthy" and live_pipeline and (last_flush is None or now - last_flush > SINK_STALE_S):
            hdfs = _stage("degraded", "HDFS up, but the sink wrote nothing in the last minute", check=h)
    hdfs["sink"] = {**sink["detail"], "status": sink["status"], "last_seen": sink["ts"]} if sink else None
    hdfs["last_flush"] = last_flush

    # MapReduce stage: YARN (cluster check) + driver heartbeat + run results
    y = cluster.get("yarn")
    drv = beats.get("demo" if source == "local-sim" else "driver")
    drv_age = now - drv["ts"] if drv else None
    last_ok = next((r for r in reversed(last_runs) if r["status"] == "success"), None)
    last_fail = next((r for r in reversed(last_runs) if r["status"] == "failed"), None)
    driver = {"status": drv["status"] if drv else None, "last_seen": drv["ts"] if drv else None,
              **(drv["detail"] if drv else {})}
    if source == "local-sim":
        mr = _stage("healthy" if drv else "unknown",
                    "local map -> sort -> reduce simulation (same mapper/reducer scripts)")
    elif drv is None:
        mr = _stage("unknown", "driver has never reported a heartbeat")
    elif drv["status"] == "stopped" or drv_age > HEARTBEAT_STALE_S:
        mr = _stage("down", f"driver not running (last heartbeat {int(drv_age)} s ago)")
    elif last_runs and last_runs[-1]["status"] == "skipped":
        mr = _stage("degraded", "latest window had no input data in HDFS (is the sink writing?)")
    elif (drv["detail"].get("consecutive_failures") or 0) > 0:
        err = (drv["detail"].get("last_error") or {}).get("message", "unknown error")
        mr = _stage("degraded", f"{drv['detail']['consecutive_failures']} failed window(s): {err[:160]}")
    elif y is not None and y["state"] != "healthy":
        mr = _stage(y["state"], f"YARN: {y.get('error', y['state'])}")
    else:
        mr = _stage("healthy", f"driver {drv['status']}; last job {last_ok['job_seconds']:.1f} s"
                    if last_ok and last_ok["job_seconds"] else f"driver {drv['status']}")
    mr.update(yarn=y, driver=driver, last_success=last_ok, last_failure=last_fail)

    # API stage: this process + snapshot freshness
    lat = _api_latency()
    if not lb:
        api = _stage("degraded", "serving, but no leaderboard has been produced yet")
    elif fresh["stale"]:
        api = _stage("degraded", f"serving a stale snapshot ({int(fresh['age_seconds'])} s old)")
    else:
        api = _stage("healthy", "serving the latest snapshot")
    api.update(latency=lat, freshness=fresh)

    in_use = {"kafka": live_pipeline, "hdfs": live_pipeline, "mapreduce": True, "api": True}
    stages = {"kafka": kafka, "hdfs": hdfs, "mapreduce": mr, "api": api}
    for name, st in stages.items():
        st["in_use"] = in_use[name]
        if not in_use[name]:
            st["note"] = "not used by the local simulation (results come from demo_local.py)"
    states = [st["state"] for n, st in stages.items() if in_use[n]]
    if "down" in states:
        overall = "down"
    elif "degraded" in states:
        overall = "degraded"
    elif "unknown" in states:
        overall = "unknown"
    else:
        overall = "healthy"
    return {"status": overall, "checked_at": now, "cluster_checked_at": cluster.get("checked_at"),
            "source": source, "data_mode": fresh["mode"], "freshness": fresh, "stages": stages}


@app.get("/api/health")
def health():
    return jsonify(build_health())


@app.get("/api/metrics")
def metrics():
    now = time.time()
    source = current_source()
    lb = load_leaderboard() or {}
    counters = store.counters()
    flushes = store.ingest(now - 1800)
    last_min = [f for f in flushes if f["ts"] >= now - 60]
    last5 = [f for f in flushes if f["ts"] >= now - 300 and f["lag_avg"] is not None]
    buckets = collections.OrderedDict()
    for f in flushes:
        b = int(f["ts"] // 60) * 60
        cur = buckets.setdefault(b, {"ts": b, "written": 0, "lag_sum": 0.0, "lag_n": 0, "write_s": 0.0})
        cur["written"] += f["written"]
        cur["write_s"] += f["write_seconds"] or 0
        if f["lag_avg"] is not None:
            cur["lag_sum"] += f["lag_avg"] * f["written"]
            cur["lag_n"] += f["written"]
    stats = store.run_stats(source)
    runs_ = store.runs(source, limit=60)
    last_ok = next((r for r in reversed(runs_) if r["status"] == "success"), None)
    val = lambda name: counters.get(name, {}).get("value")  # noqa: E731
    return jsonify({
        "measured_at": now,
        "source": source,
        "ingest": {
            "producer_sent_total": val("producer.sent"),
            "sink_consumed_total": val("sink.consumed"),
            "sink_written_total": val("sink.written"),
            "sink_write_errors_total": val("sink.write_errors") or 0,
            "tweets_written_last_min": sum(f["written"] for f in last_min) if flushes else None,
            "avg_ingest_lag_s": round(sum(f["lag_avg"] * f["written"] for f in last5) /
                                      max(sum(f["written"] for f in last5), 1), 2) if last5 else None,
            "avg_hdfs_write_s": round(sum(f["write_seconds"] for f in last5) / len(last5), 2) if last5 else None,
            "per_minute": [{"ts": b["ts"], "written": b["written"],
                            "lag_avg": round(b["lag_sum"] / b["lag_n"], 2) if b["lag_n"] else None,
                            "write_s": round(b["write_s"], 2)} for b in buckets.values()],
            "note": None if flushes else "no sink flushes recorded in the last 30 minutes",
        },
        "processing": {
            "last_job_s": last_ok["job_seconds"] if last_ok else None,
            "avg_job_s": _r(stats["avg_job"]), "max_job_s": _r(stats["max_job"]),
            "jobs_succeeded": stats["ok"] or 0, "jobs_failed": stats["failed"] or 0,
            "avg_schedule_delay_s": _r(stats["avg_delay"]),
            "distinct_hashtags": lb.get("distinct_tags"), "hashtag_mentions": lb.get("tag_mentions"),
            "tweets_in_window": lb.get("total_tweets"),
            "runs": [{"started_at": r["started_at"], "status": r["status"], "job_seconds": r["job_seconds"],
                      "attempts": r["attempts"], "schedule_delay": r["schedule_delay"]} for r in runs_],
        },
        "api": {**(_api_latency() or {"requests": 0, "avg_ms": None, "p95_ms": None}),
                "requests_since_start": _requests["count"]},
        "snapshot": {"generated_at": lb.get("generated_at"), "age_s": freshness(lb)["age_seconds"] if lb else None},
    })


def _r(x, n=2):
    return None if x is None else round(x, n)


# ---- live updates (SSE) ---------------------------------------------------------------

@app.get("/api/stream")
def stream():
    def gen():
        yield "retry: 3000\n\n"
        last_key, last_health, last_ping = None, 0.0, time.time()
        while True:
            lb = load_leaderboard()
            key = (lb or {}).get("generated_at"), (lb or {}).get("window_end")
            if key != last_key:
                last_key = key
                yield f"event: leaderboard\ndata: {json.dumps(public_leaderboard(lb))}\n\n"
                last_ping = time.time()
            if time.time() - last_health >= 10:
                last_health = time.time()
                h = build_health()
                yield f"event: health\ndata: {json.dumps(h)}\n\n"
                last_ping = time.time()
            elif time.time() - last_ping >= 15:
                yield ": keep-alive\n\n"
                last_ping = time.time()
            time.sleep(2)

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


# ---- pages ----------------------------------------------------------------------------

@app.get("/classic")
def classic():
    return render_template("index.html")


@app.get("/")
@app.get("/<path:path>")
def spa(path=""):
    if path.startswith("api/"):
        abort(404)
    if not os.path.exists(os.path.join(SPA_DIR, "index.html")):
        return render_template("index.html")  # React app not built yet: classic page
    if path and os.path.isfile(os.path.join(SPA_DIR, path)):
        return send_from_directory(SPA_DIR, path)
    resp = send_from_directory(SPA_DIR, "index.html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


monitor.start()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), threaded=True)
