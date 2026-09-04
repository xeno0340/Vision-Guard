// VisionGuard - clickable-detector.js
//
// Set-of-Mark grounding: instead of asking the VLM to guess pixel
// coordinates for where to click (unreliable - this is the well-known
// weak point of general-purpose VLMs), we detect every real clickable
// element via the DOM, tag each one with a stable ID directly in the
// page, and let the model choose a NUMBER from a small labeled set.
//
// The model still does 100% of the visual reasoning (deciding WHICH
// numbered element to pick, by looking at the screenshot) - DOM is only
// used to make execution exact once a choice is made, the same
// supporting role it already plays in redaction.

function detectClickableElements() {
  const SELECTOR = [
    "button",
    "a[href]",
    "input[type=submit]",
    "input[type=button]",
    "input[type=checkbox]",
    "input[type=radio]",
    "[role=button]",
    "[onclick]",
    "select",
  ].join(", ");

  const results = [];
  const candidates = document.querySelectorAll(SELECTOR);
  let idCounter = 1;

  candidates.forEach((el) => {
    const rect = el.getBoundingClientRect();

    // Skip invisible/zero-size/off-screen elements - nothing to click.
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;

    // A short human-readable label for the model to reason over -
    // prefer visible text, fall back to common labeling attributes.
    const label = (
      el.textContent?.trim() ||
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("value") ||
      el.tagName.toLowerCase()
    ).slice(0, 60);

    const id = idCounter++;

    // Tag the actual DOM node so execution can find this EXACT element
    // later via a direct attribute match - no coordinate guessing at
    // click time, regardless of any scrolling/layout shift in between.
    el.setAttribute("data-visionguard-id", id);

    results.push({
      id,
      label,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  });

  return {
    elements: results,
    devicePixelRatio: window.devicePixelRatio,
  };
}