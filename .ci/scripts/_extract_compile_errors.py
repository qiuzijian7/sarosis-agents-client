import re
from collections import Counter, defaultdict

with open(r"E:\Downloads\VsSaros-Win-EXE-Package (2).log", encoding="utf-8", errors="replace") as f:
    lines = f.readlines()

clean = []
for i, l in enumerate(lines):
    clean.append((i+1, re.sub(r"\x1b\[[0-9;]*m", "", l)))

# Find the compile-build-with-mangling section: from "compile-src" start to "131 errors"
start = None
end = None
for i, (ln, l) in enumerate(clean):
    if 'compile-src' in l and 'Starting' in l:
        start = start or ln
    if 'Finished compilation with 131 errors' in l or 'Found 131 errors' in l or '131 errors' in l:
        end = end or ln
print(f"compile-src start={start}, errors-reported={end}")

# collect error lines in [start, end]
pat = re.compile(r"Error: (E:/data/landun/workspace/(?:src|extensions)/[^\n]+?)\((\d+),(\d+)\): (.*)")
errs = []
if start and end:
    for ln, l in clean:
        if ln < start:
            continue
        if end and ln > end:
            break
        for m in pat.finditer(l):
            errs.append((ln, m.group(1), int(m.group(2)), int(m.group(3)), m.group(4).strip()))

print("errors in range:", len(errs))
by_file = Counter(e[1] for e in errs)
print("\n=== by file ===")
for f, c in by_file.most_common():
    print(f"{c:4}  {f}")

# Check: which files are in src/tsconfig exclude?
import json
with open(r"g:\CustomWorkspaces\AIProjects\sarosis-agents-client\src\tsconfig.json", encoding="utf-8") as f:
    excl = json.load(f)["exclude"]
norm_excl = [e.lstrip("./").replace("/", "\\") for e in excl]
print("\n=== files in tsconfig exclude ===")
for f, c in by_file.most_common():
    rel = f.replace("E:/data/landun/workspace/", "").replace("/", "\\")
    in_excl = any(rel.startswith(e) or (e.endswith("*") and rel.startswith(e.rstrip("*"))) for e in norm_excl)
    print(f"{'EXCL' if in_excl else '    '} {c:4}  {f}")
