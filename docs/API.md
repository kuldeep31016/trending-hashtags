# Dashboard API

Base URL: `http://localhost:5050` (Flask, `dashboard/app.py`). All endpoints are `GET`, return
JSON, and send `Cache-Control: no-store` and a `Server-Timing` header. No request ever starts a
Hadoop job: the API only reads what the scheduled pipeline has already produced
(`dashboard/leaderboard.json` and `data/pulsetrend.db`).

Times are Unix epoch **seconds** (floats) unless named `generated_at` (ISO-8601 UTC).
`source` is `hadoop` (live pipeline), `local` (driver on local files) or `local-sim`
(`demo_local.py`). History endpoints answer for the source of the current leaderboard.

## Errors

```json
{"error": {"code": "invalid_parameter", "message": "mode must be 'volume' or 'velocity'"}}
```

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_parameter`, `missing_parameter` | bad/missing query value (numbers are range-checked) |
| 404 | `not_found` | unknown hashtag, no snapshot, unknown `/api/...` route |
| 500 | `internal_server_error` | unexpected failure (logged by Flask) |

## `GET /api/leaderboard`

The latest window. **Backward compatible**: `generated_at, window_minutes, window_start,
window_end, total_tweets, job_seconds, top[]` with `rank, tag, count, delta, series` keep their
original meaning; everything else is additive. Before the first window:
`{"top": [], "status": "waiting for first window", "freshness": {...}}`.

```json
{
  "generated_at": "2026-10-14T19:24:46+00:00",
  "source": "hadoop",
  "window_minutes": 5, "window_start": 1792005540, "window_end": 1792005782.0,
  "total_tweets": 6000, "distinct_tags": 26, "tag_mentions": 3339, "job_seconds": 104.21,
  "top": [{
    "rank": 1, "tag": "worldcupfinal", "count": 1854,
    "delta": 1,                       // +up / -down / 0 same / null = new in the top 10
    "series": [0, 0, 0, 0, 0, 0, 0, 267, 1854],   // counts in up to the last 12 windows
    "baseline_count": 0.0, "growth": 92.7, "trend_score": 1006.46, "burst_score": 20.39,
    "sentiment": {"positive": 895, "neutral": 451, "negative": 508}   // or null
  }],
  "trending": [ /* top 10 by trend score: same fields + "volume_rank" */ ],
  "sentiment": {"positive": 2992, "neutral": 1455, "negative": 1553, "labeled": 6000, "unlabeled": 0},
  "previous": {"window_end": 1792005662.0, "total_tweets": 5911, "distinct_tags": 26,
               "tag_mentions": 3120, "job_seconds": 97.0, "generated_at": "..."},   // or null
  "scoring": {"k": 20.0, "min_count": 10, "lookback_seconds": 300, "baseline_end": 1792005422.0,
              "baseline_scale": 1.0, "surge_score": 8.0},
  "events": [ /* events detected in this window, see /api/events */ ],
  "freshness": {"age_seconds": 12.4, "stale": false, "stale_after": 328, "mode": "live"}
}
```

`freshness.mode`: `live` · `stale` (older than `stale_after`) · `simulation` ·
`simulation-finished` · `empty`.

## `GET /api/trends?mode=volume|velocity&limit=10`

`limit` 1-50. Returns `{mode, source, window_end, scoring, items[], note}`; `items` are
`top` (volume) or `trending` (velocity) entries. `note` explains an empty velocity list
(no baseline window yet).

## `GET /api/history?tags=a,b&from=&to=&limit=240`

Up to 10 tags (default: current top 5; a leading `#` and case are ignored). `limit` 1-2000.

```json
{
  "source": "hadoop", "tags": ["love", "worldcupfinal"],
  "snapshots": [{"id": 9, "end_ts": 1792005782.0, "window_start": 1792005540.0, "window_minutes": 5,
                 "total_tweets": 6000, "distinct_tags": 26, "tag_mentions": 3339,
                 "job_seconds": 104.21, "sentiment": {...}}],
  "series": {"love": [{"end_ts": 1792005782.0, "count": 444, "rank": 2}]},   // count 0 / rank null when absent
  "retention": {"days": 7, "oldest": 1792002300.0, "newest": 1792005782.0, "snapshots": 9}
}
```

## `GET /api/history/snapshot?at=<end_ts>&limit=10`

The stored leaderboard of the latest window ending at or before `at`:
`{"snapshot": {...}, "top": [{"tag", "count", "rank", "positive", "neutral", "negative"}]}`.
404 when there is none. The top 200 hashtags of every window are stored.

## `GET /api/hashtags?q=wor&limit=20`

Substring search over stored hashtags: `{"query", "items": [{"tag", "peak_count", "last_seen"}]}`.

## `GET /api/hashtags/<tag>`

```json
{
  "tag": "love", "source": "hadoop",
  "current": {"window_end": ..., "count": 444, "rank": 2, "in_top": true, "delta": -1,
              "growth": -0.03, "trend_score": -0.2, "baseline_count": 456.0, "burst_score": 1.1,
              "velocity_rank": null, "sentiment": {...}},
  "overview": {"first_seen": ..., "last_seen": ..., "windows": 9, "peak_count": 444, "best_rank": 1,
               "positive": ..., "neutral": ..., "negative": ...},
  "series": [{"end_ts": ..., "count": ..., "rank": ...}],
  "events": [ ... ]
}
```

