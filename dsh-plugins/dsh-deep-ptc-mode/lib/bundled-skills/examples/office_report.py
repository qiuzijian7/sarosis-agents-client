"""python office_report.py sales.csv output_dir — one currency; CSV: id,team,amount"""
import argparse
import csv
from decimal import Decimal
from pathlib import Path
from collections import Counter
import xlsxwriter
from docx import Document

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("csv", type=Path)
parser.add_argument("out", type=Path)
args = parser.parse_args()
totals, seen, rows = Counter(), set(), []
with args.csv.open(encoding="utf-8-sig", newline="") as source:
    for i, row in enumerate(csv.DictReader(source), 2):
        key, team = row["id"].strip(), row["team"].strip()
        amount = Decimal(row["amount"])
        if not key or key in seen or not team or not amount.is_finite() or amount != amount.quantize(Decimal(".01")):
            raise ValueError(f"row {i}: check unique id, team and two-decimal amount")
        seen.add(key)
        rows.append((key, team, amount))
        totals[team] += amount
if not rows:
    raise ValueError("No data rows")
args.out.mkdir(parents=True, exist_ok=False)
with xlsxwriter.Workbook(args.out / "report.xlsx") as book:
    raw, summary = book.add_worksheet("Input"), book.add_worksheet("Summary")
    cash = book.add_format({"num_format": "#,##0.00;[Red]-#,##0.00"})
    raw.write_row(0, 0, ["ID", "Team", "Amount"])
    for i, (key, team, amount) in enumerate(rows, 1):
        raw.write_string(i, 0, key)
        raw.write_string(i, 1, team)
        raw.write_number(i, 2, float(amount), cash)
    raw.freeze_panes(1, 0)
    raw.autofilter(0, 0, len(rows), 2)
    summary.write_row(0, 0, ["Team", "Net amount"])
    for i, (team, amount) in enumerate(sorted(totals.items()), 1):
        summary.write_string(i, 0, team)
        # EXACT handles literal *, ?, and case-sensitive team names consistently with Python.
        formula = f"=SUMPRODUCT(--EXACT(Input!B$2:B${len(rows)+1},A{i+1}),Input!C$2:C${len(rows)+1})"
        summary.write_formula(i, 1, formula, cash, float(amount))
    end = len(totals) + 1
    total = sum(totals.values())
    summary.write_string(end, 0, "Total")
    summary.write_formula(end, 1, f"=SUM(B2:B{end})", cash, float(total))
    summary.set_column("A:B", 22)
doc = Document()
doc.add_heading("Sales reconciliation", 0)
doc.add_paragraph(f"Input: {args.csv.name} | Transactions: {len(rows)} | Net amount: {total:,.2f}")
table = doc.add_table(rows=1, cols=2)
table.style = "Table Grid"
table.rows[0].cells[0].text, table.rows[0].cells[1].text = "Team", "Net amount"
for team, amount in sorted(totals.items()):
    left, right = table.add_row().cells
    left.text, right.text = team, f"{amount:,.2f}"
doc.save(args.out / "report.docx")
