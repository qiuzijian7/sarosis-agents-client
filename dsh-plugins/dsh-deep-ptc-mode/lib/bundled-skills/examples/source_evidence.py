"""python source_evidence.py URL "phrase to locate" — find a passage in static HTML."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.parse import urlsplit
from bs4 import BeautifulSoup

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("url")
parser.add_argument("phrase")
args = parser.parse_args()
if urlsplit(args.url).scheme not in {"http", "https"} or not args.phrase.strip():
    parser.error("Supply an HTTP(S) page and a nonempty phrase")
request = Request(args.url, headers={"User-Agent": "DeepPTC-Evidence/1.0", "Accept": "text/html"})
with urlopen(request, timeout=20) as response:
    if response.headers.get_content_type() != "text/html":
        raise ValueError("Expected an HTML page; use the PDF or dataset reader for other formats")
    data = response.read(4_000_001)
    if len(data) > 4_000_000:
        raise ValueError("Page exceeds 4 MB; select a narrower source")
    url = response.geturl()
    charset = response.headers.get_content_charset()
page = BeautifulSoup(data, "html.parser", from_encoding=charset)
root = page.find("main") or page.find("article") or page.body or page
for hidden in root.select("script,style,nav,footer,template"):
    hidden.decompose()
norm = lambda value: " ".join(value.split())
needle = norm(args.phrase).casefold()
heading, match = "", None
for node in root.select("h1,h2,h3,h4,p,li,td,blockquote"):
    passage = norm(node.get_text(" ", strip=True))
    if node.name in {"h1", "h2", "h3", "h4"}:
        heading = passage
    if needle in passage.casefold():
        match = {"section": heading, "passage": passage}
        break
result = {"url": url, "title": page.title.get_text(strip=True) if page.title else None,
          "retrieved_utc": datetime.now(timezone.utc).isoformat(), "sha256": hashlib.sha256(data).hexdigest(),
          "matched": match}
print(json.dumps(result, ensure_ascii=False, indent=2))
raise SystemExit(0 if match else 1)
