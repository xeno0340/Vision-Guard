// VisionGuard - error-detector.js
//
// Detects visible error/failure messages on the page DIRECTLY via DOM
// text content, rather than relying on the VLM to visually read and
// self-report them. This is deliberately NOT model-dependent - reading
// small error text reliably, in addition to picking a correct action
// AND correctly filling extra JSON fields, is a harder multi-part task
// than the 3B local model handles consistently. A deterministic DOM
// scan catches this every time, the same way DOM already handles
// sensitive-field and clickable-element detection elsewhere in this
// system - one consistent design pattern, not a new one.

function detectPageErrors() {
  const ERROR_KEYWORDS = [
    "incorrect", "invalid", "failed", "failure", "error",
    "wrong password", "wrong username", "please enter",
    "try again", "not found", "unauthorized", "denied",
    "required field", "this field is required",
    // Positive-framing validation messages ("only X is allowed" rather
    // than "X is invalid") were missing entirely - real gap found when
    // a nickname-format rule ("Only alphanumeric characters ... are
    // allowed") went completely undetected because it never used any
    // of the negative-framing words above.
    "are allowed", "is allowed", "not allowed", "must contain",
    "must be", "cannot contain", "already taken", "already exists",
    "already in use", "already registered",
  ];

  const ERROR_CLASS_HINTS = /error|alert|danger|warn|invalid|fail/i;

  const candidates = document.querySelectorAll(
    "div, p, span, li, small, strong, b"
  );

  for (const el of candidates) {
    // Only look at leaf-ish, visible, currently-rendered text nodes -
    // skip elements that just contain other elements (avoids matching
    // giant wrapper divs and returning unhelpfully long text blobs).
    if (el.children.length > 2) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const text = (el.textContent || "").trim();
    if (!text || text.length > 200) continue;

    const lowerText = text.toLowerCase();
    const hasKeyword = ERROR_KEYWORDS.some((kw) => lowerText.includes(kw));
    const hasErrorStyling = ERROR_CLASS_HINTS.test(el.className || "");

    // Require EITHER a strong keyword match OR (keyword + error-like
    // styling) to avoid false positives on unrelated text that happens
    // to contain a common word like "required" in a non-error context.
    if (hasKeyword) {
      return {
        found: true,
        message: text,
        hasErrorStyling,
      };
    }
  }

  return { found: false, message: null, hasErrorStyling: false };
}

// Mirrors detectPageErrors() above, for the opposite case: recognizing
// that a task has genuinely SUCCEEDED, not just that no error occurred.
// Without this, the model has no concept of what "done" looks like for
// a given task - it sees a confirmation page with a still-clickable
// "Submit another response" link and, having no signal that success
// already happened, just clicks the next obvious thing (real observed
// behavior: it did exactly this after a Google Form was submitted
// successfully). Checked deterministically, same reasoning as errors -
// reliably reading a short confirmation phrase from the page is more
// dependable via DOM text search than via the model's own visual
// reading, especially combined with everything else it has to get
// right in one response.
function detectPageSuccess() {
  const SUCCESS_KEYWORDS = [
    "response has been recorded", "your response has been recorded",
    "submission successful", "successfully submitted", "thank you for",
    "thanks for submitting", "your submission has been received",
    "registration successful", "account created", "welcome aboard",
    "successfully registered", "successfully signed up",
  ];

  const candidates = document.querySelectorAll("div, p, span, li, h1, h2, h3");

  for (const el of candidates) {
    if (el.children.length > 2) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const text = (el.textContent || "").trim();
    if (!text || text.length > 200) continue;

    const lowerText = text.toLowerCase();
    const hasKeyword = SUCCESS_KEYWORDS.some((kw) => lowerText.includes(kw));

    if (hasKeyword) {
      return { found: true, message: text };
    }
  }

  return { found: false, message: null };
}