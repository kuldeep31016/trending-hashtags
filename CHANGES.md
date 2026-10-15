# Upgrade log: PulseTrend dashboard and pipeline hardening

Kafka (KRaft) + HDFS + Hadoop Streaming MapReduce remain the primary pipeline. MapReduce
still does all hashtag counting; nothing replaces it. `GET /api/leaderboard` is backward
compatible, and the original page is still served at `/classic`.

## Implemented

### P0: dashboard
* New React 19 + TypeScript + Vite + Tailwind 4 + Recharts + Lucide + Framer Motion app
  (`frontend/`), built into `dashboard/static/app` and served by Flask at `/`.
* Collapsible sidebar (icon rail; drawer on mobile) with live system status; top bar with
  breadcrumb, Live/Connecting/Polling/Disconnected indicator, last update, history range,
  Pause/Resume (screen only), theme toggle (dark default, persisted); banners for stale data,
  simulation, pause and lost connection.
* Seven pages: Overview, Live Trends, Hashtag Explorer, Sentiment Analysis, Pipeline Health,
  Historical Analytics, Settings. All values come from the API; when a value is missing
  the UI says "Unavailable" / "Not yet measured" and explains why.
* Leaderboard: volume or growth ranking, filter, sortable columns, NEW vs ▲/▼ movement,
  bars relative to the largest count, sparklines, row animation on rank change (off with
  reduced motion), flash on changed counts, Simulated label on injected bursts, link to the
  Explorer.
* Charts use the validated colour-blind-safe categorical palette (dataviz validator run for
  both themes); every chart has a legend and tooltip, and the trend charts have a table view.

### P1: backend
* **Velocity and burst scoring** (`analytics/scoring.py`): documented formula, volume-scaled
  non-overlapping baseline, smoothing `k`, minimum volume, comparable-baseline rule.
* **Trend events** (`analytics/events.py`): new leader, entered/left top 5, surge (once per
  crossing).
* **SQLite history** (`analytics/store.py`, `data/pulsetrend.db`): snapshots (top 200 tags per
  window), runs, events, ingest flushes, counters, heartbeats; 7-day retention.
* **Resilient driver** (`driver/sliding_window.py`): bounded retries with backoff, job timeout,
  last good snapshot kept on failure, empty-input windows skipped (not published as zeros),
  lock file (one driver), orphaned YARN jobs killed on start, scheduling after completion,
  graceful SIGTERM, heartbeats, run records, logfmt logs.
* **API** (`dashboard/app.py`): `/api/trends`, `/api/history`, `/api/history/snapshot`,
  `/api/hashtags`, `/api/hashtags/<tag>`, `/api/sentiment`, `/api/events`, `/api/runs`,
  `/api/health`, `/api/metrics`, `/api/meta`, `/api/stream` (SSE); JSON errors, parameter
  validation, request timing. Schemas: `docs/API.md`.
