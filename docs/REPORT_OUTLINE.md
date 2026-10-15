# Report / Viva Outline: Real-Time Trending Hashtag Detection

## Sections for the written report
1. **Abstract:** one paragraph: problem, approach (Kafka + HDFS + MapReduce), result.
2. **Introduction & motivation:** batch trend jobs detect topics after the peak.
3. **Objectives:** stream events; store on HDFS; sliding 5-minute count; top 10 every minute; live dashboard.
4. **Dataset description:** Sentiment140 (1.6M tweets, 2009), US Airline Sentiment (14.6k tweets, 2015); fields used; the hashtag-sparsity issue and the enrichment step.
5. **System architecture:** the diagram from the README, one paragraph per stage.
6. **Implementation:** ingestion, HDFS layout, MapReduce job (incl. sentiment keys), window logic, velocity/burst scoring and trend events, driver resilience, SQLite history, API + SSE, dashboard pages (screenshots), one-command orchestration.
7. **Results:** screenshots of the leaderboard at three moments (before burst, during, after); table of top-10 at minute 20 vs 26 from the demo; unit-test results.
8. **Evaluation:** correctness (MapReduce equals brute force; 44 unit tests), latency (job time per window from the Processing duration chart), throughput (writes/min and ingest lag from Pipeline Health), failure drill (NameNode stop → stale banner → automatic recovery).
9. **Limitations & future work:** see README.
10. **Conclusion.**

## Likely viva questions

See docs/VIVA.md for fuller answers, the trend-score reasoning and measured numbers.

* **Why MapReduce and not Spark Streaming?** The problem statement requires MapReduce; it is batch, so we approximate real time with a 1-minute micro-batch cadence.
* **What is the end-to-end latency?** About one minute (the window cadence) plus job start-up plus up to the sink flush interval (10 s).
* **How do you handle late or out-of-order tweets?** They are bucketed by event time, so they join the correct minute and appear in the next window recompute.
* **Why a combiner?** Pre-aggregates on the mapper side and reduces shuffle traffic; valid because addition is associative and commutative.
* **What delivery guarantee do you have?** At-least-once (commit after write); exactly-once would need idempotent writes or dedupe on tweet id.
* **Why partition Kafka?** Parallel producers and consumers; ordering is only guaranteed within a partition, which does not matter for counting.
* **How would you scale it?** More Kafka partitions + sink consumers, more reducers, per-minute pre-aggregation, then move to a streaming engine.
* **Why store per-minute folders?** Makes the window a folder selection and keeps jobs from scanning old data.
* **Is the "viral burst" real?** No. It is injected for the demo because the datasets have no real timeline; this is stated in the report.
