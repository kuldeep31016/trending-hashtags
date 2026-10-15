# Demo script

A rehearsed path through the live system. Timings are measured on an Apple Silicon Mac, where
each MapReduce job takes **45-120 s** because the Hadoop images run under emulation. **New
windows therefore arrive every 1-2 minutes, not every 60 s.** Plan around job completions.

## Before the audience arrives (T−15 min)

```bash
cd trending-hashtags
scripts/demo.sh up          # Docker cluster + sink + driver + producer + dashboard
scripts/demo.sh status      # expect: pipeline HEALTHY (data: live, source: hadoop)
```

Open http://localhost:5050 (dark theme, Overview). Also open the YARN UI
(http://localhost:8088) and HDFS UI (http://localhost:9870) in tabs.

About 5 minutes before you start, put the stream just before the first injected burst:

```bash
REPLAY_FROM=0.27 scripts/demo.sh replay
```

With the default pacing (one pass over 60,000 tweets in 40 minutes, 25 tweets/s), the bursts
from that point arrive at about:

| After replay | Stream position | What is injected |
|---|---|---|
| +1 min | 30% | `#worldcupfinal` starts (45% of tweets carry it, for ~5 min) |
| +14 min | 62% | `#breakingnews` starts (40%, ~5 min) |
| +22 min | 82% | `#newphonelaunch` starts (30%, ~4 min) |

Pipeline Health → **Demo replay progress** shows the producer's position against these bursts
live, which makes it easy to time the talk.

## The walkthrough

1. **The problem and the architecture (Overview, 1 min).** Point at the subtitle (5-minute
   window, MapReduce) and the **Pipeline flow** strip: Kafka → HDFS → Hadoop MapReduce →
   API, each card with real measurements (producer rate, consumer lag, writes per minute,
   ingest lag, last job duration, API latency).
   *Expected:* Pipeline status **Healthy**, top-bar indicator **Live**.

2. **The initial ranking (Overview table, 1 min).** Volume ranking: `#love`, `#music`,
   `#monday` lead (background Zipf-weighted tags). Click **By growth**: steady tags have low
   or negative scores. *Expected:* no tag marked Simulated in the top rows yet.

3. **A hashtag rising (2-6 min after replay).** Wait for the next window (the "Updated" time in
   the top bar changes; rows animate). `#worldcupfinal` appears as **NEW** with a
   **Simulated** label, jumps to #1 **By growth** (score in the hundreds), then to #1
   by volume. *Expected:* events **is surging** and **took the #1 spot** in *Recent trend
   events*; a ring marker on the **Trend activity** chart at the surge.
   Say clearly: *the burst is injected into the demo data; the detection is real.*

4. **The MapReduce job behind it (YARN UI or Pipeline Health, 2 min).** Show the running
   `trending-hashtags-<window>` application in YARN, then **Pipeline Health → Recent YARN
   applications** and **MapReduce job duration** (bars against the dashed 60 s line: jobs
   overrun the schedule, and the driver skips ticks instead of piling jobs up).
   In HDFS UI → *Utilities → Browse* `/tweets-data/tweets/<date>/<HHMM>`: one folder per minute.

5. **The window moving forward.** Top bar: the window times advance with each run.
   **Live Trends** shows the score components (`growth = (c−p)/(p+k)`,
   `score = growth × log2(1+c)`) and the live baseline window.

6. **The hashtag fading (≈7-12 min after replay).** As the burst minutes leave the 5-minute
   window, `#worldcupfinal`'s count drops, its growth turns negative, it **left the top 5**,
   and `#love` **took the #1 spot** again. **Historical Analytics** shows the full rise and fall.

7. **Health and honesty (1 min).** **Pipeline Health**: each stage is checked on its own
   (Kafka offsets and lag, DataNodes, YARN nodes, driver heartbeat, API latency).
   **Optional failure demo** (rehearsed; costs ~5 minutes):
   `docker stop namenode`. Within 10 s the HDFS stage shows **Down**. At the next driver tick
   the job is retried 3 times (backoff 10 s, then 20 s), the MapReduce stage turns **Degraded**
   with the real error, the overall status shows **Down**, and the leaderboard stays on screen
   with a **Stale data** banner. Nothing is overwritten. Then `docker start namenode`: in about
   3 minutes the sink writes its backlog (Kafka kept the tweets), the next window succeeds and
   everything returns to **Healthy**. The NameNode is not reformatted on restart.
   (Use the NameNode, not the NodeManager: without a NodeManager YARN keeps the job waiting
   for a node instead of failing it, so the failure would only surface at the driver's
   15-minute job timeout. That path was not rehearsed.)

8. **Sentiment (optional, 1 min).** **Sentiment Analysis** shows the per-window and per-hashtag
   split computed in the same MapReduce job. Point out the banner: the demo labels come from
   phrase templates (experimental), and real datasets supply genuine labels.

## Fallbacks

| Situation | Do this |
|---|---|
| Docker will not start / no time | `scripts/demo.sh stop` then `scripts/demo.sh local`: the same mapper/reducer on a simulated clock, all three bursts in ~3 min, clearly labelled *Local simulation* |
| A burst already passed | `REPLAY_FROM=0.27 scripts/demo.sh replay` (or `0.59` for `#breakingnews`, `0.79` for `#newphonelaunch`) |
| Dashboard frozen | top bar **Paused**? click Resume. Else `scripts/demo.sh status` and `scripts/demo.sh restart driver` |
| Need to show the original UI | http://localhost:5050/classic |

## After the demo

```bash
scripts/demo.sh stop        # Python services
scripts/demo.sh down        # and the Docker cluster (HDFS emptied; dashboard history kept)
```
