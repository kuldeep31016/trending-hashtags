#!/usr/bin/env python3
"""Build data/tweets.jsonl from Sentiment140 + Twitter US Airline Sentiment.

    python scripts/prepare_data.py \
        --sentiment140 data/training.1600000.processed.noemoticon.csv \
        --airline data/Tweets.csv --limit 20000

With no input files it generates synthetic tweets so the project runs out of the box.

Sentiment labels (field "sentiment": positive / neutral / negative):
  * Sentiment140 polarity 0 / 2 / 4  -> negative / neutral / positive  (dataset labels)
  * US Airline "airline_sentiment"   -> used as-is                     (dataset labels)
  * synthetic tweets                 -> fixed label per phrase template ("template" labels,
                                        clearly synthetic; the dashboard says so)
A metadata file (data/tweets.meta.json) records the sources, label provenance and the
injected bursts so the dashboard can label simulated events honestly.

Why the "enrich" step exists: Sentiment140 is a 2009 dataset with very few hashtags and
no meaningful timeline, so a trending leaderboard would be flat. By default we append
(a) a background pool of hashtags and (b) a few "viral bursts" (a hashtag that suddenly
dominates one slice of the stream). Pass --no-enrich to keep the original text untouched.
"""
import argparse
import csv
import datetime as dt
import json
import os
import random

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BASE_TAGS = ["love", "music", "monday", "friday", "news", "food", "travel", "fail", "happy",
             "tech", "football", "movies", "weather", "coffee", "work", "gaming", "fitness",
             "art", "photography", "followfriday", "tgif", "iphone", "nba", "election", "sad"]
# (hashtag, start fraction of stream, end fraction, probability a tweet in the slice carries it)
BURSTS = [("WorldCupFinal", 0.30, 0.42, 0.45),
          ("BreakingNews", 0.62, 0.74, 0.40),
          ("NewPhoneLaunch", 0.82, 0.92, 0.30)]
# (template, sentiment label assigned to the template; order kept so seeded output is stable)
PHRASES = [("can't believe it's already {d}", "neutral"), ("this coffee is so good", "positive"),
           ("stuck in traffic again", "negative"), ("what a match last night", "positive"),
           ("new phone arrived today", "neutral"), ("the delay at the airport was awful", "negative"),
           ("loving this weather", "positive"), ("finally finished the project", "positive"),
           ("great service from the crew", "positive"), ("can't stop listening to this song", "positive"),
           ("long day at work", "negative"), ("dinner with friends tonight", "neutral")]
S140_LABELS = {"0": "negative", "2": "neutral", "4": "positive"}
AIRLINE_LABELS = {"positive", "neutral", "negative"}
DAYS = ["monday", "tuesday", "friday", "weekend"]


def read_sentiment140(path):
    with open(path, encoding="latin-1", newline="") as f:
        for row in csv.reader(f):
            if len(row) >= 6:
                yield {"id": row[1], "user": row[4], "text": row[5], "source": "sentiment140",
                       "sentiment": S140_LABELS.get(row[0].strip())}


def read_airline(path):
    with open(path, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            label = (row.get("airline_sentiment") or "").strip().lower()
            yield {"id": row.get("tweet_id", ""), "user": row.get("name", ""),
                   "text": row.get("text", ""), "source": "airline",
                   "sentiment": label if label in AIRLINE_LABELS else None}


def reservoir(it, k, rng):
    """Uniform random sample of k items from a stream (keeps memory small for 1.6M rows)."""
    sample = []
    for i, x in enumerate(it):
        if i < k:
            sample.append(x)
        else:
            j = rng.randint(0, i)
            if j < k:
                sample[j] = x
    return sample


def synthetic(n, rng):
    rows = []
    for i in range(n):
        user = f"user{rng.randint(1, 5000)}"
        phrase, label = rng.choice(PHRASES)
        rows.append({"id": str(i), "user": user, "source": "synthetic", "sentiment": label,
                     "text": phrase.format(d=rng.choice(DAYS))})
    return rows


def enrich(rows, rng):
    weights = [1 / (i + 1) for i in range(len(BASE_TAGS))]  # Zipf-like: a few popular tags
    n = len(rows)
    for i, r in enumerate(rows):
        if rng.random() < 0.25:
            r["text"] += " #" + rng.choices(BASE_TAGS, weights)[0]
        for tag, a, b, p in BURSTS:
            if a * n <= i < b * n and rng.random() < p:
                r["text"] += " #" + tag


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sentiment140")
    ap.add_argument("--airline")
    ap.add_argument("--limit", type=int, default=20000)
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "tweets.jsonl"))
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--no-enrich", action="store_true")
    a = ap.parse_args()
    rng = random.Random(a.seed)

    rows = []
    if a.airline:
        rows += list(read_airline(a.airline))[: a.limit // 3]  # keep airline share modest
    if a.sentiment140:
        rows += reservoir(read_sentiment140(a.sentiment140), a.limit - len(rows), rng)
    if not rows:
        print("No dataset given -> generating synthetic tweets")
        rows = synthetic(a.limit, rng)
    rng.shuffle(rows)
    rows = rows[: a.limit]
    if not a.no_enrich:
        enrich(rows, rng)

    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")  # ASCII-safe JSON
    sources = sorted({r["source"] for r in rows})
    meta = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "file": os.path.basename(a.out),
        "tweets": len(rows),
        "sources": sources,
        "synthetic": sources == ["synthetic"],
        "seed": a.seed,
        "enriched": not a.no_enrich,
        "injected_bursts": [] if a.no_enrich else
            [{"tag": t.lower(), "start_fraction": s0, "end_fraction": s1, "probability": p}
             for t, s0, s1, p in BURSTS],
        "sentiment_labels": {
            "labeled": sum(1 for r in rows if r.get("sentiment")),
            "provenance": "template" if sources == ["synthetic"] else "dataset",
            "note": ("Synthetic tweets: each phrase template has a fixed label. Demonstrates the "
                     "aggregation pipeline; it is not a sentiment model.")
                    if sources == ["synthetic"] else
                    "Labels taken from the source datasets (Sentiment140 polarity, US Airline sentiment).",
        },
    }
    with open(os.path.splitext(a.out)[0] + ".meta.json", "w") as f:
        json.dump(meta, f, indent=2)
    print(f"Wrote {len(rows)} tweets -> {a.out}")


if __name__ == "__main__":
    main()
