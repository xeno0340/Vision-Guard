// VisionGuard - dom-detector.js
//
// This function gets INJECTED into the actual webpage via
// chrome.scripting.executeScript. It scans the page's DOM for known-
// sensitive input fields and returns their exact screen position, plus
// two classification labels:
//   - category: broad class (password/pii/payment/government_id),
//     used for reporting and future policy decisions
//   - fakeType: a specific label (email/phone/card_number/etc) used
//     ONLY to pick which realistic placeholder text to draw over the
//     field during type-preserving redaction (see popup.js redact step)
//
// v3: classifyField now returns {category, fakeType} instead of a bare
// string, so redaction can generate a plausible fake value matching
// the field's real type, rather than a blank blackout.

function detectSensitiveFields() {
  const results = [];

  const SENSITIVE_AUTOCOMPLETE_TOKENS = [
    "email", "tel", "cc-number", "cc-csc", "cc-exp", "cc-name",
    "name", "given-name", "family-name",
    "street-address", "address-line1", "address-line2", "postal-code",
    "current-password", "new-password",
  ];

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

  function getAssociatedLabelText(el) {
    // aria-labelledby resolves to OTHER elements' text by ID - Google's
    // own Material-Design-based components (Google Forms among them)
    // commonly label real <input> elements this way instead of using
    // <label for> or visible sibling text, which is why this needs to
    // be checked before anything else.
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((labelEl) => labelEl.textContent.trim())
        .join(" ")
        .trim();
      if (text) return text.toLowerCase();
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim().toLowerCase();

    if (el.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel) return forLabel.textContent.trim().toLowerCase();
    }
    const wrappingLabel = el.closest("label");
    if (wrappingLabel) return wrappingLabel.textContent.trim().toLowerCase();

    // Broader fallback: many real sites style a label visually (bold
    // text, a heading, a plain div) without any semantic <label> markup
    // or a matching class name at all - a strict class-name check misses
    // these entirely. Instead, walk up a few ancestor levels and, at
    // each level, look for the nearest PRECEDING sibling with short text
    // content (1-40 chars, effectively no nested children) - this is
    // what "looks like a label sitting above the field" actually means
    // structurally, regardless of what class or tag it uses.
    let node = el;
    for (let depth = 0; depth < 3 && node; depth++) {
      let sibling = node.previousElementSibling;
      while (sibling) {
        const text = sibling.textContent.trim();
        if (text.length > 0 && text.length <= 40 && sibling.children.length <= 1) {
          return text.toLowerCase();
        }
        sibling = sibling.previousElementSibling;
      }
      node = node.parentElement;
    }

    return "";
  }

  // Returns {category, fakeType} or null if not sensitive.
  function classifyField(el) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
    const name = (el.getAttribute("name") || "").toLowerCase();
    const id = (el.getAttribute("id") || "").toLowerCase();
    const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
    const labelText = getAssociatedLabelText(el);
    const combinedText = `${name} ${id} ${placeholder} ${labelText}`;

    if (type === "password") return { category: "password", fakeType: "password" };
    if (autocomplete.includes("cc-num")) return { category: "payment", fakeType: "card_number" };
    if (autocomplete.includes("cc-exp")) return { category: "payment", fakeType: "expiry" };
    if (autocomplete.includes("cc-csc")) return { category: "payment", fakeType: "cvv" };
    if (autocomplete.includes("cc-")) return { category: "payment", fakeType: "card_number" };
    if (autocomplete.includes("email")) return { category: "pii", fakeType: "email" };
    if (autocomplete.includes("tel")) return { category: "pii", fakeType: "phone" };
    if (SENSITIVE_AUTOCOMPLETE_TOKENS.some((t) => autocomplete.includes(t))) {
      return { category: "pii", fakeType: "name" };
    }

    if (/pass(word)?/.test(name) || /pass(word)?/.test(id) || /pass(word)?/.test(labelText)) {
      return { category: "password", fakeType: "password" };
    }
    if (/email/.test(combinedText)) return { category: "pii", fakeType: "email" };
    if (/phone|mobile|tel(ephone)?/.test(combinedText)) return { category: "pii", fakeType: "phone" };
    if (/card.?number|cc.?num|cardnum/.test(combinedText)) return { category: "payment", fakeType: "card_number" };
    if (/expir|exp.?date|exp.?month|exp.?year|mm.?yy/.test(combinedText)) return { category: "payment", fakeType: "expiry" };
    if (/cvv|cvc|security.?code|card.?code/.test(combinedText)) return { category: "payment", fakeType: "cvv" };
    if (/date.?of.?birth|\bdob\b|birth.?date/.test(combinedText)) return { category: "pii", fakeType: "dob" };
    if (/\baddress\b|\badress\b|street|city|state|postal|zip.?code/.test(combinedText)) return { category: "pii", fakeType: "address" };

    if (ID_DOCUMENT_PATTERNS.some((pattern) => pattern.test(combinedText))) {
      return { category: "government_id", fakeType: "government_id" };
    }

    return null;
  }

  function hasContent(el) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked;
    return (el.value || "").trim().length > 0;
  }

  const candidates = document.querySelectorAll("input, textarea");

  candidates.forEach((el) => {
    const classification = classifyField(el);
    if (!classification) return;
    if (!hasContent(el)) return;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    results.push({
      category: classification.category,
      fakeType: classification.fakeType,
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