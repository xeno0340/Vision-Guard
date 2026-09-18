"""
VisionGuard - test_raw_model.py

Standalone diagnostic script - talks DIRECTLY to Ollama's own API,
completely bypassing main.py, the redaction pipeline, the numbered
Set-of-Mark overlay, and the strict JSON-action-only prompt schema.

Purpose: isolate whether the model's failure to recognize "already
logged in" is (a) a genuine limit of the model's own visual/semantic
reasoning, (b) confusion caused by OUR redaction/number-overlay
rendering, or (c) suppression caused by OUR strict "always pick an
action" prompt framing. Each has a different fix, so it's worth
knowing which one is actually happening before building anything else.

Usage:
    python test_raw_model.py <path_to_screenshot.png>

Requires: requests (already in server/requirements.txt), Ollama running
locally with the target model already pulled.
"""

import sys
import base64
import requests
import json

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "qwen2.5vl:7b"  # change to qwen2.5vl:3b to compare against the smaller model too

# Deliberately plain, open-ended - no JSON schema, no forced action
# choice, no mention of "click" or "type" at all. Just the bare
# question this whole test exists to answer.
PLAIN_PROMPT = (
    "Look at this screenshot of a website. Has the user successfully "
    "logged into an account on this page, or are they still looking at "
    "a login form that hasn't been submitted yet? Answer clearly, then "
    "explain what specific visual evidence on the page led you to that "
    "conclusion."
)


def encode_image(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def ask_model(image_path, prompt, model=MODEL):
    image_b64 = encode_image(image_path)
    response = requests.post(
        OLLAMA_URL,
        json={
            "model": model,
            "prompt": prompt,
            "images": [image_b64],
            "stream": False,
        },
    )
    response.raise_for_status()
    return response.json()["response"]


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python test_raw_model.py <path_to_screenshot.png>")
        sys.exit(1)

    image_path = sys.argv[1]
    print(f"Model: {MODEL}")
    print(f"Image: {image_path}")
    print(f"Prompt: {PLAIN_PROMPT}\n")
    print("--- Model response ---")
    print(ask_model(image_path, PLAIN_PROMPT))