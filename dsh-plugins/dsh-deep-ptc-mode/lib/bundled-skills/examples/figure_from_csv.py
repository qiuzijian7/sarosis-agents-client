"""python figure_from_csv.py measurements.csv output_dir "Latency (ms)" — CSV columns: group,value"""
import argparse
import csv
import json
import math
from pathlib import Path
from statistics import mean, stdev
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("csv", type=Path)
parser.add_argument("out", type=Path)
parser.add_argument("metric", help="Metric with unit, e.g. Latency (ms)")
args = parser.parse_args()
groups = {}
with args.csv.open(encoding="utf-8-sig", newline="") as source:
    for n, row in enumerate(csv.DictReader(source), 2):
        label, raw = row["group"].strip(), row["value"].strip()
        if not label:
            raise ValueError(f"row {n}: missing group")
        values = groups.setdefault(label, [])
        if raw:
            value = float(raw)
            if not math.isfinite(value):
                raise ValueError(f"row {n}: expected finite value or a blank")
            values.append(value)

if not groups or not any(groups.values()):
    raise ValueError("No measurements")
stats = [(name, len(v), mean(v) if v else None, stdev(v) if len(v) > 1 else None)
         for name, v in groups.items()]
args.out.mkdir(parents=True, exist_ok=False)
with (args.out / "summary.csv").open("w", encoding="utf-8-sig", newline="") as dest:
    writer = csv.writer(dest)
    writer.writerow(["group", "n", "mean", "sample_sd"])
    writer.writerows(stats)

fig, ax = plt.subplots(figsize=(7, max(3, len(stats) * .45)), layout="constrained")
for y, (name, n, avg, sd) in enumerate(stats):
    if n:
        ax.plot(groups[name], [y] * n, "|", color="0.65", alpha=.65)
        ax.errorbar(avg, y, xerr=sd, fmt="o", color="#085d77", capsize=4)
ax.set(yticks=range(len(stats)), yticklabels=[f"{s[0]} (n={s[1]})" for s in stats],
       xlabel=args.metric, title="Mean and sample SD; ticks show observations")
ax.invert_yaxis()
fig.savefig(args.out / "figure.svg")
plt.close(fig)

def display(x):
    return "—" if x is None else f"{x:.5g}"

columns = ["Group", "n", "Mean", "Sample SD"]
card = {"action": "show", "id": "measurement-summary", "title": args.metric,
        "blocks": [{"type": "table", "columns": columns,
                    "rows": [[label, str(n), display(avg), display(sd)] for label, n, avg, sd in stats[:8]]}],
        "footer": f"Showing {min(8,len(stats))}/{len(stats)} groups. Full data: summary.csv; plot: figure.svg."}
(args.out / "card.json").write_text(json.dumps(card, ensure_ascii=False, indent=2), encoding="utf-8")