* **Health checks** (`dashboard/health.py`): Kafka (connect, topic, partitions, offsets, sink
  consumer lag), HDFS (NameNode JMX, DataNodes, latest minute folder via WebHDFS), YARN
  (RM state, nodes, apps, this project's recent jobs), all in one background thread.
* **Measured metrics:** producer/sink counters, per-flush ingest lag and HDFS write time, job
  durations, schedule delay, API latency (avg/p95), snapshot age.

### P2: partly
* **Sentiment:** `prepare_data.py` keeps dataset labels (Sentiment140 0/2/4, Airline text) and
  labels synthetic phrases by template; the mapper emits `__SENT__|label` and
  `__TS__|tag|label`; the reducer sums them in the same job. Invalid or missing labels count as
  unlabeled. The UI marks template labels as experimental.
* **Orchestration:** `scripts/demo.sh` (`up / start / stop / down / status / logs / restart /
  replay / local`), Docker health checks, startup ordering, `restart: on-failure:3`, a custom
  NodeManager image with Python 3.8, environment-based configuration.
* **Demo support:** `data/tweets.meta.json` (provenance and injected bursts), 60,000-tweet
  dataset paced over 40 minutes, `producer --duration` and `--start-at` (`REPLAY_FROM`),
  replay progress on the Pipeline Health page.

### Bugs found and fixed along the way
* `hadoop.config`: Compose blanked `$HADOOP_HOME`, so every YARN job failed (`MRAppMaster`).
* The NodeManager image had no Python 3; the mapper needs ≥ 3.7.
* `ENSURE_NAMENODE_DIR` pointed at a directory that never exists, so **every NameNode restart
  reformatted HDFS** and locked the DataNode out. Fixed and verified with `docker restart namenode`.
* A stopped driver left its YARN job running, which starved the next job; orphans are now
  killed on start, and graceful stop waits for the job.
* An unreachable HDFS looked like "no data"; it now counts as a failure.

### Visual and motion pass (MyDukan look)
* Light theme is now the default (dark one click away), with MyDukan fonts: Plus Jakarta Sans for UI and
  Source Serif 4 for headings and headline figures.
* KPI cards with tinted icon tiles and mini bar charts of real per-window history; page header
  with eyebrow, title and live subtitle; sidebar status card with live clock.
* Motion: numbers count up (0 → value on load, old → new on each window); table rows and gradient
  bars grow in with a stagger; sparklines and area charts draw in; donut sweeps; dashed hover
  crosshair with exact values; pipeline connectors animate only while both stages are healthy;
  spinning "Running" ring or countdown to the driver's next run; page transitions. All motion is
  disabled under `prefers-reduced-motion`.
* New modules: Biggest movers, Latest run with next-run countdown, events timeline.
* `scripts/demo.sh reset-history` clears the dashboard history for a clean demo.

## Not implemented (future work)
* Per-minute pre-aggregation / incremental windows (so no incremental-vs-brute-force test).
* Deduplication on `event_id` (the producer now stamps one; nothing consumes it yet).
* HDFS small-file compaction.
* Containerised Python services; persistent Kafka/HDFS volumes (data is lost on `down`).
* Multi-partition / multi-consumer scaling experiments; a significance-tested burst model.

## Files

**Added:** `analytics/{__init__,scoring,events,store}.py`, `dashboard/health.py`,
`frontend/**` (React app), `scripts/demo.sh`, `docker/nodemanager.Dockerfile`,
`tests/{test_scoring,test_driver_store,test_api}.py`, `docs/{API,DEMO_SCRIPT,VIVA}.md`,
`CHANGES.md`, `.gitignore`.
**Modified:** `driver/sliding_window.py`, `mapreduce/{mapper,runner}.py`, `consumer/hdfs_sink.py`,
`producer/producer.py`, `scripts/prepare_data.py`, `common.py`, `demo_local.py`,
`dashboard/app.py`, `docker-compose.yml`, `hadoop.config`, `README.md`.
**Generated at runtime:** `data/tweets.meta.json`, `data/pulsetrend.db`, `data/run/*.pid`,
`logs/*.log`, `dashboard/static/app/` (frontend build).
**Unchanged:** `requirements.txt` (no new Python dependencies; SQLite is in the standard
library), `dashboard/templates/index.html` (now `/classic`), `tests/test_pipeline.py`.

## Verification (2026-10-15, Apple Silicon Mac, Docker Desktop)
* `python -m unittest discover -s tests`: **44 tests, OK** (6 original + 38 new).
* `npm run build`: type-check and production build succeed.
* Live pipeline via `scripts/demo.sh up`: all four stages healthy; real Hadoop jobs 45-110 s;
  `#worldcupfinal`, `#breakingnews` and `#newphonelaunch` detected as surges and new leaders
  in sequence.
* Every API endpoint returns 200 (or the documented 400/404); SSE delivers live updates.
* Failure drill: `docker stop namenode` led to retries, a failed window, Degraded/Down states and
  a stale banner with the last snapshot kept; `docker start namenode` brought automatic recovery
  in ~3 min without reformatting.
* UI checked in the browser at 1440 px (dark and light), at 375 px (mobile drawer), in local
  simulation mode, and with Pause/Resume.
