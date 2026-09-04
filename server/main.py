"""
VisionGuard - Server v3 (Set-of-Mark grounding via local Ollama VLM)

Instead of asking the VLM to guess pixel coordinates for where to click
(the known weak point of general-purpose VLMs, confirmed by our own
testing - see v2), the client detects every real clickable element via
the DOM, numbers them, and draws those numbers on the redacted image.
The model just picks a NUMBER from a labeled list - a task VLMs handle
far more reliably than pixel-precise spatial regression.
"""

import base64
import json
import os
import re
from datetime import datetime

import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="VisionGuard Server", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SAVE_DIR = os.path.join(os.path.dirname(__file__), "received_images")
os.makedirs(SAVE_DIR, exist_ok=True)

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "qwen2.5vl:3b"


class ClickableElement(BaseModel):
    id: int
    label: str


class RedactedContext(BaseModel):
    image_base64: str
    task_instruction: str
    redacted_regions_count: int = 0
    clickable_elements: list[ClickableElement] = []


class ActionResponse(BaseModel):
    action: str
    element_id: int | None = None
    note: str


@app.get("/health")
def health_check():
    ollama_status = "unknown"
    try:
        r = requests.get("http://localhost:11434/api/tags", timeout=2)
        ollama_status = "reachable" if r.ok else f"error ({r.status_code})"
    except requests.exceptions.RequestException:
        ollama_status = "unreachable - is `ollama serve` running?"

    return {
        "status": "ok",
        "time": datetime.utcnow().isoformat(),
        "ollama": ollama_status,
    }


def build_prompt(task_instruction: str, elements: list[ClickableElement]) -> str:
    """
    Set-of-Mark prompt: the image has numbered red labels drawn directly
    on it, next to each clickable element. We give the model the text
    labels too (redundant with the visual numbers, but text labels help
    the model disambiguate when several elements look visually similar).
    """
    element_list = "\n".join(f'  {e.id}: "{e.label}"' for e in elements) or "  (no clickable elements detected)"

    return (
        "You are a browser automation agent. You are shown a screenshot "
        "of a webpage. Sensitive fields have been blacked out for privacy "
        "- ignore the black boxes, they are intentional and not relevant "
        "to your task.\n\n"
        "Every clickable element on the page has a small red numbered "
        "label drawn directly above it in the image. Here is the list of "
        "numbered elements and their text labels:\n"
        f"{element_list}\n\n"
        f"Task: {task_instruction}\n\n"
        "Decide the SINGLE next action toward completing this task. "
        "Respond with ONLY a JSON object, no other text, in exactly this "
        "format:\n"
        '{"action": "click", "element_id": <number from the list above>, '
        '"reasoning": "one short sentence"}\n\n'
        'If the task appears already complete or no clickable element is '
        'relevant, use {"action": "none", "element_id": null, "reasoning": "..."}.'
    )


def parse_model_response(raw_text: str) -> dict:
    match = re.search(r"\{.*\}", raw_text, re.DOTALL)
    if not match:
        raise ValueError(f"No JSON object found in model output: {raw_text[:200]}")
    return json.loads(match.group(0))


@app.post("/agent/step", response_model=ActionResponse)
def agent_step(ctx: RedactedContext):
    image_bytes = base64.b64decode(ctx.image_base64)
    filename = f"{datetime.utcnow().strftime('%Y%m%d_%H%M%S_%f')}.png"
    filepath = os.path.join(SAVE_DIR, filename)
    with open(filepath, "wb") as f:
        f.write(image_bytes)

    print(f"[VisionGuard] received image -> {filename}")
    print(f"[VisionGuard] task: {ctx.task_instruction}")
    print(f"[VisionGuard] client reported {ctx.redacted_regions_count} redacted regions")
    print(f"[VisionGuard] {len(ctx.clickable_elements)} clickable elements available")

    prompt = build_prompt(ctx.task_instruction, ctx.clickable_elements)

    try:
        response = requests.post(
            OLLAMA_URL,
            json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "images": [ctx.image_base64],
                "stream": False,
                "options": {"temperature": 0.1},
            },
            timeout=60,
        )
        response.raise_for_status()
        raw_model_output = response.json()["response"]
        print(f"[VisionGuard] raw model output: {raw_model_output[:300]}")

        parsed = parse_model_response(raw_model_output)
        element_id = parsed.get("element_id")

        # Validate the model actually picked a real element ID - it can
        # hallucinate numbers not in the list, so check before trusting it.
        valid_ids = {e.id for e in ctx.clickable_elements}
        if element_id is not None and element_id not in valid_ids:
            return ActionResponse(
                action="none",
                element_id=None,
                note=f"[Qwen2.5-VL local] Model picked element_id {element_id}, "
                     f"which is not in the valid list {sorted(valid_ids)}. Rejected "
                     f"rather than risk clicking the wrong thing.",
            )

        return ActionResponse(
            action=parsed.get("action", "none"),
            element_id=element_id,
            note=f"[Qwen2.5-VL local] {parsed.get('reasoning', 'no reasoning given')}",
        )

    except requests.exceptions.ConnectionError:
        return ActionResponse(
            action="none",
            element_id=None,
            note="ERROR: could not reach Ollama at localhost:11434. "
                 "Is `ollama serve` running?",
        )
    except (ValueError, json.JSONDecodeError, KeyError) as e:
        return ActionResponse(
            action="none",
            element_id=None,
            note=f"ERROR: model response could not be parsed as valid JSON: {e}",
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)