// VisionGuard - dom-detector.js
//
// This function gets INJECTED into the actual webpage (not the extension's
// own context) via chrome.scripting.executeScript. It scans the page's DOM
// for known-sensitive input fields and returns their exact screen position,
// so we can redact those exact regions on the screenshot later.
//
// v2: expanded to cover government/national ID categories (no autocomplete
// standard exists for these, so detection relies on name/id AND associated
// <label> text - label text catches far more real-world cases than name/id
// alone, since many sites use generic input names like "field1" but always
// render a human-readable label). Also skips fields with no value entered -
// nothing to redact if there's nothing there.

function detectSensitiveFields() {
  const results = [];

  const SENSITIVE_AUTOCOMPLETE_TOKENS = [
    "email", "tel", "cc-number", "cc-csc", "cc-exp", "cc-name",
    "name", "given-name", "family-name",
    "street-address", "address-line1", "address-line2", "postal-code",
    "current-password", "new-password",
  ];

  // No autocomplete standard exists for these - detection relies entirely
  // on name/id/label heuristics. Patterns are intentionally broad to catch
  // common naming conventions across regions (US SSN, Indian Aadhaar/PAN,
  // generic passport/national ID).
  const ID_DOCUMENT_PATTERNS = [
    /ssn|social.?security/,
    /passport/,
    /aadhaar|aadhar|uidai/,
    /\bpan\b|pan.?card|pan.?number/,
    /national.?id|govt.?id|government.?id/,
    /driver.?s?.?licen[sc]e|dl.?number/,
    /voter.?id/,
    /tax.?id|tin\b|ein\b/,
  ];

  // Reads the text of a field's associated <label> - either via a
  // for="id" attribute pointing at this element, or by walking up to
  // find a wrapping <label>. Falls back to "" if neither exists.
  function getAssociatedLabelText(el) {
    if (el.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel) return forLabel.textContent.trim().toLowerCase();
    }
    const wrappingLabel = el.closest("label");
    if (wrappingLabel) return wrappingLabel.textContent.trim().toLowerCase();

    // Some sites put a label-like element just before the input without
    // formal <label> markup - check the immediately preceding sibling text.
    const prev = el.previousElementSibling;
    if (prev && /label|title|field.?name/.test(prev.className || "")) {
      return prev.textContent.trim().toLowerCase();
    }
    return "";
  }

  function classifyField(el) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
    const name = (el.getAttribute("name") || "").toLowerCase();
    const id = (el.getAttribute("id") || "").toLowerCase();
    const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
    const labelText = getAssociatedLabelText(el);

    // Combine every text signal we have for the ID-document check - this
    // is deliberately the widest net, since these fields have no standard
    // markup to rely on.
    const combinedText = `${name} ${id} ${placeholder} ${labelText}`;

    if (type === "password") return "password";
    if (autocomplete.includes("cc-")) return "payment";
    if (SENSITIVE_AUTOCOMPLETE_TOKENS.some((t) => autocomplete.includes(t))) return "pii";

    // Fallback checks now search name, id, AND label text together - a
    // field like demoqa's id="userNumber" with visible label "Mobile
    // Number" would be missed checking name/id alone, since sites very
    // commonly use generic internal field names but always show a real
    // label to the user.
    if (/pass(word)?/.test(name) || /pass(word)?/.test(id) || /pass(word)?/.test(labelText)) return "password";
    if (/email/.test(combinedText)) return "pii";
    if (/phone|mobile|tel(ephone)?/.test(combinedText)) return "pii";
    if (/card.?number|cc.?num|cardnum/.test(combinedText)) return "payment";
    if (/expir|exp.?date|exp.?month|exp.?year|mm.?yy/.test(combinedText)) return "payment";
    if (/cvv|cvc|security.?code|card.?code/.test(combinedText)) return "payment";
    if (/date.?of.?birth|\bdob\b|birth.?date/.test(combinedText)) return "pii";
    if (/\baddress\b|street|city|state|postal|zip.?code/.test(combinedText)) return "pii";

    if (ID_DOCUMENT_PATTERNS.some((pattern) => pattern.test(combinedText))) return "government_id";

    return null;
  }

  // A field has "content" if it has a non-empty value (text/number inputs,
  // textareas) or is checked (checkboxes/radios representing a choice).
  // Nothing to redact in an empty field - redacting it anyway is wasted
  // computation and adds visual clutter with no privacy benefit.
  function hasContent(el) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked;
    return (el.value || "").trim().length > 0;
  }

  const candidates = document.querySelectorAll("input, textarea");

  candidates.forEach((el) => {
    const category = classifyField(el);
    if (!category) return;
    if (!hasContent(el)) return;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    results.push({
      category,  // "password" | "payment" | "pii" | "government_id"
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