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

function queryAllDeep(selector, root) {
  root = root || document;
  const results = Array.from(root.querySelectorAll(selector));
  root.querySelectorAll("*").forEach((el) => {
    if (el.shadowRoot) {
      results.push(...queryAllDeep(selector, el.shadowRoot));
    }
  });
  return results;
}

function detectPageErrors() {
  const ERROR_KEYWORDS = [
    "incorrect", "invalid", "failed", "failure", "error",
    "wrong password", "wrong username", "please enter",
    "try again", "not found", "unauthorized", "denied",
    "required field", "this field is required",
    "are allowed", "is allowed", "not allowed", "must contain",
    "must be", "cannot contain", "already taken", "already exists",
    "already in use", "already registered",
  ];

  const ERROR_CLASS_HINTS = /error|alert|danger|warn|invalid|fail/i;

  const candidates = queryAllDeep("div, p, span, li, small, strong, b");

  for (const el of candidates) {
    if (el.children.length > 2) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const text = (el.textContent || "").trim();
    if (!text || text.length > 200) continue;

    const lowerText = text.toLowerCase();
    const hasKeyword = ERROR_KEYWORDS.some((kw) => lowerText.includes(kw));
    const hasErrorStyling = ERROR_CLASS_HINTS.test(el.className || "");

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
// Includes login-specific success phrasing ("welcome back" etc). Note:
// keyword coverage was NOT the root cause of the DeluGeRPG login case -
// that was a timing issue (a multi-hop redirect landing this check on
// an intermediate page before the real content rendered), fixed in
// popup.js via waitForTabLoadComplete(). This keyword list is still a
// real, worthwhile improvement on its own merits, just not sufficient
// by itself.
function detectPageSuccess() {
  const SUCCESS_KEYWORDS = [
    "response has been recorded", "your response has been recorded",
    "submission successful", "successfully submitted", "thank you for",
    "thanks for submitting", "your submission has been received",
    "registration successful", "account created", "welcome aboard",
    "successfully registered", "successfully signed up",
    "welcome back", "you are now logged in", "you're now logged in",
    "logged in successfully", "successfully logged in", "login successful",
  ];

  const candidates = queryAllDeep("div, p, span, li, h1, h2, h3");

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