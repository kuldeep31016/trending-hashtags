# Project Brief: Real-Time Trending Hashtag Detection (Kafka + HDFS + MapReduce)

> **Note (2026-10-15):** this brief describes the project *before* the PulseTrend upgrade.
> For the current state see README.md, CHANGES.md and docs/.

This document describes the complete current state of the project, so it can be used to plan
enhancements to both the backend pipeline and the dashboard UI.

---

## 1. Problem statement

Social platforms usually compute "trending topics" with periodic batch jobs (e.g. hourly or
daily). By the time such a job runs, a viral topic has often already peaked, so the platform
notices the trend too late.

**Goal:** build a near-real-time system that ingests a continuous stream of social media posts
(tweets), stores them in a distributed file system, and **every minute** recomputes the
**top 10 hashtags over a sliding 5-minute window** using **Hadoop MapReduce**, then shows the
result on a **live web dashboard** with rank movement and trend lines.

**Hard constraint (academic project):** the problem statement requires **Kafka + HDFS +
MapReduce**. MapReduce is a batch engine, so "real time" is approximated with a 1-minute
micro-batch cadence. Any enhancement should keep MapReduce as the core processing engine
(Spark/Flink can only be discussed as future work or an optional comparison).

**Context:** this is a university/college Big Data project with a written report and a viva
(oral exam). `docs/REPORT_OUTLINE.md` lists the report sections and likely viva questions.

### Objectives
1. Stream tweet events through Apache Kafka.
2. Persist them on HDFS, organised by event-time minute.
3. Run a MapReduce job every minute over the last 5 minutes of data (sliding window).
4. Produce a top-10 hashtag leaderboard with rank changes and a short history.
5. Display it on a live, auto-refreshing dashboard.
6. Prove correctness (MapReduce output == brute-force count) with unit tests.

---

## 2. Tech stack

| Layer | Technology |
|---|---|
| Language | Python 3 (all components) |
| Messaging | Apache Kafka 3.8.0 (KRaft mode, no ZooKeeper), Docker image `apache/kafka:3.8.0` |
| Kafka client | `kafka-python` (>= 2.1.0) |
| Storage | HDFS (Hadoop 3.3.6), single NameNode + single DataNode |
| Processing | Hadoop MapReduce on YARN via **Hadoop Streaming** (mapper/reducer written in Python) |
| Cluster | Docker Compose: kafka, namenode, datanode, resourcemanager, nodemanager |
| Web backend | Flask 3 (2 routes) |
| Web frontend | One static HTML page, plain CSS + vanilla JavaScript, no framework, no chart library (hand-drawn SVG sparklines) |
| Tests | Python `unittest` |

Total code: about 1,100 lines.

---

## 3. Architecture / data flow

```
 Sentiment140 + US Airline CSV (or synthetic tweets)
          |  scripts/prepare_data.py   (merge, sample, inject demo hashtags + viral bursts)
          v
   data/tweets.jsonl   (20,000 tweets, one JSON per line)
          |  producer/producer.py      (replays file as a live stream at N tweets/sec, stamps ts=now)
          v
   [ Kafka topic "tweets" ]  (3 partitions)
          |  consumer/hdfs_sink.py     (consumer group "hdfs-sink"; buffers 10 s; groups by event minute)
          v
   HDFS  /tweets-data/tweets/YYYYMMDD/HHMM/part-<millis>-<seq>.jsonl   <- one folder per minute
          |  driver/sliding_window.py  (every 60 s: choose the last 5 minute-folders)
          v
   Hadoop Streaming job on YARN:  mapper.py -> combiner (reducer.py) -> reducer.py
          |  output: (hashtag, count) + (__TOTAL__, tweet count)
          v
   driver: sort, top 10, rank delta vs previous window, sparkline series (last 12 windows)
          |  writes dashboard/leaderboard.json atomically
          v
   Flask  GET /api/leaderboard  ->  browser polls every 3 s and re-renders
```

There is also a **local mode** (`demo_local.py`) that runs the same mapper/reducer as a local
`map -> sort -> reduce` pipe on a simulated clock (45 simulated minutes, 400 tweets/minute),
writing to a local folder that mimics the HDFS layout. It needs no Kafka and no Hadoop.

---

## 4. Components in detail

### 4.1 `scripts/prepare_data.py`: dataset builder
- Inputs (optional): **Sentiment140** (1.6M tweets from 2009) and **Twitter US Airline
  Sentiment** (14.6k tweets from 2015). Airline is capped at 1/3 of the limit; Sentiment140 is
  reservoir-sampled (memory-safe over 1.6M rows).
