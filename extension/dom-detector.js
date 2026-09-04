// VisionGuard - dom-detector.js
//
// This function gets INJECTED into the actual webpage (not the extension's
// own context) via chrome.scripting.executeScript. It scans the page's DOM
// for known-sensitive input fields and returns their exact screen position,
// so we can redact those exact regions on the screenshot later.
//
// This is the "free, reliable" detection layer we discussed - password
// fields and autocomplete hints tell us EXACTLY what's sensitive, no
// guessing from pixels required.

function detectSensitiveFields() {
  const results = [];

  // Autocomplete tokens that indicate personally identifiable info.
  // https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
  const SENSITIVE_AUTOCOMPLETE_TOKENS = [
    "email",
    "tel",
    "cc-number",
    "cc-csc",
    "cc-exp",
    "cc-name",
    "name",
    "given-name",
    "family-name",
    "street-address",
    "address-line1",
    "address-line2",
    "postal-code",
    "current-password",
    "new-password",
  ];

  function classifyField(el) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
    const name = (el.getAttribute("name") || "").toLowerCase();
    const id = (el.getAttribute("id") || "").toLowerCase();

    if (type === "password") return "password";
    if (autocomplete.includes("cc-")) return "payment";
    if (SENSITIVE_AUTOCOMPLETE_TOKENS.some((t) => autocomplete.includes(t))) {
      return "pii";
    }
    // Fallback: field name/id hints, for pages that skip autocomplete attrs
    if (/pass(word)?/.test(name) || /pass(word)?/.test(id)) return "password";
    if (/email/.test(name) || /email/.test(id)) return "pii";
    if (/phone|mobile|tel/.test(name) || /phone|mobile|tel/.test(id)) return "pii";
    if (/card.?number|cc.?num|cardnum/.test(name) || /card.?number|cc.?num|cardnum/.test(id)) return "payment";
    if (/expir|exp.?date|exp.?month|exp.?year|mm.?yy/.test(name) || /expir|exp.?date|exp.?month|exp.?year|mm.?yy/.test(id)) return "payment";
    if (/cvv|cvc|security.?code|card.?code/.test(name) || /cvv|cvc|security.?code|card.?code/.test(id)) return "payment";

    return null;
  }

  const candidates = document.querySelectorAll("input, textarea");

  candidates.forEach((el) => {
    const category = classifyField(el);
    if (!category) return;

    const rect = el.getBoundingClientRect();

    // Skip fields that aren't actually visible (hidden inputs, zero size,
    // off-screen) - nothing to redact if it's not rendered.
    if (rect.width === 0 || rect.height === 0) return;

    results.push({
      category,                     // "password" | "payment" | "pii"
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  });

  return {
    fields: results,
    devicePixelRatio: window.devicePixelRatio,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  };
}