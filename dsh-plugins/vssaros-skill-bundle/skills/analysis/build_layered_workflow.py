"""Build and submit a LayeredDiffusion RGBA workflow to the local ComfyUI server.

Verifies the full pipeline end to end: SDXL checkpoint -> LayeredDiffusionApply
-> KSampler -> LayeredDiffusionDecodeRGBA -> SaveImage (PNG keeps alpha).
"""

import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SERVER = "http://127.0.0.1:8188"
CHECKPOINT = "sd_xl_base_1.0.safetensors"
CONFIG = "SDXL, Attention Injection"
PROMPT = "a glass perfume bottle, product photo, soft studio lighting, white background"
NEGATIVE = "blurry, low quality, watermark, text"
OUTPUT_DIR = Path(r"D:\ComfyUI\output")


def build_prompt_graph(seed: int) -> dict:
    """Return the node graph for one transparent RGBA generation run."""
    return {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": CHECKPOINT},
        },
        "2": {
            "class_type": "LayeredDiffusionApply",
            "inputs": {
                "model": ["1", 0],
                "config": CONFIG,
                "weight": 1.0,
            },
        },
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": PROMPT, "clip": ["1", 1]},
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": NEGATIVE, "clip": ["1", 1]},
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": 768, "height": 768, "batch_size": 1},
        },
        "6": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["2", 0],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "latent_image": ["5", 0],
                "seed": seed,
                "steps": 12,
                "cfg": 7.0,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1.0,
            },
        },
        "7": {
            "class_type": "LayeredDiffusionDecodeRGBA",
            "inputs": {
                "samples": ["6", 0],
                "images": ["9", 0],
                "sd_version": "SDXL",
                "sub_batch_size": 16,
            },
        },
        "9": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["6", 0], "vae": ["1", 2]},
        },
        "8": {
            "class_type": "SaveImage",
            "inputs": {"images": ["7", 0], "filename_prefix": "layered_rgba"},
        },
    }


def post_json(path: str, payload: dict, timeout: int = 120) -> dict:
    """POST a JSON body to the ComfyUI server and parse the JSON reply."""
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{SERVER}{path}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def get_json(path: str, timeout: int = 120) -> dict:
    with urllib.request.urlopen(f"{SERVER}{path}", timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_for_completion(prompt_id: str, timeout: int = 900) -> dict:
    """Poll the history endpoint until the prompt finishes or the timeout expires."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        history = get_json(f"/history/{urllib.parse.quote(prompt_id)}")
        if prompt_id in history:
            return history[prompt_id]
        time.sleep(3)
    raise TimeoutError(f"prompt {prompt_id} did not finish within {timeout}s")


def main() -> None:
    seed = random.randint(1, 2**32 - 1)
    print(f"seed={seed} config={CONFIG} checkpoint={CHECKPOINT}")

    result = post_json("/prompt", {"prompt": build_prompt_graph(seed), "client_id": "layered-verify"})
    prompt_id = result["prompt_id"]
    print("submitted prompt_id:", prompt_id)

    history = wait_for_completion(prompt_id)
    status = history.get("status", {})
    print("status:", status.get("status_str"), "completed:", status.get("completed"))
    if status.get("status_str") == "error":
        for message in status.get("messages", []):
            print("ERROR:", message)
        return

    outputs = history.get("outputs", {})
    for node_id, node_output in outputs.items():
        for image in node_output.get("images", []):
            saved_path = OUTPUT_DIR / image["subfolder"] / image["filename"]
            print(f"node {node_id} -> {saved_path}")
            print(f"   exists={saved_path.exists()} size={saved_path.stat().st_size/1024:.0f} KB")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        print("HTTPError:", error.code, error.read().decode("utf-8", errors="replace")[:1200])