Scores are published for hashtags in the top 10 by volume or by growth; for others they are
`null`. 404 if the hashtag never appeared in a stored window.

## `GET /api/sentiment?from=&limit=240`

```json
{"available": true, "reason": null,
 "provenance": "template",          // "template" (synthetic) | "dataset" | null (no metadata)
 "note": "Synthetic tweets: each phrase template has a fixed label…",
 "current": {"positive": ..., "neutral": ..., "negative": ..., "labeled": ..., "unlabeled": ...},
 "by_tag": [{"tag": "love", "count": 444, "positive": ..., "neutral": ..., "negative": ...}],
 "series": [{"end_ts": ..., "positive": ..., "neutral": ..., "negative": ...}]}
```

`available` is false (with `reason`) when the window has no labeled tweets. Nothing is estimated.

## `GET /api/events?from=&to=&limit=50&tag=`

```json
{"source": "hadoop", "items": [{"id": 14, "end_ts": 1792005782.0, "created": 1792005886.2,
  "tag": "worldcupfinal", "kind": "new_leader", "detail": {"previous": "love", "count": 1854}}]}
```

`kind`: `new_leader` · `entered_top` / `left_top` (top 5) · `surge` (trend score crossed
`surge_score`; `detail` has `count, baseline_count, growth, trend_score`).

## `GET /api/runs?from=&limit=100`

MapReduce runs recorded by the driver (oldest first) and aggregate stats:

```json
{"items": [{"started_at": ..., "finished_at": ..., "end_ts": ..., "status": "success", "attempts": 1,
            "job_seconds": 104.2, "schedule_delay": 0.01, "input_minutes": 5, "error": null}],
 "stats": {"ok": 9, "failed": 0, "avg_job": 85.4, "max_job": 109.6, "avg_delay": 0.006}}
```

## `GET /api/health`

Cluster checks run in a background thread every 10 s (timeouts 2-5 s); this endpoint combines
the cached result with heartbeats and run history, so it answers in a few milliseconds.

```json
{"status": "healthy",                         // healthy | degraded | down | unknown (stages in use only)
 "checked_at": ..., "cluster_checked_at": ..., "source": "hadoop", "data_mode": "live",
 "freshness": {...},
 "stages": {
   "kafka":     {"state": "healthy", "summary": "topic 'tweets' with 3 partitions", "in_use": true,
                 "check": {"reachable": true, "partitions": 3, "end_offset_total": 21696, "consumer_lag": 744, ...},
                 "producer": {"status": "running", "rate_per_s": 25.0, "position": 21000, "file_tweets": 60000, ...}},
   "hdfs":      {"state": ..., "check": {"live_datanodes": 1, "fs_state": "Operational", "last_write": ...,
                 "latest_minute_folder": "20261014/1921"}, "sink": {...}, "last_flush": ...},
   "mapreduce": {"state": ..., "yarn": {"active_nodes": 1, "apps_running": 1, "recent_apps": [...]},
                 "driver": {"status": "idle", "next_run_at": ..., "consecutive_failures": 0, ...},
                 "last_success": {...}, "last_failure": null},
   "api":       {"state": ..., "latency": {"requests": 76, "avg_ms": 3.3, "p95_ms": 10.5}, "freshness": {...}}}}
```

Rules: Kafka is degraded without producer activity for 60 s; HDFS is degraded without a sink
write for 60 s; MapReduce is down without a driver heartbeat for 45 s and degraded after failed
windows; the API is degraded when the snapshot is stale. In `local-sim` mode Kafka and HDFS are
`in_use: false` and do not affect `status`.

## `GET /api/metrics`

Measured values only (`null` when not measured):

```json
{"ingest": {"producer_sent_total": 21000, "sink_consumed_total": ..., "sink_written_total": 20952,
            "sink_write_errors_total": 0, "tweets_written_last_min": 1500, "avg_ingest_lag_s": 10.7,
            "avg_hdfs_write_s": 1.1, "per_minute": [{"ts": ..., "written": ..., "lag_avg": ..., "write_s": ...}]},
 "processing": {"last_job_s": 104.2, "avg_job_s": 85.4, "max_job_s": 109.6, "jobs_succeeded": 9,
                "jobs_failed": 0, "avg_schedule_delay_s": 0.01, "distinct_hashtags": 26,
                "hashtag_mentions": 3339, "tweets_in_window": 6000, "runs": [...]},
 "api": {"requests": 76, "avg_ms": 3.3, "p95_ms": 10.5, "requests_since_start": 512},
 "snapshot": {"generated_at": "...", "age_s": 12.4}}
```

Ingest lag = flush time minus event time (it includes the sink's 10 s buffer).

## `GET /api/meta`

Dataset provenance from `data/tweets.meta.json` (sources, seed, injected bursts, sentiment
label provenance) and pipeline configuration (window, interval, scoring, retention, UI links).

## `GET /api/stream` (Server-Sent Events)

```
event: leaderboard      data: <same JSON as /api/leaderboard>     (on connect and on every new window)
event: health           data: <same JSON as /api/health>          (every 10 s)
: keep-alive                                                      (every 15 s when idle)
```

The browser uses `EventSource` and falls back to polling `/api/leaderboard` + `/api/health`
after 3 failed reconnects (or when "Polling" is chosen in Settings). WebSockets are not used
because the dashboard only receives data.
