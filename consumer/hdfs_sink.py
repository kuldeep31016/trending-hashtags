#!/usr/bin/env python3
"""Kafka -> HDFS sink.

Reads tweets from Kafka, groups them by the minute of their event time, and writes one
small file per minute per flush into  <root>/tweets/YYYYMMDD/HHMM/.

Delivery guarantee: offsets are committed only AFTER the files are written, so a crash
replays the batch (at-least-once). Duplicates after a crash are possible; a production
system would dedupe on tweet id. A failed write is retried with the same buffer; offsets
stay uncommitted until it succeeds.

Every flush records real measurements in the SQLite store for the dashboard: tweets
written, minute folders touched, HDFS write time and ingest lag (flush time - event time).
"""
import argparse
import collections
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from analytics.store import DEFAULT_DB, Store  # noqa: E402
from common import add_storage_args, get_logger, kv, make_storage, minute_key  # noqa: E402
from kafka import KafkaConsumer  # noqa: E402

log = get_logger("sink")


def flush(storage, buf, seq):
    for key, recs in buf.items():
        data = ("\n".join(json.dumps(r) for r in recs) + "\n").encode("utf-8")
        storage.put(key, f"part-{int(time.time() * 1000)}-{seq}.jsonl", data)
    return sum(len(v) for v in buf.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bootstrap", default=os.environ.get("KAFKA_BOOTSTRAP", "localhost:9092"))
    ap.add_argument("--topic", default="tweets")
    ap.add_argument("--group", default="hdfs-sink")
    ap.add_argument("--flush-secs", type=float, default=10)
    ap.add_argument("--db", default=DEFAULT_DB)
    add_storage_args(ap)
    a = ap.parse_args()
    storage = make_storage(a)
    store = Store(a.db)

    consumer = KafkaConsumer(a.topic, bootstrap_servers=a.bootstrap, group_id=a.group,
                             auto_offset_reset="earliest", enable_auto_commit=False,
                             value_deserializer=lambda b: json.loads(b.decode("utf-8")))
    buf, last, seq, total = collections.defaultdict(list), time.time(), 0, 0
    log.info("sink running", extra=kv(kafka=a.bootstrap, topic=a.topic, backend=a.backend))
    store.heartbeat("sink", "running", backend=a.backend, topic=a.topic, total_written=0)
    while True:
        consumed = 0
        for _tp, msgs in consumer.poll(timeout_ms=1000, max_records=5000).items():
            for m in msgs:
                rec = m.value
                buf[minute_key(rec.get("ts", time.time()))].append(rec)
                consumed += 1
        if consumed:
            store.incr("sink.consumed", consumed)
        if buf and time.time() - last >= a.flush_secs:
            t0 = time.time()
            try:
                n = flush(storage, buf, seq)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
                err = getattr(e, "stderr", b"") or b""
                log.error("hdfs write failed, will retry", extra=kv(
                    error=type(e).__name__, detail=err.decode("utf-8", "replace")[-300:]))
                store.incr("sink.write_errors")
                store.heartbeat("sink", "error", backend=a.backend, topic=a.topic, total_written=total,
                                last_error={"at": time.time(), "message": f"{type(e).__name__}: {e}"})
                time.sleep(5)
                continue
            write_s = time.time() - t0
            consumer.commit()  # commit only after data is safely stored
            lags = [t0 - r["ts"] for recs in buf.values() for r in recs if isinstance(r.get("ts"), (int, float))]
            total, seq = total + n, seq + 1
            store.record_flush(n, len(buf), sum(lags) / len(lags) if lags else None,
                               max(lags) if lags else None, write_s)
            store.incr("sink.written", n)
            store.heartbeat("sink", "running", backend=a.backend, topic=a.topic, total_written=total,
                            last_flush=time.time())
            log.info("flushed", extra=kv(tweets=n, minutes=len(buf), total=total, write_s=round(write_s, 2)))
            buf.clear()
            last = time.time()
        elif not buf:
            last = time.time()
            store.heartbeat("sink", "running", backend=a.backend, topic=a.topic, total_written=total)


if __name__ == "__main__":
    main()