- With no input files, it generates **synthetic tweets** from 12 phrase templates.
- **Enrichment** (on by default, `--no-enrich` disables it): the real datasets have almost no
  hashtags and no usable timeline, so:
  - 25% of tweets get a background hashtag picked from 25 tags with Zipf-like weights
    (love, music, monday, friday, news, food, travel, ...).
  - Three injected **viral bursts**, defined as slices of the stream:
    `#WorldCupFinal` (30–42% of the stream, 45% of tweets), `#BreakingNews` (62–74%, 40%),
    `#NewPhoneLaunch` (82–92%, 30%).
- Output: `data/tweets.jsonl`, records `{id, user, text, source}`. Seeded RNG (42) so runs are reproducible.

### 4.2 `producer/producer.py`: Kafka producer
- Replays `tweets.jsonl` into topic `tweets` at `--rate` tweets/sec (default 50, used at 100).
- Overwrites `ts` with the current time, so old datasets behave like a live stream.
- `--loop` restarts from the top of the file forever.

### 4.3 `consumer/hdfs_sink.py`: Kafka to HDFS sink
- Consumer group `hdfs-sink`, manual offset commits.
- Buffers records for `--flush-secs` (10 s), groups them by **event-time minute**, and writes one
  file per minute per flush.
- **At-least-once:** Kafka offsets are committed only after the HDFS write succeeds.
- **Atomic publish:** writes `_name.tmp`, then renames it (Hadoop ignores `_`/`.` files, so a job
  never reads a half-written file).

### 4.4 `common.py`: shared helpers
- `minute_key(ts)` turns an epoch time into `YYYYMMDD/HHMM` (UTC).
- `window_keys(end_ts, 5)` returns the 5 minute keys of the window (current + previous 4).
- `LocalStorage` (folder that mimics HDFS) and `HdfsStorage` (wraps the `hdfs dfs` CLI, can run
  through a prefix such as `docker exec -i namenode`).

### 4.5 `mapreduce/mapper.py`, `reducer.py`, `runner.py`: the MapReduce job
- **Mapper:** parses each JSON tweet, HTML-unescapes the text, extracts hashtags with regex
  `(?<!\w)#(\w+)`, lowercases them, counts each hashtag **once per tweet**, skips numeric tags
  and tags shorter than 2 or longer than 50 characters. Emits `tag\t1`, plus `__TOTAL__\t1` per tweet.
  Malformed lines are skipped.
- **Reducer:** sums the counts per key. It is **also used as the combiner** (sum is associative
  and commutative), which cuts shuffle traffic.
- **Runner:** `run_hadoop` submits a Hadoop Streaming job (`-input` = each existing minute
  folder in the window, 1 reducer), reads `part-*` output, then deletes the output dir.
  `run_local` simulates the same flow with subprocess pipes and a Python sort.

### 4.6 `driver/sliding_window.py`: scheduler and leaderboard builder
- Every 60 s (aligned to the minute boundary + 2 s), it runs the job over the 5-minute window.
- Top 10 sorted by count desc, ties broken alphabetically.
- **Rank delta** vs the previous snapshot (positive = moved up, `null` = new entry).
- Keeps a **history** of the last 30 windows (top 50 tags each); each top-10 entry gets a
  **sparkline series** of its counts in the last 12 windows.
- Writes `dashboard/leaderboard.json` atomically (temp file + rename).

### 4.7 `dashboard/app.py` + `dashboard/templates/index.html`: the UI
Flask routes:
- `GET /` serves the page.
- `GET /api/leaderboard` returns the JSON below (with `history` stripped), `Cache-Control: no-store`.
  If there's no file yet, it returns `{"top": [], "status": "waiting for first window"}`.

**API response schema:**
```json
{
  "generated_at": "2026-10-14T18:38:33+00:00",
  "window_minutes": 5,
  "window_start": 1792002120,
  "window_end": 1792002402.33,
  "total_tweets": 26954,
  "job_seconds": 46.55,
  "top": [
    {"rank": 1, "tag": "love", "count": 1771, "delta": 2,
     "series": [120, 340, 900, 1500, 1771]}
  ]
}
```
(`delta`: positive = moved up N places, negative = moved down, 0 = same, `null` = new.
 `series`: counts in up to the last 12 windows, oldest first.)

