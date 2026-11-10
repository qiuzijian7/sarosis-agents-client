#!/usr/bin/env python3
"""Aggregate P0 context-budget observations after the 3-7 day collection window.

Runs on the anydev host (or against a copied app.log). Read-only: it never
modifies the database, the running service, or the log file.

Usage on anydev:
    python3 /data/newapi/context-budget-p0-aggregate.py

Local (copy app.log first):
    python3 context-budget-p0-aggregate.py --log /path/to/app.log

The script reports:
  * observation volume, capability hit rate, skip reasons
  * trigger rate for BOTH the catalog window and the effective window
  * the token / headroom distribution by model
  * a safety-ratio sweep, so the P1 margin can be chosen from real data
    instead of a guess (all raw values are in each log line)
"""

import argparse
import json
import sys
from collections import defaultdict

PREFIX = b"[context-budget] "


def percentile(sorted_values, p):
    if not sorted_values:
        return 0
    i = int(round((len(sorted_values) - 1) * p))
    return sorted_values[min(max(i, 0), len(sorted_values) - 1)]


def load(path):
    rows = []
    with open(path, "rb") as f:
        for line in f:
            pos = line.find(PREFIX)
            if pos < 0:
                continue
            try:
                rows.append(json.loads(line[pos + len(PREFIX):].decode()))
            except Exception:
                continue
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default="/data/newapi/app.log")
    ap.add_argument("--model", default="", help="filter by model name substring")
    args = ap.parse_args()

    rows = load(args.log)
    if args.model:
        rows = [r for r in rows if args.model in str(r.get("model", ""))]
    print("observations:", len(rows))
    if not rows:
        print("no data - is context_budget.enabled true?")
        return 0

    valid = [r for r in rows if not r.get("skip_reason") and r.get("tokens", 0) > 0]
    print("usable (no skip, tokens>0):", len(valid))

    hits = sum(1 for r in rows if r.get("capability_hit"))
    print("capability hit rate: %.2f%% (%d/%d)" %
          (100.0 * hits / len(rows), hits, len(rows)))

    skips = defaultdict(int)
    for r in rows:
        skips[r.get("skip_reason") or "ok"] += 1
    print("skip reasons:", dict(sorted(skips.items(), key=lambda x: -x[1])))

    srcs = defaultdict(int)
    for r in rows:
        srcs[r.get("window_source", "?")] += 1
    print("window sources:", dict(srcs))
    tsrc = defaultdict(int)
    for r in rows:
        tsrc[r.get("tokens_source", "?")] += 1
    print("token sources:", dict(tsrc))

    trig = sum(1 for r in valid if r.get("would_exceed"))
    ctrig = sum(1 for r in valid if r.get("catalog_would_exceed"))
    print("\n=== trigger rate (current policy) ===")
    print("effective window : %d/%d = %.2f%%" %
          (trig, len(valid), 100.0 * trig / len(valid) if valid else 0))
    print("catalog window   : %d/%d = %.2f%%" %
          (ctrig, len(valid), 100.0 * ctrig / len(valid) if valid else 0))

    tokens = sorted(r["tokens"] for r in valid)
    print("\n=== prompt tokens (billing estimate) ===")
    for p in (0.5, 0.9, 0.95, 0.99, 1.0):
        print("  p%-4s %d" % (int(p * 100), percentile(tokens, p)))

    print("\n=== by model ===")
    by_model = defaultdict(list)
    for r in valid:
        by_model[r.get("model", "?")].append(r)
    print("  %-28s %6s %8s %10s %10s" %
          ("model", "count", "trigger%", "p50 tok", "p95 tok"))
    for model, group in sorted(by_model.items(), key=lambda x: -len(x[1])):
        ts = sorted(g["tokens"] for g in group)
        tr = sum(1 for g in group if g.get("would_exceed"))
        print("  %-28s %6d %7.1f%% %10d %10d" %
              (model[:28], len(group), 100.0 * tr / len(group),
               percentile(ts, 0.5), percentile(ts, 0.95)))

    print("\n=== safety-ratio sweep (P1 calibration) ===")
    print("  Recomputed from raw log values; no need to recollect data.")
    print("  %-8s %12s %12s" % ("ratio", "trigger rate", "trim events"))
    for ratio in (0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30):
        count = 0
        for r in valid:
            window = r.get("effective_window", 0)
            if window <= 0:
                continue
            min_safety = r.get("min_safety_tokens", 0)
            safety = max(min_safety, int(window * ratio))
            budget = window - r.get("reserved_output", 0) - safety
            if budget > 0 and r["tokens"] > budget:
                count += 1
        print("  %-8.2f %11.2f%% %12d" %
              (ratio, 100.0 * count / len(valid) if valid else 0, count))

    print("\n=== interpretation ===")
    print("  * If 'catalog window' trigger rate is far below 'effective window',")
    print("    the model catalog overstates the real upstream limit; keep the")
    print("    window override for P1 or fix the catalog data.")
    print("  * Pick the smallest safety ratio whose trigger rate is acceptable")
    print("    for your traffic, then verify it against the p95/p99 token values.")
    print("  * would_exceed=true means P1 trimming WOULD have run; it did NOT run")
    print("    during P0 (no request content was ever modified).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
