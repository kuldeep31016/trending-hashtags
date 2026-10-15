#!/usr/bin/env python3
"""Replay tweets from data/tweets.jsonl into a Kafka topic as a live stream.

The datasets have old timestamps, so each event is stamped with the *current* time
("ts") when it is emitted. That is what makes the sliding window behave like real time.

Pacing: --rate N sends N tweets/second. --duration M instead spreads one pass of the file
over M minutes, which is what makes the injected demo bursts last long enough to rise and
fade across several 5-minute windows (e.g. 60,000 tweets over 40 minutes = 25 tweets/s).
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from analytics.store import DEFAULT_DB, Store  # noqa: E402
from common import get_logger, kv  # noqa: E402
from kafka import KafkaProducer  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
log = get_logger("producer")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bootstrap", default=os.environ.get("KAFKA_BOOTSTRAP", "localhost:9092"))
    ap.add_argument("--topic", default="tweets")
    ap.add_argument("--file", default=os.path.join(ROOT, "data", "tweets.jsonl"))
    ap.add_argument("--rate", type=float, default=50, help="tweets per second")
    ap.add_argument("--duration", type=float, default=None,
                    help="minutes for one pass over the file (overrides --rate)")
    ap.add_argument("--loop", action="store_true", help="restart from the top when the file ends")
    ap.add_argument("--start-at", type=float, default=0.0,
                    help="fraction of the file to start the first pass at (0.25 = a quarter in)")
    ap.add_argument("--db", default=DEFAULT_DB)
    a = ap.parse_args()

    store = Store(a.db)
    producer = KafkaProducer(bootstrap_servers=a.bootstrap, linger_ms=50,
                             value_serializer=lambda v: json.dumps(v).encode("utf-8"))
    with open(a.file) as f:
        lines = f.read().splitlines()
    rate = len(lines) / (a.duration * 60) if a.duration else a.rate
    log.info("producer started", extra=kv(file=os.path.basename(a.file), tweets=len(lines),
                                          rate_per_s=round(rate, 2), loop=a.loop))

    sent, nxt, loop_no, started = 0, time.time(), 0, time.time()
    first = min(max(int(a.start_at * len(lines)), 0), len(lines) - 1)
    while True:
        loop_started = time.time()
        for pos, line in enumerate(lines[first:], start=first):
            rec = json.loads(line)
            rec["ts"] = time.time()
            rec["event_id"] = f"{loop_no}-{rec.get('id', pos)}"  # unique per replay pass
            producer.send(a.topic, rec)
            sent += 1
            nxt += 1.0 / rate
            delay = nxt - time.time()
            if delay > 0:
                time.sleep(delay)
            if sent % 1000 == 0:
                store.incr("producer.sent", 1000)
                store.heartbeat("producer", "running", sent=sent, rate_per_s=round(rate, 2), loop=loop_no,
                                position=pos + 1, file_tweets=len(lines), pass_started=loop_started,
                                started=started)
                log.info("sent", extra=kv(tweets=sent, loop=loop_no, position=pos + 1))
        loop_no, first = loop_no + 1, 0
        if not a.loop:
            break
    producer.flush()
    store.incr("producer.sent", sent % 1000)
    store.heartbeat("producer", "finished", sent=sent, rate_per_s=round(rate, 2), loop=loop_no,
                    position=len(lines), file_tweets=len(lines), started=started)
    log.info("done", extra=kv(tweets=sent))


if __name__ == "__main__":
    main()
