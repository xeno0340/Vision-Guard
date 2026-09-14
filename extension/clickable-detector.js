// VisionGuard - clickable-detector.js
//
// Set-of-Mark grounding: detects every real interactive element via
// the DOM, tags each with a stable ID, and draws numbered labels so
// the model picks a number instead of guessing coordinates.
//
// v2: now also detects FILLABLE text fields (not just clickable
// buttons/links), tagged with a guessed fieldType (name/email/phone/
// address ONLY - the same low-sensitivity boundary used by the vault).
// This lets the model choose a "type" action on a numbered field, with
// the actual value supplied locally from the vault, never by the model
// itself - the model only ever says WHICH field and WHAT KIND of value
// goes there, never a real value.

function detectClickableElements() {

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

  // Clear tags from any PREVIOUS detection pass first. Without this, an
  // element tagged in an earlier step (on a page that hasn't reloaded -
  // e.g. inline form validation, not a navigation) keeps its old tag,
  // and gets silently skipped in every later pass as "already tagged" -
  // even though that tag is stale. This was the actual cause of
  // Nickname/Password fields vanishing from detection entirely after
  // the first step on a real signup form. Every detection pass must
  // start from a genuinely clean slate, not accumulate state from
  // previous ones - same principle as always re-perceiving before
  // acting, applied to tagging instead of just screenshots.
  queryAllDeep("[data-visionguard-id]").forEach((el) => {
    el.removeAttribute("data-visionguard-id");
  });

  const CLICKABLE_SELECTOR = [
    "button", "a[href]", "input[type=submit]", "input[type=button]",
    "input[type=checkbox]", "input[type=radio]", "[role=button]",
    "[onclick]", "select",
  ].join(", ");

  const FILLABLE_SELECTOR = [
    "input[type=text]", "input[type=email]", "input[type=tel]",
    "input[type=password]", "input:not([type])", "textarea",
    // Many modern form frameworks (Google Forms among them) don't use
    // real <input>/<textarea> elements at all - they render a styled
    // div and make it editable via contenteditable or ARIA role, which
    // the selector above completely misses. These need different value
    // read/write handling too (see getElementValue/setElementValue).
    '[contenteditable="true"]', '[role="textbox"]',
  ].join(", ");

  // contenteditable/role=textbox elements don't have a real .value
  // property - text content is the closest equivalent. Native inputs
  // still use .value as before.
  function getElementValue(el) {
    if ("value" in el) return el.value || "";
    return (el.textContent || el.innerText || "");
  }

  // Resolves a field's real label text using every signal available -
  // this is used for BOTH regex classification (fast, confident, no
  // model call needed) AND as the text shown to the model when our
  // regex doesn't recognize the label at all. Previously, a field with
  // no regex match was simply discarded - meaning "Full Name" worked
  // but "Nickname" or a first/last-name split field silently vanished,
  // unless we happened to add that exact phrase to the regex. Now the
  // model sees the REAL label text for every fillable field, even ones
  // our regex doesn't recognize, and can semantically match it to a
  // vault field itself - the kind of judgment call a model is actually
  // suited for, that a fixed keyword list can never fully cover.
  function resolveLabelText(el) {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((elId) => getElementByIdDeep(elId))
        .filter(Boolean)
        .map((labelEl) => labelEl.textContent.trim())
        .join(" ")
        .trim();
      if (text) return text;
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    if (el.id) {
      const forLabel = queryOneDeep(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel) return forLabel.textContent.trim();
    }
    const wrapping = el.closest("label");
    if (wrapping) return wrapping.textContent.trim();

    let node = el;
    for (let depth = 0; depth < 3 && node; depth++) {
      let sibling = node.previousElementSibling;
      while (sibling) {
        const text = (sibling.textContent || "").trim();
        if (text && text.length <= 40 && sibling.children.length <= 1) {
          return text;
        }
        sibling = sibling.previousElementSibling;
      }
      node = node.parentElement;
    }

    return el.getAttribute("placeholder") || "";
  }

  // Fast, confident regex classification - used as a shortcut when it
  // matches (no model call needed for these, same as before), but NO
  // LONGER the only path to being offered as fillable. Returns null for
  // anything it doesn't confidently recognize, which is now fine - the
  // model gets a chance to reason about those instead of them vanishing.
  function classifyFillableType(el, labelText) {
    const name = (el.getAttribute("name") || "").toLowerCase();
    const id = (el.getAttribute("id") || "").toLowerCase();
    const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
    const combined = `${name} ${id} ${placeholder} ${autocomplete} ${labelText.toLowerCase()}`;

    if (/email/.test(combined)) return "email";
    if (/phone|mobile|tel(ephone)?/.test(combined)) return "phone";
    if (/\baddress\b|\badress\b|street|city/.test(combined)) return "address";
    // Checked BEFORE the generic "name" pattern below - "username"
    // contains the substring "name", so without this ordering a
    // username field would incorrectly get the vault's full NAME value
    // instead of an actual username. Real gap: previously "username"
    // was lumped into the same "name" bucket entirely.
    if (autocomplete === "username" || /user.?name|\blogin.?id\b|\buid\b/.test(combined)) return "username";
    if (/^name$|full.?name|your.?name|nick.?name|display.?name/.test(combined)) return "name";
    // Split first/last-name fields get their own distinct types rather
    // than being folded into "name" - the vault stores one combined
    // name, so filling a "First Name" box needs just the first token,
    // not the whole string. Checked with word-boundary patterns so
    // "first" alone doesn't over-match unrelated fields.
    if (/first.?name|given.?name|\bfname\b/.test(combined)) return "first_name";
    if (/last.?name|sur.?name|family.?name|\blname\b/.test(combined)) return "last_name";
    return null;
  }

  // Anti-bot honeypot fields - see the matching function/comment in
  // dom-detector.js. Applied here too since this file is what actually
  // drives fill EXECUTION - the more important place to never touch one.
  function isLikelyHoneypot(el, rect) {
    const style = window.getComputedStyle(el);
    if (style.opacity === "0" || style.visibility === "hidden") return true;
    if (parseInt(style.fontSize, 10) === 0) return true;
    if (rect.left < -500 || rect.top < -500) return true;
    if (el.tabIndex === -1 && el.getAttribute("aria-hidden") === "true") return true;

    const name = (el.getAttribute("name") || "").toLowerCase();
    const id = (el.getAttribute("id") || "").toLowerCase();
    if (/honeypot|honey.?pot|\bhp_|bot.?field|bot.?trap|\btrap\b|do.?not.?fill|leave.?blank/.test(`${name} ${id}`)) {
      return true;
    }
    return false;
  }

  const results = [];
  let idCounter = 1;

  queryAllDeep(CLICKABLE_SELECTOR).forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    if (isLikelyHoneypot(el, rect)) return;

    const label = (
      el.textContent?.trim() || el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") || el.getAttribute("value") ||
      el.tagName.toLowerCase()
    ).slice(0, 60);

    const id = idCounter++;
    el.setAttribute("data-visionguard-id", id);

    results.push({
      id, label, kind: "clickable",
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    });
  });

  queryAllDeep(FILLABLE_SELECTOR).forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    if (isLikelyHoneypot(el, rect)) return;
    if (el.hasAttribute("data-visionguard-id")) return; // already tagged as clickable

    // Password fields: checked via name/id/label FIRST, regardless of
    // the CURRENT type attribute - fixes a real miscategorization where
    // a password field whose type is toggled to "text" by a show-
    // password control was classified as a generic name/pii field
    // instead, since the old check only read the live type attribute.
    const resolvedLabel = resolveLabelText(el);
    const looksLikePassword =
      el.type === "password" ||
      /pass(word)?/i.test(el.getAttribute("name") || "") ||
      /pass(word)?/i.test(el.getAttribute("id") || "") ||
      /pass(word)?/i.test(resolvedLabel);
    const fillableType = looksLikePassword ? "password" : classifyFillableType(el, resolvedLabel);

    // Skip only if we have neither a confident classification NOR any
    // usable label text at all - a field with no label and no
    // recognized type genuinely gives the model nothing to reason
    // about, so there's no point offering it.
    if (!fillableType && !resolvedLabel) return;

    const label = (resolvedLabel || fillableType || "unlabeled field").slice(0, 60);

    const id = idCounter++;
    el.setAttribute("data-visionguard-id", id);

    const hasContent = getElementValue(el).trim().length > 0;

    results.push({
      id, label, kind: "fillable", fillableType, hasContent,
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    });
  });

  return {
    elements: results,
    devicePixelRatio: window.devicePixelRatio,
  };
}