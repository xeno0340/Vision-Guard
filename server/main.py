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
    kind: str = "clickable"  # "clickable" or "fillable"
    fillableType: str | None = None  # "name" | "email" | "phone" | "address" | "password", only if kind == "fillable"
    hasContent: bool = False  # ground truth from the DOM - whether this field already has a value.
                               # Sent explicitly rather than asking the model to infer this visually,
                               # since that inference was unreliable in practice.


class RedactedContext(BaseModel):
    image_base64: str
    task_instruction: str
    redacted_regions_count: int = 0
    clickable_elements: list[ClickableElement] = []


class ActionResponse(BaseModel):
    action: str
    element_id: int | None = None
    value_type: str | None = None  # for "type" actions - which vault field to use, never an actual value
    note: str
    error_detected: bool = False
    error_message: str | None = None
    rejected: bool = False  # True when action=="none" because the model's response was invalid,
                             # NOT because the task is genuinely complete - these are different
                             # outcomes and must not be reported to the user identically.


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
    on it, next to each interactive element - both clickable elements
    (buttons, links) and fillable text fields (name/email/phone/address
    only - the vault's fixed, low-sensitivity field set).

    For fillable fields, the model chooses a VALUE TYPE (e.g. "email"),
    never an actual value - the real value is supplied locally by the
    client from its on-device vault, so no personal data ever needs to
    pass through this reasoning step at all.
    """
    element_lines = []
    for e in elements:
        if e.kind == "fillable":
            fill_status = "already filled - do NOT type into this again" if e.hasContent else "currently empty"
            if e.fillableType:
                element_lines.append(f'  {e.id}: "{e.label}" (fillable text field, type: {e.fillableType}, {fill_status})')
            else:
                # No confident type guess from pattern matching - the
                # model is asked to infer it from the actual label text
                # instead of the field being silently excluded, which is
                # what happened before this change (e.g. "Nickname" or a
                # split "First Name"/"Last Name" pair had no matching
                # keyword and simply never got offered at all).
                element_lines.append(
                    f'  {e.id}: "{e.label}" (fillable text field, type: UNKNOWN - infer from '
                    f'the label text which vault field this corresponds to, if any, {fill_status})'
                )
        else:
            element_lines.append(f'  {e.id}: "{e.label}" (clickable)')
    element_list = "\n".join(element_lines) or "  (no interactive elements detected)"

    return (
        "You are a browser automation agent. You are shown a screenshot "
        "of a webpage. Sensitive fields have been blacked out or replaced "
        "with placeholder values for privacy - ignore them, they are not "
        "relevant to your task.\n\n"
        "FIRST, check the page for any visible error message, warning, or "
        "failure notice. This matters because you have no memory of "
        "previous steps - if the same action was already attempted and "
        "the page is now showing an error, you cannot tell that from the "
        "image alone unless you actively look for error text now.\n\n"
        "SECOND, check whether the CURRENT page actually matches the "
        "task. For example, if the task asks to sign up / register / "
        "create an account, but the page shown is a LOGIN form (fields "
        "for an existing account, a 'Login' submit button, no signup-"
        "specific fields like a password confirmation or terms "
        "agreement), you are on the WRONG page. In that case, your action "
        "should be to CLICK a navigation link or button that leads to the "
        "correct page (e.g. 'Sign Up', 'Register now', 'Create account') "
        "- do NOT fill in any fields on a page that doesn't match the "
        "task, even if a field looks relevant by name. The same applies "
        "in reverse for a login task shown a signup page.\n\n"
        "Every interactive element has a small red numbered label drawn "
        "directly above it. Here is the list of numbered elements:\n"
        f"{element_list}\n\n"
        f"Task: {task_instruction}\n\n"
        "Decide the SINGLE next action toward completing this task. "
        "There are three possible actions:\n"
        '- "click": click a clickable element. Requires element_id.\n'
        '- "type": fill a fillable text field. Requires element_id AND '
        "value_type. If the element's type is shown as a specific value "
        "(name/email/phone/address/password), value_type MUST exactly "
        "match it. If the element's type is shown as UNKNOWN, read its "
        "label text and decide for yourself which of these five "
        "categories it corresponds to (name/email/phone/address/"
        "password) - for example a field labeled 'First Name' or "
        "'Nickname' or 'Full Name' should all map to value_type \"name\". "
        "If the label doesn't reasonably correspond to any of these "
        "five categories, do not choose this field at all. Do NOT "
        "invent a value - only specify which kind of value belongs "
        "there; the real value is supplied separately, not by you.\n"
        '- "none": task is complete, or no relevant action is available.\n\n'
        "Respond with ONLY a JSON object, no other text, in exactly this "
        "format:\n"
        '{"action": "click"|"type"|"none", "element_id": <number or null>, '
        '"value_type": "name"|"email"|"phone"|"address"|"password"|null, '
        '"reasoning": "one short sentence", "error_detected": false, '
        '"error_message": null}\n\n'
        'If you see an error/warning message on the page, set '
        '"error_detected": true and put the exact or paraphrased error '
        'text in "error_message", regardless of what action you choose.'
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
        action = parsed.get("action", "none")
        value_type = parsed.get("value_type")

        # Validate the model actually picked a real element ID - it can
        # hallucinate numbers not in the list, so check before trusting it.
        elements_by_id = {e.id: e for e in ctx.clickable_elements}
        valid_ids = set(elements_by_id.keys())
        if element_id is not None and element_id not in valid_ids:
            return ActionResponse(
                action="none",
                element_id=None,
                rejected=True,
                note=f"[Qwen2.5-VL local] Model picked element_id {element_id}, "
                     f"which is not in the valid list {sorted(valid_ids)}. Rejected "
                     f"rather than risk clicking the wrong thing.",
            )

        # For "type" actions, additionally validate that value_type
        # actually matches what this specific element was detected as -
        # the model should never be able to say "type an email into the
        # phone field", since that would produce a wrong-shaped value
        # even though it came from the correct vault entry.
        if action == "type" and element_id is not None:
            target = elements_by_id.get(element_id)
            if target is None or target.kind != "fillable":
                return ActionResponse(
                    action="none", element_id=None, rejected=True,
                    note=f"[Qwen2.5-VL local] Model tried to type into element_id "
                         f"{element_id}, which is not a fillable field. Rejected.",
                )
            KNOWN_VALUE_TYPES = {"name", "email", "phone", "address", "password"}

            if target.fillableType is not None:
                # We had a confident regex-based guess for this field -
                # enforce it strictly, same as before. This is the
                # reliable fast path, kept exactly as-is where it applies.
                if value_type != target.fillableType:
                    return ActionResponse(
                        action="none", element_id=None, rejected=True,
                        note=f"[Qwen2.5-VL local] Model specified value_type '{value_type}' "
                             f"for element_id {element_id}, but that field is actually "
                             f"type '{target.fillableType}'. Rejected rather than fill "
                             f"with a mismatched value type.",
                    )
            else:
                # We had NO confident guess (e.g. "Nickname", a split
                # first/last name field, or any label our fixed keyword
                # list doesn't cover) - trust the model's own semantic
                # reading of the label text instead of rejecting the
                # field outright. Still constrained to the five known
                # vault categories, so it can't invent an arbitrary type.
                if value_type not in KNOWN_VALUE_TYPES:
                    return ActionResponse(
                        action="none", element_id=None, rejected=True,
                        note=f"[Qwen2.5-VL local] Model specified value_type '{value_type}' "
                             f"for element_id {element_id}, which isn't one of the known "
                             f"vault categories {sorted(KNOWN_VALUE_TYPES)}. Rejected.",
                    )
            if target.hasContent:
                # Enforced here, not just requested in the prompt - the
                # model repeatedly ignored the prompt instruction to skip
                # already-filled fields in practice, so this is checked
                # against ground truth rather than trusted as followed.
                return ActionResponse(
                    action="none", element_id=None, rejected=True,
                    note=f"[Qwen2.5-VL local] Model tried to type into element_id "
                         f"{element_id}, which already has content. Rejected - "
                         f"this field does not need to be filled again.",
                )

        return ActionResponse(
            action=action,
            element_id=element_id,
            value_type=value_type,
            note=f"[Qwen2.5-VL local] {parsed.get('reasoning', 'no reasoning given')}",
            error_detected=bool(parsed.get("error_detected", False)),
            error_message=parsed.get("error_message"),
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