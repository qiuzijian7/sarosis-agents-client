import re
from collections import defaultdict

with open(r"E:\Downloads\VsSaros-Win-EXE-Package (2).log", encoding="utf-8", errors="replace") as f:
    text = f.read()
clean = re.sub(r"\x1b\[[0-9;]*m", "", text)

# capture error lines with file:line:col and message
pat = re.compile(r"Error: (E:/data/landun/workspace/(src/[^\n]+?\.(?:ts|js)))\((\d+),(\d+)\): (.*)")
errs = pat.findall(clean)

by_file = defaultdict(list)
for full, file, line, col, msg in errs:
    by_file[file].append((int(line), int(col), msg.strip()))

print("total error lines:", len(errs), "files:", len(by_file))
for file in sorted(by_file, key=lambda f: -len(by_file[f])):
    entries = by_file[file]
    print(f"\n=== {file} ({len(entries)}) ===")
    # show unique messages (ignore line numbers) to see the pattern
    seen = set()
    shown = 0
    for ln, col, msg in entries:
        key = re.sub(r"\(\d+,\d+\)", "(L,C)", msg)[:120]
        if key not in seen:
            seen.add(key)
            print(f"  L{ln}:{col} {msg[:150]}")
            shown += 1
        if shown >= 12:
            break
