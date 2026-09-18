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

  // Shadow DOM traversal helpers - document.querySelectorAll cannot see
  // into an OPEN shadow root at all (it's a genuine encapsulation
  // boundary, not an oversight), so any element rendered inside one -
  // increasingly common with modern component frameworks - was
  // completely invisible to detection before this. These walk into
  // every open shadow root recursively. A CLOSED shadow root's
  // .shadowRoot property returns null by design and remains genuinely
  // inaccessible from outside - that specific case is a real, permanent
  // limitation, not something any traversal approach can work around.
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

  function queryOneDeep(selector, root) {
    root = root || document;
    const direct = root.querySelector(selector);
    if (direct) return direct;
    const hosts = root.querySelectorAll("*");
    for (const el of hosts) {
      if (el.shadowRoot) {
        const found = queryOneDeep(selector, el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  function getElementByIdDeep(id, root) {
    root = root || document;
    const direct = root.getElementById(id);
    if (direct) return direct;
    const hosts = root.querySelectorAll("*");
    for (const el of hosts) {
      if (el.shadowRoot) {
        const found = getElementByIdDeep(id, el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

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
        .map((id) => getElementByIdDeep(id))
        .filter(Boolean)
        .map((labelEl) => labelEl.textContent.trim())
        .join(" ")
        .trim();
      if (text) return text.toLowerCase();
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim().toLowerCase();

    if (el.id) {
      const forLabel = queryOneDeep(`label[for="${CSS.escape(el.id)}"]`);
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
    // Autocomplete is a space-separated list of exact tokens per the
    // HTML spec - split and check exact membership, not substring
    // inclusion. Substring matching previously caused "username" to
    // match the "name" token by accident (correct result, wrong
    // reason) - a real fragility, since the same bug could misfire on
    // an unrelated field like "surname_search" or "nickname_filter".
    const autocompleteTokens = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/).filter(Boolean);
    const name = (el.getAttribute("name") || "").toLowerCase();
    const id = (el.getAttribute("id") || "").toLowerCase();
    const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
    const labelText = getAssociatedLabelText(el);
    const combinedText = `${name} ${id} ${placeholder} ${labelText}`;

    // Checked BEFORE the type==="password" check, using name/id/label
    // regardless of the field's CURRENT type attribute - fixes a real
    // miscategorization where a password field whose type is toggled to
    // "text" by a show-password control (common UI pattern) was
    // classified under the generic PII fallback instead of "password",
    // since classification previously read only the live type attribute.
    if (/pass(word)?/.test(name) || /pass(word)?/.test(id) || /pass(word)?/.test(labelText)) {
      return { category: "password", fakeType: "password" };
    }
    if (type === "password") return { category: "password", fakeType: "password" };

    if (autocompleteTokens.includes("cc-number")) return { category: "payment", fakeType: "card_number" };
    if (autocompleteTokens.some((t) => t === "cc-exp" || t === "cc-exp-month" || t === "cc-exp-year")) {
      return { category: "payment", fakeType: "expiry" };
    }
    if (autocompleteTokens.includes("cc-csc")) return { category: "payment", fakeType: "cvv" };
    if (autocompleteTokens.some((t) => t.startsWith("cc-"))) return { category: "payment", fakeType: "card_number" };
    if (autocompleteTokens.includes("email")) return { category: "pii", fakeType: "email" };
    if (autocompleteTokens.includes("tel") || autocompleteTokens.includes("tel-national")) {
      return { category: "pii", fakeType: "phone" };
    }
    if (SENSITIVE_AUTOCOMPLETE_TOKENS.some((t) => autocompleteTokens.includes(t))) {
      return { category: "pii", fakeType: "name" };
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

  // Anti-bot honeypot fields: real, invisible-to-humans fields sites add
  // specifically to catch automated form-fillers - a field a genuine
  // user could never see or reach is a strong signal to skip, since
  // filling one both wastes effort and is exactly the "obviously a bot"
  // signature these fields exist to detect.
  function isLikelyHoneypot(el, rect) {
    const style = window.getComputedStyle(el);
    if (style.opacity === "0" || style.visibility === "hidden") return true;
    if (parseInt(style.fontSize, 10) === 0) return true;
    // Positioned far off-screen (common technique: left: -9999px) rather
    // than merely scrolled out of the current viewport.
    if (rect.left < -500 || rect.top < -500) return true;
    if (el.tabIndex === -1 && el.getAttribute("aria-hidden") === "true") return true;

    const name = (el.getAttribute("name") || "").toLowerCase();
    const id = (el.getAttribute("id") || "").toLowerCase();
    if (/honeypot|honey.?pot|\bhp_|bot.?field|bot.?trap|\btrap\b|do.?not.?fill|leave.?blank/.test(`${name} ${id}`)) {
      return true;
    }
    return false;
  }

  // Real bug found: a submit BUTTON ("Login", type="submit") was being
  // classified as a password field and redacted, completely covering
  // the real login button with a fake gray password box. Root cause:
  // getAssociatedLabelText()'s sibling-walk fallback has no distance
  // limit, and real <input> elements have empty textContent (inputs
  // aren't text nodes), so the walk skipped past the actual password
  // field and a Cloudflare widget and kept going until it reached the
  // "PASSWORD" label meant for a DIFFERENT field entirely - the button
  // inherited that label purely because nothing closer qualified.
  // Compounded by hasContent() treating a button's own value="Login"
  // (its label, not user-entered content) as "has content."
  //
  // The label-association fallback's lack of a distance limit is a
  // real, separate latent fragility worth revisiting - some other
  // non-button field could still inherit a distant, unrelated label
  // the same way. The fix below closes the specific failure that
  // actually happened: button-type inputs are never a place a user
  // enters sensitive data, regardless of what label text they end up
  // associated with, so they're excluded from candidacy entirely,
  // before classification ever runs.
  const NON_DATA_ENTRY_TYPES = ["submit", "button", "reset", "image"];

  const candidates = queryAllDeep("input, textarea");

  candidates.forEach((el) => {
    const elType = (el.getAttribute("type") || "").toLowerCase();
    if (NON_DATA_ENTRY_TYPES.includes(elType)) return;

    const classification = classifyField(el);
    if (!classification) return;
    if (!hasContent(el)) return;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (isLikelyHoneypot(el, rect)) return;

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