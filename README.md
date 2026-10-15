# PulseTrend: Real-Time Trending Hashtag Detection (Kafka + HDFS + MapReduce)

**Problem:** platforms notice a viral topic only after it peaked, because trends are computed in
periodic batch jobs. **This project** streams posts through **Kafka**, stores them on **HDFS** in
per-minute folders, and re-runs a **Hadoop MapReduce** job about every minute over the **last 5
minutes** to publish a top-10 hashtag leaderboard, a growth ("velocity") ranking, sentiment
aggregates and trend events on a live analytics dashboard.

[Architecture](#architecture) · [Demo script](docs/DEMO_SCRIPT.md) · [API](docs/API.md) ·
[Viva notes](docs/VIVA.md) · [What changed](CHANGES.md)

## Architecture

```
 Sentiment140 + Airline CSV (or seeded synthetic tweets)
          |  scripts/prepare_data.py   merge, sample, keep sentiment labels, inject demo bursts
          v                            -> data/tweets.jsonl + data/tweets.meta.json
   producer/producer.py      replays the file as a live stream, stamps event time
          v
   [ Kafka topic "tweets", 3 partitions, KRaft ]
          |  consumer/hdfs_sink.py   groups by event minute; write-then-rename; commit after write
          v
   HDFS  /tweets-data/tweets/YYYYMMDD/HHMM/part-*.jsonl          <- one folder per minute
          |  driver/sliding_window.py  every 60 s: last 5 minute-folders -> one MapReduce job
          v
   Hadoop Streaming on YARN:  mapper.py -> combiner (reducer.py) -> reducer.py
          |  (hashtag, count), (__TOTAL__, n), (__SENT__|label, n), (__TS__|tag|label, n)
          v
   driver: top 10 by volume, velocity + burst scores, sentiment, trend events, rank movement
          |-> dashboard/leaderboard.json   latest window (atomic replace)
          |-> data/pulsetrend.db (SQLite)  snapshots, runs, events, ingest metrics, heartbeats
          v
   Flask API (REST + Server-Sent Events)  ->  React dashboard (frontend/, served at /)
```

Kafka, HDFS and MapReduce do all the counting. SQLite only stores **finished** windows for the
dashboard's history pages. It never counts anything.

## Quick start

### Full pipeline (Docker), one command

Needs Docker Desktop, Python 3.9+ and Node.js 18+ (Node is only needed once, to build the dashboard).

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
scripts/demo.sh up        # cluster + sink + driver + producer + dashboard
```

Open **http://localhost:5050**. The first window appears after the first MapReduce job, about
1-2 minutes later. HDFS UI: http://localhost:9870 · YARN UI: http://localhost:8088.

```bash
scripts/demo.sh status            # processes, containers and the pipeline's health verdict
scripts/demo.sh logs driver       # follow a service log (producer | sink | driver | dashboard)
scripts/demo.sh replay            # replay the dataset (injected bursts) from the start
REPLAY_FROM=0.27 scripts/demo.sh replay   # start just before the first burst
scripts/demo.sh restart driver    # restart one service (driver finishes its job first)
scripts/demo.sh stop              # stop the Python services, keep the cluster
scripts/demo.sh down              # stop everything (HDFS is emptied; history in SQLite stays)
```

### Local simulation (no Docker)

```bash
.venv/bin/pip install flask
scripts/demo.sh local             # demo_local.py + dashboard on http://localhost:5050
```

The same mapper/reducer run through a local `map | sort | reduce` pipe on a simulated clock
(45 minutes replayed in about 3 minutes). The dashboard says it is a simulation and marks Kafka,
HDFS and YARN as "not used". Do not run it while the live driver runs, since both write the same
leaderboard (`demo.sh local` refuses to).

### Tests

```bash
.venv/bin/python -m unittest discover -s tests -v     # 42 tests, no Kafka/Hadoop needed
cd frontend && npm install && npm run build           # type-check + production build
```

## Hosted replay (Vercel)

Live link: **https://pulsetrend-dsce.vercel.app**. Vercel only hosts websites, so it can't run
Kafka, HDFS or YARN. The hosted site plays back a **recorded real run** of this pipeline instead:
`scripts/record_replay.py` saves every MapReduce window as the API served it, and the dashboard
built with `VITE_REPLAY=1` answers its API calls from those files and loops through the windows
(a banner says it is a recorded replay). To refresh it:

```bash
.venv/bin/python scripts/record_replay.py --minutes 35     # while scripts/demo.sh up is running
cd frontend && npm run build:replay && cd dist-replay
vercel link --yes --project trending-hashtags && vercel deploy --prod --yes
vercel alias set <deployment-url> pulsetrend-dsce.vercel.app
```

## Dashboard

| Page | What it shows (all from real pipeline output) |
|---|---|
| Overview | KPIs with previous-window comparison, top 10 (volume or growth), trend chart with surge markers, pipeline flow, sentiment snapshot, events, job durations |
| Live Trends | Volume vs velocity ranking with score components, the formula, live parameters, surge events |
| Hashtag Explorer | Search; per-hashtag counts, rank history, growth/burst, first/last seen, sentiment, events |
| Sentiment Analysis | Window sentiment, per-hashtag split, share over time, label provenance |
| Pipeline Health | Kafka (topic, offsets, consumer lag), HDFS (DataNodes, last write), YARN apps, driver, API latency, ingest charts, failures |
| Historical Analytics | Date/time filter, past leaderboards, hashtag comparison, durations, tweets per window, event timeline |
| Settings | Theme, SSE/polling, intervals, dataset provenance, pipeline configuration, API links |

The top bar shows live/connecting/disconnected state, last update time, the chart history range,
**Pause** (stops screen updates only; the pipeline keeps running) and the theme toggle. A banner
flags stale data, simulation mode, a paused screen or a lost API connection. Injected demo
bursts are labelled **Simulated** wherever they appear. The original page is still at `/classic`.

Frontend stack: React 19 + TypeScript + Vite, Tailwind CSS 4, Recharts, Lucide icons, Framer
Motion (rank-change animation, disabled under `prefers-reduced-motion`). Development:
`cd frontend && npm run dev` (port 5173, proxies `/api` to Flask on `API_PORT`, default 5050).

## Trend scoring

* **Volume** (academic baseline, unchanged): highest count in the window, ties alphabetical.
* **Velocity**: `growth = (c − p)/(p + k)`, `score = growth × log2(1 + c)`, where `p` is the
  count in the non-overlapping window that ended 5 minutes earlier, scaled to current stream
  volume. Defaults: `k = 20`, at least 10 mentions, and the baseline window must hold at least
  half the current tweets. A tiny 1 → 2 change therefore scores near zero.
* **Burst**: `(c − mean)/(std + 1)` against up to 10 earlier windows. This is a heuristic: the
  windows overlap, so it is not a significance test.
* **Events**: new #1, entered/left the top 5, and a surge each time the score crosses 8.

Tune with driver flags: `--velocity-k`, `--min-count`, `--lookback-minutes`. Details and
reasoning: [docs/VIVA.md](docs/VIVA.md).

## Reliability features

* **Driver:** bounded retries with exponential backoff (`--retries 3 --retry-backoff 10`); a
  failed window never overwrites the last good snapshot; job timeout (`--job-timeout 900`);
  one driver at a time (lock file); orphaned YARN jobs from a killed driver are killed on
  start; the next run is scheduled after the previous one finishes, so slow jobs skip ticks
  instead of piling up; SIGTERM finishes the running job, then exits. A window whose input
  folders do not exist is recorded as *skipped* (not published as zeros), and an unreachable
  HDFS counts as a failure, never as "no data".
* **HDFS restarts:** the NameNode formats only a brand-new container, so `docker restart
  namenode` keeps the data and the DataNode registration (verified).
* **Sink:** offsets are committed only after the HDFS write (at-least-once); write-then-rename
  publishing; failed writes are retried with the same buffer.
* **Dashboard:** stale-data detection (snapshot older than `max(180 s, 2 × (interval + last
  job))`); every stage is checked on its own, so an HTTP 200 never implies a healthy pipeline;
  SSE with automatic polling fallback.
* **Logs:** `logs/<service>.log`, logfmt (`ts=… level=… component=… msg=… key=value`).

## Configuration (environment)

| Variable | Default | Used by |
|---|---|---|
| `PORT` | 5050 (`demo.sh`), 5000 (`app.py`) | dashboard port; macOS AirPlay uses 5000 |
| `DURATION` / `RATE` | 40 min per pass / unset | `demo.sh` producer pacing |
| `TWEETS` | 60000 | `demo.sh` dataset size when generating |
| `DB_PATH` | `data/pulsetrend.db` | driver, sink, producer, API |
| `LEADERBOARD` | `dashboard/leaderboard.json` | API |
| `KAFKA_BOOTSTRAP`, `HDFS_HTTP`, `YARN_HTTP` | localhost:9092, :9870, :8088 | health checks |
| `DRIVER_INTERVAL` | 60 | API staleness threshold |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Port 5000 busy on macOS | AirPlay Receiver; use `PORT=5050` (the `demo.sh` default) |
| Jobs fail with `MRAppMaster` class not found | `hadoop.config` must say `HADOOP_MAPRED_HOME=/opt/hadoop` (Compose drops `$HADOOP_HOME`) |
| `python3: command not found` in job logs | the NodeManager must use the built image: `docker compose up -d --build nodemanager` |
| Dashboard frozen and YARN busy after a driver kill | `scripts/demo.sh restart driver` kills orphaned jobs on start |
| "Stale data" banner | `scripts/demo.sh status`; then check `logs/driver.log` and the Pipeline Health page |
| Jobs take 45-120 s | expected on Apple Silicon: the Hadoop images are amd64 and run under emulation |
| Dashboard shows the classic page | the React build is missing: `cd frontend && npm install && npm run build` |
| Growth ranking empty | needs one full window of history (5 min) and hashtags with ≥ 10 mentions |
| "no active NodeManagers" / job stuck after an HDFS outage | the NodeManager can freeze while fetching job files; `docker restart nodemanager` (the driver times the job out and retries) |
| Charts full of gaps from earlier testing | `scripts/demo.sh reset-history` before the demo, then let it run ~30 min |

## Known limitations

* Near-real-time, not real-time: about one minute plus job start-up (45-120 s here), so
  windows can arrive every ~2 minutes when a job overruns the 60 s schedule.
* Overlapping windows recompute about 80% of the same data each run (per-minute
  pre-aggregation is not implemented; see CHANGES.md).
* At-least-once ingestion: duplicates are possible after a sink crash (no dedupe yet; the
  producer now stamps a unique `event_id` to make it possible).
* Small files on HDFS (one per minute per flush); no compaction.
* HDFS and Kafka data live inside the containers and are lost on `docker compose down`.
* Python services run on the host, not in containers. `demo.sh` supervises them.
* The demo data is synthetic with injected bursts, and its sentiment labels come from phrase
  templates; the real Sentiment140/Airline datasets give genuine labels (`prepare_data.py --sentiment140 … --airline …`).

## Real datasets

```bash
.venv/bin/python scripts/prepare_data.py --sentiment140 data/training.1600000.processed.noemoticon.csv \
                                         --airline data/Tweets.csv --limit 60000
```

Sentiment140 (2009) has few hashtags and no usable timeline, so by default the script appends
background hashtags and three simulated viral bursts; `--no-enrich` keeps the original text.
The bursts are recorded in `data/tweets.meta.json`, and the dashboard labels them Simulated.
