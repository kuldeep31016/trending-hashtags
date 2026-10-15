# Architecture and viva talking points

## One-paragraph summary

Tweets are replayed as a live stream into **Kafka**. A sink consumer groups them by the minute
of their event time and writes one folder per minute to **HDFS**. Every minute a driver picks
the last five minute-folders and submits one **Hadoop Streaming MapReduce** job to YARN. The
job counts hashtags (and sentiment labels) in that 5-minute sliding window. The driver ranks the
result by volume and by growth, detects trend events, and publishes the window to a JSON
snapshot and a small SQLite history. A Flask API streams it to a React dashboard over
Server-Sent Events. MapReduce does all the counting; everything after it only orders,
compares and displays finished results.

## Why each component

| Component | Role | Why it is the right tool here |
|---|---|---|
| **Kafka** (KRaft, 3 partitions) | Durable buffer between producers and storage | Decouples ingest rate from storage speed; retains data if the sink is down; partitions allow parallel consumers; ordering is per partition, which counting does not need |
| **HDFS** (minute folders) | Durable, distributed input for batch jobs | MapReduce reads HDFS natively; folder-per-minute makes the window a folder selection, so old data is never scanned |
| **MapReduce** (Hadoop Streaming, Python) | The counting engine | Required by the brief; embarrassingly parallel counting; the combiner cuts shuffle traffic; the same scripts run locally for tests |
| **Driver** | Scheduler + post-processing | The job's output is small (one row per distinct hashtag), so sorting the top 10 in the driver beats a second MR job |
| **SQLite** | History of finished windows | Lightweight, file-based, no extra service; stores results, never raw tweets |
| **Flask + SSE** | API and live push | Server-to-browser only, so SSE is simpler than WebSockets and degrades to polling |

## The MapReduce job

* **Map:** parse a JSON tweet, extract `#\w+` (not glued to a word), lowercase, count each
  hashtag once per tweet, skip numeric and 1-character tags. Emit `tag 1`, plus `__TOTAL__ 1`.
  If the tweet has a valid sentiment label, also emit `__SENT__|label 1` and `__TS__|tag|label 1`.
* **Combine = Reduce:** sum per key. Safe as a combiner because addition is associative and
  commutative, and it sends far fewer records through the shuffle.
* **Correctness:** unit tests check that the MapReduce result equals a brute-force `Counter`
  over the same minutes, and that minutes outside the window are excluded.

## The sliding window

* Event-time bucketing: a tweet lands in the folder of the minute it *happened*, so a late
  tweet still joins the right minute and is counted in the next recompute.
* Window = current minute + previous four. Consecutive windows overlap by four minutes:
  each minute is processed five times (simple, at the cost of about 5x redundant work).
* Scheduling: the next run starts at the interval boundary after the previous job finished.
  When a job takes 90 s, ticks are skipped instead of queuing overlapping jobs.

## Trend scoring (what "trending" means)

* **Volume** (baseline, required): highest count in the window.
* **Velocity:** `growth = (c − p)/(p + k)`, `score = growth × log2(1 + c)`.
  * `p` comes from the window that ended 5 minutes earlier, so the two windows don't overlap
    (otherwise 80% of each count would be shared).
  * `p` is scaled by `T_now/T_base` so that a busier stream alone doesn't count as growth.
  * `k = 20` damps small baselines (1 → 2 mentions is not "+100%"); `log2(1 + c)` rewards
    real volume; at least 10 mentions are required; the baseline window must hold at least half
    the current tweets, or there is no velocity yet.
* **Burst:** `(c − mean)/(std + 1)` over up to 10 earlier windows. Say clearly: the windows
  overlap and are correlated, so this is a ranking heuristic, **not a statistical test**.
* **Events:** new #1, entering/leaving the top 5, and a surge each time the score crosses 8.

## Reliability and its guarantees

* **At-least-once ingest:** Kafka offsets are committed only after the HDFS write succeeds;
  after a crash the batch is replayed, so duplicates are possible. Exactly-once would need
  idempotent writes or dedupe on `event_id` (now stamped by the producer, dedupe not built).
* **No half-written input:** files are written as `_name.tmp` and renamed, and Hadoop ignores `_`
  and `.` files.
* **Driver:** bounded retries with backoff; a failed window keeps the last good snapshot,
  and the UI marks it stale; a window without input folders is skipped, not published as zeros;
  one driver at a time (lock); leftover YARN jobs from a killed driver are killed on start-up;
  SIGTERM lets the running job finish.
* **Health is checked, not assumed:** each stage (Kafka offsets/lag, NameNode/DataNodes and last
  write, YARN nodes/apps and the driver heartbeat, API latency and snapshot age) has its own check.
  An HTTP 200 from the API never means "healthy pipeline".

## Measured numbers (Apple Silicon Mac, Docker Desktop, Hadoop under amd64 emulation)

* Producer 25 tweets/s → about 7,500 tweets per 5-minute window.
* MapReduce job: 45-110 s per window (YARN start-up dominates), so windows arrive every
  1-2 minutes. On native x86 Hadoop this would be much lower; it was not measured here.
* Ingest lag (flush time − event time): about 10 s, mostly the sink's 10 s buffer.
* API: a few milliseconds per request (reads one JSON file and SQLite).

## Likely questions

* **Is this real time?** Near-real-time: latency is about one window cadence plus job time.
  MapReduce is a batch engine; Spark Structured Streaming, Flink or Kafka Streams would give
  seconds or less. MapReduce is used because the brief requires it.
* **Why not count in the driver directly?** Then the analytics engine would not be MapReduce.
  The driver only sorts the job's output.
* **Are the viral bursts real?** No. They are injected into the demo dataset on purpose (and
  labelled Simulated in the UI). The detection of them is real and runs on the live pipeline.
* **Is the sentiment real?** The aggregation is real (inside the MapReduce job). With the
  synthetic data the labels come from phrase templates; with Sentiment140/Airline they are the
  datasets' own labels. No sentiment model is trained or claimed.
* **How would you scale it?** More Kafka partitions and sink consumers, more reducers,
  per-minute pre-aggregation (count each minute once, sum five results: about 5x cheaper),
  HDFS compaction, then a streaming engine.
* **What if a job takes longer than a minute?** The driver waits for it, skips missed ticks,
  records the duration (Processing duration chart), and the API's staleness threshold grows
  with the last job time.

## Implemented vs future work

Implemented: everything in the README's Reliability features and dashboard sections, the
velocity/burst scores, sentiment aggregation, events, SQLite history, SSE, health/metrics
endpoints, one-command orchestration, Docker health checks and restart limits.

Not implemented (future work): per-minute pre-aggregation, dedupe, HDFS compaction,
containerised Python services, persistent HDFS/Kafka volumes, multi-consumer scaling tests.