**Current UI (deliberately minimal):**
- Single page, dark GitHub-like theme, max-width 860px, system font.
- Header: "Trending hashtags" + subtitle "Last 5 minutes (HH:MM to HH:MM), refreshed every minute".
- 3 stat cards: *Tweets in window*, *Last job (s)*, *Updated* (time).
- 10 rows, each with: rank number, `#tag`, a horizontal bar (relative to #1), count,
  movement badge (green ▲ N / red ▼ N / grey – / yellow NEW), and a 96×28 SVG sparkline.
- Polls the API every 3 s and rebuilds the list (no animation between states except bar width).
- Basic mobile layout (hides the sparkline under 560px). Empty state when there is no data.
- No charts library, no navigation, no filters, no history view, no drill-down, no light theme,
  no system/pipeline health view.

### 4.8 `tests/test_pipeline.py`
6 unit tests: window key calculation; mapper rules (case-insensitive, once per tweet, HTML
entities, `price#tag` not a hashtag, 1-char tags ignored); **MapReduce result equals a
brute-force Counter** and excludes minutes outside the window; multiple files per minute;
top-10 + rank movement; stable tie-break.

### 4.9 Infrastructure
- `docker-compose.yml`: Kafka (KRaft, 3 partitions, port 9092), NameNode (UI :9870, mounts
  `./mapreduce` at `/project/mapreduce` read-only), DataNode, ResourceManager (UI :8088),
  NodeManager (custom image `docker/nodemanager.Dockerfile`, which adds Python 3.8 because the
  base `apache/hadoop:3.3.6` image is CentOS 7 with only Python 2).
- `hadoop.config`: Hadoop XML settings passed as environment variables (replication 1,
  YARN 4 GB memory, `HADOOP_MAPRED_HOME=/opt/hadoop`, capacity scheduler).

---

## 5. How it runs

**Local demo (no Docker):**
```bash
pip install flask
python scripts/prepare_data.py
python demo_local.py --delay 2          # replays 45 simulated minutes
python dashboard/app.py                 # http://localhost:5000 (PORT env var to change)
```

**Full pipeline:**
```bash
docker compose up -d --build
python consumer/hdfs_sink.py --backend hdfs --exec-prefix "docker exec -i namenode"
python producer/producer.py --rate 100 --loop
python driver/sliding_window.py --backend hdfs --exec-prefix "docker exec -i namenode"
python dashboard/app.py
```
Four separate long-running processes in four terminals; nothing orchestrates them together.

**Observed results (full pipeline, Apple Silicon Mac, Hadoop image under x86 emulation):**
- Window of ~6k tweets: job ≈ 47 s; window of ~23–27k tweets: job ≈ 115 s.
- When a job takes longer than the 60 s interval, the dashboard updates less often than once a minute.
- The demo correctly shows `#worldcupfinal`, then `#breakingnews`, then `#newphonelaunch`
  surging to #1 and fading as the window slides.

---

## 6. Known limitations and weaknesses

1. **Latency:** about 1 minute + YARN job start-up (15–45 s+), not true real time.
2. **Redundant work:** consecutive windows overlap by 4 minutes, so each minute of data is
   re-processed 5 times (an incremental per-minute pre-aggregation would be about 5x cheaper).
3. **"Trending" = highest count**, not fastest growth. Always-popular tags (#love) dominate;
   there is no velocity / z-score / anomaly-based trend score.
4. **Small files problem:** one small HDFS file per minute per flush; no compaction.
5. **At-least-once:** duplicates are possible after a sink crash; no dedupe on tweet id.
6. **Data is partly synthetic:** viral bursts are injected; timestamps are assigned at replay time.
7. **Fragile driver:** if a Hadoop job fails, the driver crashes (no retry); jobs can pile up if
   one runs longer than the interval; no job overlap protection.
8. **No orchestration:** 4 manual processes; no health checks, no single start command, no
   process supervision; the Python apps are not containerised.
9. **State in a JSON file:** the leaderboard and history live in one local file; there's no database,
   so there's no long-term history and no querying past windows.
10. **Single node, 1 reducer, 1 consumer:** no demonstration of horizontal scaling.
11. **UI is basic:** one list, polling every 3 s, no charts beyond tiny sparklines, no
    interactivity, no pipeline monitoring, no historical/analytical views.
12. **Unused data:** Sentiment140 and Airline datasets have sentiment labels, but sentiment is not used.
13. **No auth, no config file, no logging framework, no metrics.**

---

## 7. What I want help with

I want to enhance this project in two directions, while keeping Kafka + HDFS + MapReduce as
the core (it's a requirement of the academic problem statement):

**A. Backend / pipeline enhancements:** for example better trend scoring (velocity, z-score,
burst detection), per-minute pre-aggregation, sentiment per hashtag, dedupe, a more robust
driver, containerising and orchestrating all components, storing history, metrics and
monitoring, scaling to multiple partitions/consumers/reducers.

**B. A much richer, professional, visually impressive dashboard UI:** the current page is a
single dark list. I want a polished, modern, interactive analytics dashboard (for example a
React or Next.js frontend with a charting library, real-time updates via WebSocket/SSE instead
of polling, animated rank changes, trend charts over time, per-hashtag detail pages, sentiment
breakdown, pipeline health panels for Kafka/HDFS/YARN/job durations, filters, dark/light theme,
responsive design).

Please propose a prioritised, step-by-step enhancement plan covering both A and B, with the
architecture changes, new API endpoints/data needed, UI pages and components, and what will
look most impressive in a report and viva demo.
