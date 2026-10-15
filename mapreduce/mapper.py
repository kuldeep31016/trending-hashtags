#!/usr/bin/env python3
"""Hadoop Streaming mapper.

Input : one JSON tweet per line  {"text": "...", "sentiment": "positive", ...}
Output: "<hashtag>\t1" for every distinct hashtag in the tweet,
        plus "__TOTAL__\t1" once per tweet (used for the dashboard's tweet counter).
        When the tweet carries a valid sentiment label (positive / neutral / negative):
        "__SENT__|<label>\t1" once per tweet and "__TS__|<hashtag>|<label>\t1" per hashtag.
        Missing or unknown labels emit no sentiment keys (they count as unlabeled).
Runs on the YARN node's Python (3.8), so keep the syntax 3.7-compatible.
"""
import html
import json
import re
import sys

TAG = re.compile(r"(?<!\w)#(\w+)")
LABELS = {"positive", "neutral", "negative"}

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

for raw in sys.stdin.buffer:
    line = raw.decode("utf-8", "replace").strip()
    if not line:
        continue
    try:
        rec = json.loads(line)
        text = rec.get("text", "")
    except (ValueError, AttributeError):
        continue  # skip malformed records instead of failing the whole job
    if not isinstance(text, str):
        continue
    print("__TOTAL__\t1")
    label = rec.get("sentiment")
    label = label.lower() if isinstance(label, str) and label.lower() in LABELS else None
    if label:
        print(f"__SENT__|{label}\t1")
    # unescape &amp; / &#39; etc. (Sentiment140 contains HTML entities)
    tags = {t.lower() for t in TAG.findall(html.unescape(text))}
    for t in tags:  # set => a tweet counts a repeated hashtag only once
        if t.isdigit() or not 2 <= len(t) <= 50:
            continue
        print(f"{t}\t1")
        if label:
            print(f"__TS__|{t}|{label}\t1")
