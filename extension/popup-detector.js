// VisionGuard - popup-detector.js
//
// Deterministic detection (and dismissal) of interstitial popups,
// modals, and ad overlays that can block the task loop. The concrete
// failure this fixes: an ad served inside a cross-origin <iframe>,
// which the existing detectors could not see into at all - shadow DOM
// traversal (queryAllDeep in dom-detector.js/clickable-detector.js)
// crosses shadow-root boundaries, but a cross-origin iframe is a
// different, stricter boundary that ordinary page JavaScript can never
// cross regardless of traversal technique.
//
// Injected with { allFrames: true } from popup.js, so this function
// runs once per frame in the tab, INCLUDING cross-origin iframes -
// something a webpage's own script can never do, but a Manifest V3
// extension with the "scripting" permission can, for any frame inside
// a tab it currently has access to (via activeTab).
//
// Same design pattern as error-detector.js: a deterministic DOM scan,
// not something asked of the model - "is this a close button worth
// clicking" is exactly the kind of structural judgment call code
// handles more reliably than a VLM reading a small "X" glyph in a
// screenshot.

function detectAndTagPopupClose() {
  const isTopFrame = window.top === window;

  const CLOSE_LABEL_PATTERN = /^close$|^close ad$|^dismiss$|^no,?\s*thanks$|^skip( ad)?$|^\u00d7$|^\u2715$|^\u2716$|^x$/i;
  const CLOSE_HINT_PATTERN = /close|dismiss|modal.?close|popup.?close|ad.?close/i;

  function looksLikeCloseControl(el) {
    const ariaLabel = (el.getAttribute("aria-label") || "").trim();
    const title = (el.getAttribute("title") || "").trim();
    const text = (el.textContent || "").trim();
    const cls = (el.className || "").toString();
    const id = el.id || "";

    if (CLOSE_LABEL_PATTERN.test(ariaLabel) || CLOSE_LABEL_PATTERN.test(title) || CLOSE_LABEL_PATTERN.test(text)) {
      return true;
    }
    // A short, glyph-only text node ("X", "x", "\u00d7") combined with a
    // close/dismiss-hinting class or id is a strong signal even when
    // the accessible name isn't set - very common on ad creatives that
    // skip proper ARIA labeling entirely.
    if (text.length <= 2 && CLOSE_HINT_PATTERN.test(`${cls} ${id}`)) return true;
    if (CLOSE_HINT_PATTERN.test(`${cls} ${id}`) && text.length <= 20) return true;
    return false;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    return true;
  }

  // Looks for an ancestor that visually reads as an overlay/modal: a
  // fixed or absolutely positioned element with a meaningfully high
  // z-index, covering a non-trivial share of the viewport. This is
  // what distinguishes "a close icon that's actually blocking the
  // page" from "a close icon that's just normal page content" (e.g. a
  // dismissible inline notice) - only checked in the TOP frame, where
  // ordinary page chrome and genuine overlays both exist side by side.
  function hasOverlayAncestor(el) {
    let node = el;
    for (let depth = 0; depth < 6 && node && node !== document.body; depth++) {
      const style = window.getComputedStyle(node);
      if (style.position === "fixed" || style.position === "absolute") {
        const rect = node.getBoundingClientRect();
        const viewportArea = window.innerWidth * window.innerHeight;
        const elArea = rect.width * rect.height;
        const zIndex = parseInt(style.zIndex, 10) || 0;
        if (elArea > viewportArea * 0.15 && zIndex >= 10) return true;
      }
      const role = node.getAttribute && node.getAttribute("role");
      if (role === "dialog" || role === "alertdialog") return true;
      const cls = (node.className || "").toString();
      if (/\bmodal\b|\boverlay\b|\bpopup\b|\blightbox\b|\binterstitial\b|\bbackdrop\b/i.test(cls)) return true;
      node = node.parentElement;
    }
    return false;
  }

  const CANDIDATE_SELECTOR = 'button, a, [role="button"], span, div, i';
  const candidates = Array.from(document.querySelectorAll(CANDIDATE_SELECTOR));

  for (const el of candidates) {
    if (!isVisible(el)) continue;
    if (!looksLikeCloseControl(el)) continue;

    // Inside a cross-origin iframe, foreign content with a literal
    // close control is overwhelmingly likely to be exactly the kind of
    // ad/interstitial this is meant to catch - a real embedded widget
    // rarely renders a floating "X" over itself. The stricter
    // overlay-ancestor check is reserved for the top frame, where a
    // genuine blocking overlay needs to be told apart from ordinary
    // page content (e.g. a real nav/menu close icon).
    if (isTopFrame && !hasOverlayAncestor(el)) continue;

    el.setAttribute("data-visionguard-popup-close", "true");
    const rect = el.getBoundingClientRect();
    return {
      found: true,
      frameContext: isTopFrame ? "top" : "iframe",
      label: (el.textContent || el.getAttribute("aria-label") || "close control").trim().slice(0, 60),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
    };
  }

  return { found: false };
}

// Clicks the element tagged by detectAndTagPopupClose() above. Called
// as a SECOND injection, scoped to the exact frameId the tag was found
// in (target: { tabId, frameIds: [frameId] }) - a DOM element
// reference can't be passed between separate executeScript calls, so
// the tag left behind is how the second call re-locates the same
// element within its own frame.
function clickTaggedPopupClose() {
  const el = document.querySelector('[data-visionguard-popup-close="true"]');
  if (!el) return { success: false, reason: "Tagged close element not found (page may have changed)." };
  const rect = el.getBoundingClientRect();
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
  el.removeAttribute("data-visionguard-popup-close");
  return { success: true };
}