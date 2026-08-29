"""Poll the ComfyUI history for a submitted prompt and report the produced files."""

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

SERVER = "http://127.0.0.1:8188"
OUTPUT_DIR = Path(r"D:\ComfyUI\output")
PROMPT_ID = sys.argv[1]
TIMEOUT = int(sys.argv[2]) if len(sys.argv) > 2 else 900


def get_json(path: str) -> dict:
    with urllib.request.urlopen(f"{SERVER}{path}", timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    deadline = time.time() + TIMEOUT
    history: dict = {}
    while time.time() < deadline:
        history = get_json(f"/history/{urllib.parse.quote(PROMPT_ID)}")
        if PROMPT_ID in history:
            break
        time.sleep(5)
    else:
        print("TIMEOUT: still running")
        return

    entry = history[PROMPT_ID]
    status = entry.get("status", {})
    print("status_str:", status.get("status_str"), "completed:", status.get("completed"))
    for message in status.get("messages", []):
        if message[0] in {"execution_error", "validation_error"}:
            print("ERROR:", json.dumps(message[1], ensure_ascii=False)[:1500])

    for node_id, node_output in entry.get("outputs", {}).items():
        for image in node_output.get("images", []):
            path = OUTPUT_DIR / image["subfolder"] / image["filename"]
            size_kb = path.stat().st_size / 1024 if path.exists() else -1
            print(f"node {node_id} -> {path}  exists={path.exists()}  {size_kb:.0f} KB")


if __name__ == "__main__":
    main()
