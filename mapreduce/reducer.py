#!/usr/bin/env python3
"""Hadoop Streaming reducer (also used as the combiner).

Input : "<key>\t<count>" lines, sorted by key (Hadoop's shuffle/sort guarantees this)
Output: "<key>\t<sum of counts>"
"""
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

current, total = None, 0
for raw in sys.stdin.buffer:
    key, _, val = raw.decode("utf-8", "replace").rstrip("\n").partition("\t")
    try:
        n = int(val)
    except ValueError:
        continue
    if key == current:
        total += n
    else:
        if current is not None:
            print(f"{current}\t{total}")
        current, total = key, n
if current is not None:
    print(f"{current}\t{total}")
