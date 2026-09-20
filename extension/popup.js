// VisionGuard - popup.js
//
// v5: refactored the individual step handlers (capture/detect/redact/
// send/execute) into reusable async functions, and added an automatic
// multi-step task loop on top of them.
//
// v6: added checkAndDismissPopup() - a deterministic popup/overlay
// dismissal step run every iteration, before the nav-mismatch check,
// error/success detection, or auto-fill. It uses allFrames: true to
// reach cross-origin iframes (where ads commonly live), which every
// other detector in this file deliberately does NOT do, since doing so
// for the sensitive-field/clickable-element detectors would require
// solving cross-frame coordinate translation for the Set-of-Mark
// overlay - a separate, bigger piece of work. See popup-detector.js
// for the detection/dismissal logic itself.
//
// v7: the repeat-action safeguard's key now includes the element's
// label and the tab's current URL, not just its numeric id. Element
// ids are reassigned fresh (starting at 1) on EVERY detection pass, so
// "element #11" on one step and "element #11" on a later step are
// almost never the same physical element - real false-stop found where
// a successful login (id 11 = the real login button) was immediately
// followed by a fresh page where a completely different element
// happened to also land on id 11, and the safeguard wrongly treated it
// as a repeat and stopped a task that had actually already succeeded.
//
// v8: replaced the fixed POST_ACTION_WAIT_MS delay after CLICK actions
// with waitForTabSettled(), which waits for tab activity to go quiet
// for a settle window rather than guessing a fixed duration or
// resolving on the first "complete" signal. Real gap found: DeluGeRPG's
// login flow chains through an intermediate /login/validate hop before
// finally landing on the account home page - a page that itself
// reaches "complete" almost immediately, so a wait that resolved on
// the first such signal landed the loop on that transitional page,
// moments before the browser navigated away from it again. Fill
// actions keep the simpler fixed wait, since they don't trigger
// navigation.
//
// Why the loop matters: a single capture->decide->act cycle assumes the
// page state at decision time still matches the page state at execution
// time. That assumption breaks the moment an action causes ANY page
// change (navigation, a modal opening, content updating) - stale
// coordinates OR stale element tags both fail identically once the DOM
// has moved on. The fix is architectural, not detection-specific:
// ALWAYS re-capture and re-detect immediately before every action, never
// reuse perception from a previous step.

const captureBtn = document.getElementById("captureBtn");
const statusEl = document.getElementById("status");
const previewContainer = document.getElementById("preview-container");
const previewImg = document.getElementById("preview");
const detectBtn = document.getElementById("detectBtn");
const fieldsContainer = document.getElementById("fields-container");
const redactBtn = document.getElementById("redactBtn");
const redactedContainer = document.getElementById("redacted-container");
const redactedCanvas = document.getElementById("redactedCanvas");
const viewFullSizeBtn = document.getElementById("viewFullSizeBtn");

// Extension popups are physically tiny (~380px wide) and can't be
// zoomed/panned the way a normal browser tab can - the redacted
// preview canvas is drawn at real screenshot resolution but always
// LOOKS blurry when squeezed into that small a space, purely from CSS
// downscaling, not because the underlying image is actually low-res.
// Opening the same image at full size in a real tab fixes this.
viewFullSizeBtn.addEventListener("click", () => {
  if (redactedCanvas.width === 0) {
    alert("Nothing to view yet - run Redact and preview first.");
    return;
  }
  const dataUrl = redactedCanvas.toDataURL("image/png");
  chrome.tabs.create({ url: dataUrl });
});
const executeBtn = document.getElementById("executeBtn");
const taskInput = document.getElementById("taskInput");
const sendBtn = document.getElementById("sendBtn");
const serverResponseEl = document.getElementById("serverResponse");
const runTaskBtn = document.getElementById("runTaskBtn");
const resumeBanner = document.getElementById("resumeBanner");
const resumeBannerText = document.getElementById("resumeBannerText");
const resumeTaskBtn = document.getElementById("resumeTaskBtn");

// Checks whether the CURRENT task text has a stored stop reason from a
// previous run, and shows/hides the small "Resume this task" banner
// accordingly. Only ever an exact (light-normalized) match - never a
// fuzzy guess - so the banner is never shown for a task the person
// didn't actually mean.
async function refreshResumeBanner() {
  const reason = await getTaskStopReason(taskInput.value);
  if (reason) {
    resumeBannerText.textContent = `Last attempt at this task stopped ${formatRelativeTime(reason.timestamp)}: ${reason.reason}`;
    resumeBanner.style.display = "block";
  } else {
    resumeBanner.style.display = "none";
  }
}
taskInput.addEventListener("input", refreshResumeBanner);
refreshResumeBanner();

// --- Vault UI ---
// vault.js (loaded via <script> tag in popup.html, same context as this
// file - not injected into the page) provides getVault/saveVault.
const vaultNameInput = document.getElementById("vaultName");
const vaultUsernameInput = document.getElementById("vaultUsername");
const vaultEmailInput = document.getElementById("vaultEmail");
const vaultPhoneInput = document.getElementById("vaultPhone");
const vaultAddressInput = document.getElementById("vaultAddress");
const vaultPasswordInput = document.getElementById("vaultPassword");
const saveVaultBtn = document.getElementById("saveVaultBtn");
const vaultStatusEl = document.getElementById("vaultStatus");

async function loadVaultIntoUI() {
  const vault = await getVault();
  vaultNameInput.value = vault.name || "";
  vaultUsernameInput.value = vault.username || "";
  vaultEmailInput.value = vault.email || "";
  vaultPhoneInput.value = vault.phone || "";
  vaultAddressInput.value = vault.address || "";
  vaultPasswordInput.value = vault.password || "";
}
loadVaultIntoUI();

saveVaultBtn.addEventListener("click", async () => {
  const saved = await saveVault({
    name: vaultNameInput.value.trim(),
    username: vaultUsernameInput.value.trim(),
    email: vaultEmailInput.value.trim(),
    phone: vaultPhoneInput.value.trim(),
    address: vaultAddressInput.value.trim(),
    password: vaultPasswordInput.value, // not trimmed - passwords can legitimately have leading/trailing spaces
  });
  const filledCount = Object.keys(saved).length;
  vaultStatusEl.textContent = `Saved ${filledCount} field(s) locally. Never transmitted anywhere.`;
});

const SERVER_URL = "http://localhost:8000/agent/step";
const MAX_LOOP_STEPS = 6;
const POST_ACTION_WAIT_MS = 1500; // fixed settle time after a FILL action (no navigation expected)
const NAV_WAIT_TIMEOUT_MS = 8000; // hard ceiling for a CLICK-triggered navigation CHAIN to finish
const NAV_SETTLE_BUFFER_MS = 600; // window of no tab activity required before considering it settled
const MIN_POST_CLICK_WAIT_MS = 2000; // floor BEFORE settle-checking even starts, for actions with an invisible pre-navigation delay (e.g. a server round-trip validating a login POST before any redirect begins)
const NETWORK_RETRY_WAIT_MS = 3000; // longer-than-usual wait before the single automatic retry on a "network_or_loading_issue" error

// Shared state - kept for the manual step buttons, which are still
// useful for debugging one stage at a time. The automatic loop below
// uses the reusable functions directly instead of relying on this state
// persisting across page changes.
let lastCaptureDataUrl = null;
let lastDetectedFields = null;
let lastDevicePixelRatio = 1;
let lastActualDevicePixelRatio = 1;
let lastActionResponse = null;
let lastClickableElements = null;

// Computes a valid Luhn check digit for a partial card number, so
// generated card numbers pass the same checksum real ones do (still
// entirely fake - random digits, not a real account).
function luhnCheckDigit(partialDigits) {
  let sum = 0;
  let alternate = true;
  for (let i = partialDigits.length - 1; i >= 0; i--) {
    let digit = parseInt(partialDigits[i], 10);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return (10 - (sum % 10)) % 10;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Generates a fresh, randomized-but-realistic placeholder each call,
// rather than the same fixed value every time. A previous version used
// one static value per category - functionally fine for preserving
// semantic role, but a further refinement worth having: varied output
// is less fingerprintable and better demonstrates that these are
// generated placeholders, not a single hardcoded stand-in.
function generateFakeValue(fakeType) {
  const FIRST_NAMES = ["Jordan", "Taylor", "Morgan", "Casey", "Riley", "Alex", "Sam", "Jamie"];
  const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Davis", "Miller", "Wilson"];
  const STREET_NAMES = ["Main Street", "Oak Avenue", "Maple Drive", "Cedar Lane", "Park Road", "Elm Street"];
  const EMAIL_DOMAINS = ["example.com", "example.org", "example.net"];

  switch (fakeType) {
    case "password":
      return "•".repeat(randomInt(8, 14));

    case "name": {
      const first = FIRST_NAMES[randomInt(0, FIRST_NAMES.length - 1)];
      const last = LAST_NAMES[randomInt(0, LAST_NAMES.length - 1)];
      return `${first} ${last}`;
    }

    case "first_name":
      return FIRST_NAMES[randomInt(0, FIRST_NAMES.length - 1)];

    case "last_name":
      return LAST_NAMES[randomInt(0, LAST_NAMES.length - 1)];

    case "email": {
      const first = FIRST_NAMES[randomInt(0, FIRST_NAMES.length - 1)].toLowerCase();
      const num = randomInt(10, 999);
      const domain = EMAIL_DOMAINS[randomInt(0, EMAIL_DOMAINS.length - 1)];
      return `${first}${num}@${domain}`;
    }

    case "phone": {
      // 555 exchange is reserved for fictional use in North American
      // numbering - guarantees the generated number is never dialable,
      // regardless of which area code and last four digits are randomized.
      const areaCode = randomInt(200, 999);
      const lastFour = String(randomInt(0, 9999)).padStart(4, "0");
      return `(${areaCode}) 555-${lastFour}`;
    }

    case "dob": {
      const month = String(randomInt(1, 12)).padStart(2, "0");
      const day = String(randomInt(1, 28)).padStart(2, "0");
      const year = randomInt(1960, 2004); // plausible adult age range
      return `${month}/${day}/${year}`;
    }

    case "address": {
      const num = randomInt(100, 9999);
      const street = STREET_NAMES[randomInt(0, STREET_NAMES.length - 1)];
      return `${num} ${street}`;
    }

    case "card_number": {
      // Random 15-digit prefix + computed Luhn check digit - structurally
      // valid (passes the same checksum real cards use) without being
      // any real account number, and different every time rather than
      // always the same well-known test number.
      let digits = "4"; // Visa-style leading digit, matches common test-card conventions
      for (let i = 0; i < 14; i++) digits += randomInt(0, 9);
      const checkDigit = luhnCheckDigit(digits);
      const fullNumber = digits + checkDigit;
      return fullNumber.match(/.{1,4}/g).join(" ");
    }

    case "expiry": {
      const month = String(randomInt(1, 12)).padStart(2, "0");
      const year = randomInt(26, 31); // a few years out from a 2026 baseline
      return `${month}/${year}`;
    }

    case "cvv":
      return String(randomInt(0, 999)).padStart(3, "0");

    case "government_id":
      return `XXX-XX-${String(randomInt(0, 9999)).padStart(4, "0")}`;

    default:
      return "[redacted]";
  }
}

function detectFacesInDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      try {
        resolve(await detectFaces(img));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function executeClickByElementId(elementId) {
  function findDeep(selector, root) {
    root = root || document;
    const direct = root.querySelector(selector);
    if (direct) return direct;
    const hosts = root.querySelectorAll("*");
    for (const h of hosts) {
      if (h.shadowRoot) {
        const found = findDeep(selector, h.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  const el = findDeep(`[data-visionguard-id="${elementId}"]`);
  if (!el) {
    return { success: false, reason: `No element found with id ${elementId} (page may have changed since detection)` };
  }
  const rect = el.getBoundingClientRect();
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
  return {
    success: true,
    clickedElement: el.tagName + (el.id ? `#${el.id}` : "") + (el.textContent ? ` ("${el.textContent.trim().slice(0, 40)}")` : ""),
  };
}

function executeFillByElementId(elementId, value) {
  function findDeep(selector, root) {
    root = root || document;
    const direct = root.querySelector(selector);
    if (direct) return direct;
    const hosts = root.querySelectorAll("*");
    for (const h of hosts) {
      if (h.shadowRoot) {
        const found = findDeep(selector, h.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  const el = findDeep(`[data-visionguard-id="${elementId}"]`);
  if (!el) {
    return { success: false, reason: `No element found with id ${elementId} (page may have changed since detection)` };
  }

  const isNativeInput = el.tagName === "INPUT" || el.tagName === "TEXTAREA";

  if (isNativeInput) {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value").set;
    nativeSetter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  }

  return { success: true, filledElement: el.tagName + (el.id ? `#${el.id}` : ""), value };
}

// ============================================================
// Reusable step functions - each does ONE thing and returns its
// result. Both the manual buttons and the automatic loop call these,
// so there is exactly one implementation of each step, not two.
// ============================================================

async function doCapture() {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
  lastCaptureDataUrl = dataUrl;
  previewImg.src = dataUrl;
  previewContainer.classList.add("visible");
  return dataUrl;
}

async function doDetect(tabId) {
  if (tabId === undefined) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab.id;
  }

  await chrome.scripting.executeScript({ target: { tabId }, files: ["dom-detector.js"] });
  const [domResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => detectSensitiveFields(),
  });
  const { fields, devicePixelRatio } = domResult.result;
  lastActualDevicePixelRatio = devicePixelRatio;

  const domFieldsScaled = fields.map((f) => ({
    category: f.category,
    fakeType: f.fakeType,
    x: Math.round(f.x * devicePixelRatio),
    y: Math.round(f.y * devicePixelRatio),
    width: Math.round(f.width * devicePixelRatio),
    height: Math.round(f.height * devicePixelRatio),
  }));

  let allFields = domFieldsScaled;
  if (lastCaptureDataUrl) {
    const faces = await detectFacesInDataUrl(lastCaptureDataUrl);
    allFields = allFields.concat(faces);
  }

  lastDetectedFields = allFields;
  lastDevicePixelRatio = 1;

  await chrome.scripting.executeScript({ target: { tabId }, files: ["clickable-detector.js"] });
  const [clickableResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => detectClickableElements(),
  });
  lastClickableElements = clickableResult.result.elements;

  return { fields: allFields, clickableElements: lastClickableElements };
}

function doRedact() {
  return new Promise((resolve, reject) => {
    if (!lastCaptureDataUrl || !lastDetectedFields) {
      reject(new Error("Capture and detect must run before redact."));
      return;
    }

    const img = new Image();
    img.onload = () => {
      redactedCanvas.width = img.width;
      redactedCanvas.height = img.height;
      const ctx = redactedCanvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      lastDetectedFields.forEach((field) => {
        const x = field.x * lastDevicePixelRatio;
        const y = field.y * lastDevicePixelRatio;
        const w = field.width * lastDevicePixelRatio;
        const h = field.height * lastDevicePixelRatio;

        if (field.category === "face" || !field.fakeType) {
          ctx.fillStyle = "#000000";
          ctx.fillRect(x, y, w, h);
          return;
        }

        ctx.fillStyle = "#F0F0F0";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "#CCCCCC";
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, w, h);

        const fakeValue = generateFakeValue(field.fakeType);
        const fontSize = Math.max(10, Math.min(h * 0.5, 16)) * lastDevicePixelRatio;
        ctx.font = `${fontSize}px sans-serif`;
        ctx.fillStyle = "#333333";
        ctx.textBaseline = "middle";
        ctx.fillText(fakeValue, x + 6 * lastDevicePixelRatio, y + h / 2, w - 12 * lastDevicePixelRatio);
      });

      if (lastClickableElements) {
        lastClickableElements.forEach((el) => {
          const x = el.x * lastActualDevicePixelRatio;
          const y = el.y * lastActualDevicePixelRatio;
          const label = String(el.id);
          ctx.font = "bold 16px sans-serif";
          const textWidth = ctx.measureText(label).width;
          const boxW = textWidth + 10;
          const boxH = 20;
          ctx.fillStyle = "#FF3B30";
          ctx.fillRect(x, y - boxH, boxW, boxH);
          ctx.fillStyle = "#FFFFFF";
          ctx.fillText(label, x + 5, y - 5);
        });
      }

      redactedContainer.style.display = "block";
      resolve();
    };
    img.onerror = reject;
    img.src = lastCaptureDataUrl;
  });
}

function getRedactedImageBase64() {
  return redactedCanvas.toDataURL("image/png").split(",")[1];
}

async function doSend(taskInstruction) {
  const imageBase64 = getRedactedImageBase64();
  const redactedRegionsCount = lastDetectedFields ? lastDetectedFields.length : 0;
  const clickableElements = (lastClickableElements || []).map((el) => ({
    id: el.id,
    label: el.label,
    kind: el.kind || "clickable",
    fillableType: el.fillableType || null,
    hasContent: el.hasContent || false,
  }));

  const res = await fetch(SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_base64: imageBase64,
      task_instruction: taskInstruction,
      redacted_regions_count: redactedRegionsCount,
      clickable_elements: clickableElements,
    }),
  });

  if (!res.ok) throw new Error(`Server responded with ${res.status}`);
  const data = await res.json();
  lastActionResponse = data;
  return data;
}

async function doExecute(elementId, tabId) {
  if (tabId === undefined) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab.id;
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: executeClickByElementId,
    args: [elementId],
  });
  return result.result;
}

async function doFill(elementId, valueType, tabId) {
  const vault = await getVault();

  let value;
  if (valueType === "first_name" || valueType === "last_name") {
    const nameParts = (vault.name || "").trim().split(/\s+/).filter(Boolean);
    if (nameParts.length === 0) {
      value = null;
    } else if (valueType === "first_name") {
      value = nameParts[0];
    } else {
      value = nameParts.length > 1 ? nameParts.slice(1).join(" ") : nameParts[0];
    }
  } else {
    value = vault[valueType];
  }

  if (!value) {
    return { success: false, needsVaultEntry: true, valueType: valueType === "first_name" || valueType === "last_name" ? "name" : valueType };
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id },
    func: executeFillByElementId,
    args: [elementId, value],
  });
  return result.result;
}

// Checks for a blocking popup/overlay/ad across EVERY frame in the tab
// (including cross-origin iframes, via allFrames: true) and, if found,
// clicks its close control directly - no model call involved, same
// "catch it in code" pattern as the error/success detectors below.
async function checkAndDismissPopup(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["popup-detector.js"],
  });

  const detectionResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => detectAndTagPopupClose(),
  });

  const hit = detectionResults.find((r) => r.result && r.result.found);
  if (!hit) return { found: false };

  const [closeResult] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [hit.frameId] },
    func: () => clickTaggedPopupClose(),
  });

  return {
    found: true,
    frameContext: hit.result.frameContext,
    label: hit.result.label,
    closeSuccess: closeResult?.result?.success ?? false,
    closeReason: closeResult?.result?.reason,
  };
}

// Waits for the tab to fully settle after a click that might trigger
// navigation - INCLUDING a CHAIN of redirects, not just the first hop.
// Real gap found: DeluGeRPG's login flow goes /login -> an intermediate
// /login/validate page (which itself reaches "complete" status almost
// immediately, being lightweight) -> a final client-triggered redirect
// to /home/... . A wait that resolved on the FIRST "complete" signal
// caught the loop on /login/validate - a page with real clickable
// elements (so nothing looked obviously broken) but one the browser was
// about to navigate away from again a moment later, invalidating
// whatever got tagged there by the time execution actually ran.
//
// Approach: treat the tab as "settled" only once NAV_SETTLE_BUFFER_MS
// passes with no further status or URL change at all - any activity
// resets the timer, so however many hops a redirect chain has, this
// naturally rides out all of them before resolving. A hard ceiling
// (maxTotalWaitMs) guarantees it can never hang forever even against a
// tab that keeps changing indefinitely (e.g. some unrelated background
// poll).
function waitForTabSettled(tabId, maxTotalWaitMs) {
  return new Promise((resolve) => {
    let finished = false;
    let settleTimer = null;

    const finish = () => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (settleTimer) clearTimeout(settleTimer);
      clearTimeout(hardTimeout);
      resolve();
    };

    const armSettleTimer = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, NAV_SETTLE_BUFFER_MS);
    };

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      // Only status/url changes count as "still navigating" - ignore
      // other changeInfo fields (title, favIconUrl, etc.) that fire
      // routinely without indicating an actual redirect in progress.
      if (changeInfo.status || changeInfo.url) {
        armSettleTimer();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    // Start the settle timer immediately too, so a click that DIDN'T
    // trigger any navigation at all still resolves promptly after one
    // buffer window, rather than waiting for an onUpdated event that
    // will never come.
    armSettleTimer();

    const hardTimeout = setTimeout(finish, maxTotalWaitMs);
  });
}

// Wraps waitForTabSettled() with an unconditional floor BEFORE the
// settle-check even begins. Real gap found: a login click's resulting
// server round-trip (validating credentials) can leave the tab
// completely silent - no status change, no URL change - for a real
// stretch BEFORE any visible navigation starts. waitForTabSettled on
// its own reads that initial silence as "nothing more is coming" and
// resolves immediately, capturing the STILL-on-the-old-page state; the
// real redirect then fires a moment later, invisible to a loop that
// already moved on and (wrongly) concluded the action had no effect.
// This floor gives that invisible pre-navigation gap room to actually
// begin before the silence-based settle logic is ever consulted.
async function waitAfterNavigatingAction(tabId) {
  await new Promise((r) => setTimeout(r, MIN_POST_CLICK_WAIT_MS));
  await waitForTabSettled(tabId, NAV_WAIT_TIMEOUT_MS);
}

// ============================================================
// Manual step buttons - unchanged behavior, now just call the
// reusable functions above instead of duplicating their logic.
// ============================================================

captureBtn.addEventListener("click", async () => {
  statusEl.textContent = "Capturing...";
  captureBtn.disabled = true;
  try {
    const dataUrl = await doCapture();
    statusEl.textContent = `Captured (${Math.round(dataUrl.length / 1024)} KB)`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    console.error("[VisionGuard] capture failed:", err);
  } finally {
    captureBtn.disabled = false;
  }
});

detectBtn.addEventListener("click", async () => {
  statusEl.textContent = "Scanning page for sensitive fields...";
  fieldsContainer.innerHTML = "";
  detectBtn.disabled = true;
  try {
    const { fields } = await doDetect();
    statusEl.textContent = fields.length === 0
      ? "Scan complete - no sensitive fields or faces found."
      : `Found ${fields.length} sensitive region(s) (DOM + face).`;
    fieldsContainer.innerHTML = fields
      .map((f, i) => `<div style="padding:4px 0; border-bottom:1px solid #333;">
            #${i + 1} <strong>${f.category}</strong> — x:${f.x} y:${f.y} w:${f.width} h:${f.height}
          </div>`)
      .join("");
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    console.error("[VisionGuard] detection failed:", err);
  } finally {
    detectBtn.disabled = false;
  }
});

redactBtn.addEventListener("click", async () => {
  statusEl.textContent = "Redacting...";
  try {
    await doRedact();
    statusEl.textContent = `Redacted ${lastDetectedFields.length} region(s).`;
  } catch (err) {
    statusEl.textContent = err.message;
  }
});

sendBtn.addEventListener("click", async () => {
  if (redactedCanvas.width === 0) {
    serverResponseEl.textContent = "Nothing to send - run capture, detect, and redact first.";
    return;
  }
  const taskInstruction = taskInput.value.trim() || "(no instruction given)";
  serverResponseEl.textContent = "Sending redacted image to server...";
  sendBtn.disabled = true;
  try {
    const data = await doSend(taskInstruction);
    serverResponseEl.textContent = `action: ${data.action}\nelement_id: ${data.element_id}\nnote: ${data.note}`;
  } catch (err) {
    serverResponseEl.textContent = `Error sending to server: ${err.message}\n(Is the FastAPI server running on localhost:8000?)`;
    console.error("[VisionGuard] send failed:", err);
  } finally {
    sendBtn.disabled = false;
  }
});

executeBtn.addEventListener("click", async () => {
  if (!lastActionResponse || lastActionResponse.action !== "click" || lastActionResponse.element_id == null) {
    serverResponseEl.textContent += "\n\nNothing to execute - need a 'click' action with an element_id from the server first.";
    return;
  }
  const elementId = lastActionResponse.element_id;
  executeBtn.disabled = true;
  serverResponseEl.textContent += `\n\nExecuting click on element #${elementId}...`;
  try {
    const result = await doExecute(elementId);
    serverResponseEl.textContent += result.success ? `\nClicked: ${result.clickedElement}` : `\nFailed: ${result.reason}`;
  } catch (err) {
    serverResponseEl.textContent += `\nExecution error: ${err.message}`;
    console.error("[VisionGuard] execute failed:", err);
  } finally {
    executeBtn.disabled = false;
  }
});

// ============================================================
// Automatic multi-step task loop.
//
// Each iteration ALWAYS re-captures and re-detects from scratch before
// acting - it never reuses perception from a previous step, since the
// page may have changed (navigation, DOM update) as a result of the
// last action. This is what makes the loop robust to page changes that
// broke the old single-shot flow.
// ============================================================

async function runTask() {
  const taskInstruction = taskInput.value.trim();
  if (!taskInstruction) {
    serverResponseEl.textContent = "Enter a task instruction first.";
    return;
  }

  runTaskBtn.disabled = true;
  resumeTaskBtn.disabled = true;
  resumeBanner.style.display = "none";
  let log = "";

  // Tracks how this run ends, decided at the specific point each stop
  // happens (not guessed afterward from whatever the last log line
  // happened to be) - "success" clears any stored stop reason for
  // this exact task; anything else saves stopReasonText as the new
  // one. Left null if the loop runs out of steps without any explicit
  // stop or success, which is itself treated as a stop below.
  let taskOutcome = null; // "success" | "stopped"
  let stopReasonText = "";
  // Rolling history of the last two distinct action keys, used to
  // detect the model repeating itself - both an immediate repeat
  // (n vs n-1, e.g. clicking the same failing button twice in a row)
  // and a short oscillation (n vs n-2, e.g. A,B,A - alternating
  // between two wrong actions rather than genuinely getting stuck on
  // one). A single previous-action slot could only ever catch the
  // former; checking membership in a short history catches both with
  // one check.
  const ACTION_HISTORY_LENGTH = 2;
  let actionKeyHistory = [];
  const recordActionKey = (key) => {
    actionKeyHistory.push(key);
    if (actionKeyHistory.length > ACTION_HISTORY_LENGTH) {
      actionKeyHistory.shift();
    }
  };

  // Structural completion state for login/signup tasks - scoped to
  // THIS one task run only, reset to nothing every time Run Task is
  // clicked, never persisted anywhere. Tracks the plain FACT of
  // "a password field was visible earlier" and "what URL did this
  // task start at" - never any field VALUE - so a login/signup can be
  // recognized as complete once its password field genuinely
  // disappears and the URL has moved on, without depending on the
  // model correctly interpreting any success message or badge, and
  // without needing real cross-step memory of the kind ruled out
  // earlier for privacy reasons.
  const taskIsAuthTask = /sign\s?up|register|create\s+an?\s+account|create\s+account|log\s?in|sign\s?in/i.test(taskInstruction);
  let taskStartUrl = null;
  let sawPasswordField = false;
  let networkRetryUsed = false; // whether the single automatic network/loading retry has already been used this task run

  const appendLog = (line) => {
    log += line + "\n";
    serverResponseEl.textContent = log;
  };

  // Lock onto the specific window this task is running in ONCE, right
  // here, at the moment the user clicked Run Task - a genuine
  // user-intent moment, not something we should have to re-guess
  // later. Real bug found: chrome.tabs.query({ currentWindow: true })
  // means "whichever window has OS focus RIGHT NOW", not "the window
  // this task started in" - if focus shifts to a different Chrome
  // window at any point mid-task (another testing window left open, a
  // DevTools panel opened via "Inspect popup" for debugging), that
  // query silently starts returning a completely unrelated tab, which
  // the extension was never granted permission to act on, producing a
  // late, confusing "Extension manifest must request permission"
  // error on whatever action happens to run next. Querying by this
  // fixed windowId instead of currentWindow every step means later
  // focus changes elsewhere can no longer redirect the loop onto the
  // wrong window's tab.
  const [initialTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const targetWindowId = initialTab.windowId;

  try {
    for (let step = 1; step <= MAX_LOOP_STEPS; step++) {
      appendLog(`--- Step ${step}/${MAX_LOOP_STEPS} ---`);

      const [activeTab] = await chrome.tabs.query({ active: true, windowId: targetWindowId });
      const tabId = activeTab.id;

      if (step === 1) {
        taskStartUrl = activeTab.url;
      }

      // Domain-drift check - MUST run before doCapture()/doDetect(),
      // not after. Real bug found testing this exact check: a manual
      // navigation to an unrelated site (e.g. typing google.com into
      // the address bar mid-task) revokes the extension's script-
      // injection permission for that tab immediately - attempting
      // doDetect() against it throws before this check (originally
      // placed after detection) ever got a chance to run, crashing the
      // whole loop with a raw permission error instead of recovering.
      // This check only ever needed activeTab.url, never anything from
      // detection, so it can - and now does - run first, using
      // something already available for free. Runs from step 2 onward
      // (step 1 is what establishes taskStartUrl in the first place).
      // Catches the general case of ending up somewhere entirely
      // unintended mid-task - an ad click that navigated away, a
      // redirect to an unrelated tracking/payment domain - without
      // needing to guess from nav-link text the way the step-1-only
      // heuristic below does. Ordinary same-site navigation (e.g.
      // /login -> /login/validate -> /home) never trips it, since the
      // hostname stays constant throughout, but a genuine hijack to a
      // different domain always does.
      if (step > 1 && taskStartUrl) {
        let currentHostname = null;
        let taskHostname = null;
        try {
          currentHostname = new URL(activeTab.url).hostname;
          taskHostname = new URL(taskStartUrl).hostname;
        } catch (e) {
          // Malformed/unusual URL (e.g. a data: URL) - skip the check
          // rather than risk a false positive from a parsing edge case.
        }

        if (currentHostname && taskHostname && currentHostname !== taskHostname) {
          appendLog(
            `\nDetected drift: task started on "${taskHostname}", but the current page is ` +
            `on "${currentHostname}" - likely an unintended navigation (e.g. an ad click). ` +
            `Attempting to go back before attempting any detection on a page we may not ` +
            `have permission to touch.`
          );
          try {
            await chrome.tabs.goBack(tabId);
          } catch (e) {
            appendLog(`Failed to go back: ${e.message}`);
          }

          // Chrome's activeTab permission is a one-time grant tied to
          // the moment this popup was opened - once a tab visits a
          // site outside that grant, permission for that tab is
          // revoked for the rest of this popup session, PERMANENTLY,
          // regardless of navigating back to the correct site
          // afterward (confirmed directly: detection failed again on
          // the very next step, even though the URL had already
          // correctly returned to the task's own domain). Only
          // reopening the extension popup - a fresh user action - can
          // earn a new grant. Rather than optimistically continuing
          // and crashing on the next detection attempt, stop here with
          // an honest explanation: goBack() still leaves the user's
          // browser in the right place, which is real, useful
          // progress, even though this run can't safely continue.
          appendLog(
            `\nNavigated back to the task's site, but Chrome revokes this extension's ` +
            `temporary page-access permission once a tab visits an unrelated site - even ` +
            `after returning, this permission cannot be restored within the same run. ` +
            `Stopping here rather than crashing on the next detection attempt. Click Run ` +
            `Task again to resume with a fresh permission grant.`
          );
          taskOutcome = "stopped";
          stopReasonText = "Navigated to a different site mid-task and lost page-access permission.";
          break;
        }
      }

      appendLog("Capturing and detecting current page state...");
      await doCapture();
      const { fields, clickableElements } = await doDetect(tabId);
      await doRedact();
      appendLog(`Found ${fields.length} sensitive region(s), ${clickableElements.length} clickable element(s).`);
      console.log("[VisionGuard debug] clickableElements:", clickableElements);

      const hasPasswordFieldNow = fields.some((f) => f.category === "password");
      if (hasPasswordFieldNow) {
        sawPasswordField = true;
      }

      appendLog("Checking for blocking popups/overlays (including ad iframes)...");
      const popupCheck = await checkAndDismissPopup(tabId);
      if (popupCheck.found) {
        appendLog(
          `Popup/overlay detected in ${popupCheck.frameContext === "iframe" ? "a cross-origin iframe (likely an ad)" : "the page"} ` +
          `- close control: "${popupCheck.label}". ` +
          (popupCheck.closeSuccess ? "Dismissed." : `Failed to dismiss: ${popupCheck.closeReason}`)
        );
        if (popupCheck.closeSuccess) {
          if (step < MAX_LOOP_STEPS) {
            await new Promise((r) => setTimeout(r, 800));
          }
          continue;
        }
      }

      if (step === 1) {
        const taskWantsSignup = /sign\s?up|register|create\s+an?\s+account|create\s+account/i.test(taskInstruction);
        const taskWantsLogin = /log\s?in|sign\s?in/i.test(taskInstruction) && !taskWantsSignup;

        const signupNavElement = clickableElements.find(
          (el) => el.kind === "clickable" &&
            /sign\s?up|register|create\s+an?\s+account|join\s+now/i.test(el.label) &&
            !/agree/i.test(el.label)
        );
        const loginNavElement = clickableElements.find(
          (el) => el.kind === "clickable" && /log\s?in|sign\s?in/i.test(el.label)
        );

        const mismatchNav = taskWantsSignup ? signupNavElement : (taskWantsLogin ? loginNavElement : null);

        if (mismatchNav) {
          appendLog(
            `Task mentions "${taskWantsSignup ? "sign up" : "log in"}" - found a matching ` +
            `navigation element ("${mismatchNav.label}"). Clicking it directly before any ` +
            `field-filling, since this is a clear, checkable page/task mismatch rather than ` +
            `a judgment call worth risking to the model.`
          );
          const navResult = await doExecute(mismatchNav.id, tabId);
          appendLog(navResult.success ? `Clicked: ${navResult.clickedElement}` : `Failed: ${navResult.reason}`);
          recordActionKey(`click:${mismatchNav.id}:${mismatchNav.label}:${activeTab.url}`);

          if (step < MAX_LOOP_STEPS) {
            appendLog("Waiting for page navigation to complete before re-perceiving...\n");
            await waitAfterNavigatingAction(tabId);
          }
          continue;
        }
      }

      await chrome.scripting.executeScript({ target: { tabId }, files: ["error-detector.js"] });
      const [errorResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => detectPageErrors(),
      });

      if (errorResult.result.found) {
        appendLog(`\nERROR DETECTED ON PAGE: "${errorResult.result.message}"`);
        appendLog("Stopping - please correct the issue and re-run the task.");
        alert(`VisionGuard detected a page error:\n\n"${errorResult.result.message}"\n\nPlease correct the issue and try again.`);
        taskOutcome = "stopped";
        stopReasonText = `Page showed an error: "${errorResult.result.message}"`;
        break;
      }

      // Structural success check for login/signup tasks specifically:
      // a password field was genuinely present earlier THIS task, is
      // genuinely absent now (gone from detection entirely, not just
      // redacted-and-hidden), and the URL has changed since the task
      // began. Unlike the keyword-based check below, this can't be
      // fooled by an unfamiliar "success"-shaped badge (a Cloudflare
      // widget, say) - it doesn't depend on the model, or on this
      // check itself, correctly interpreting any UI content at all.
      if (taskIsAuthTask && sawPasswordField && !hasPasswordFieldNow && activeTab.url !== taskStartUrl) {
        appendLog(
          `\nStructural success check: a password field was present ` +
          `earlier in this task and is no longer on the page, and the ` +
          `URL has changed since the task started (${taskStartUrl} -> ` +
          `${activeTab.url}). Treating this as a completed login/signup, ` +
          `independent of any success-message text or the model's own ` +
          `judgment.`
        );
        appendLog("Task complete - stopping here rather than continuing to interact with a completed page.");
        taskOutcome = "success";
        break;
      }

      const [successResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => detectPageSuccess(),
      });

      if (successResult.result.found) {
        appendLog(`\nSuccess confirmation detected on page: "${successResult.result.message}"`);
        appendLog("Task complete - stopping here rather than continuing to interact with a completed page.");
        taskOutcome = "success";
        break;
      }

      const vaultForFill = await getVault();
      const hasVaultValueFor = (fillableType) => {
        if (fillableType === "first_name" || fillableType === "last_name") {
          return Boolean((vaultForFill.name || "").trim());
        }
        return Boolean(vaultForFill[fillableType]);
      };
      const emptyFillableWithVaultValue = step > 1
        ? clickableElements.find(
            (el) => el.kind === "fillable" && !el.hasContent && hasVaultValueFor(el.fillableType)
          )
        : null;

      if (emptyFillableWithVaultValue) {
        appendLog(
          `Auto-filling "${emptyFillableWithVaultValue.label}" (${emptyFillableWithVaultValue.fillableType}) ` +
          `from vault - skipping model reasoning for this step, since this is a ` +
          `deterministic fill, not a judgment call.`
        );
        const fillResult = await doFill(emptyFillableWithVaultValue.id, emptyFillableWithVaultValue.fillableType, tabId);
        appendLog(fillResult.success ? `Filled: ${fillResult.filledElement}` : `Failed: ${fillResult.reason}`);

        if (step < MAX_LOOP_STEPS) {
          await new Promise((r) => setTimeout(r, 1200));
        }
        continue;
      }

      const taskSaysNoSubmit = /\bdon'?t\s+submit\b|\bdo\s+not\s+submit\b|without\s+submitting/i.test(taskInstruction);
      if (taskSaysNoSubmit && step > 1) {
        appendLog(
          `\nTask says not to submit, and there's nothing left to auto-fill from the ` +
          `vault. Treating the task as complete here rather than asking the model to ` +
          `invent a next action it was never asked to take.`
        );
        taskOutcome = "success";
        break;
      }

      appendLog("Reasoning...");
      const response = await doSend(taskInstruction);
      appendLog(`action: ${response.action}, element_id: ${response.element_id}`);
      appendLog(`note: ${response.note}`);

      if (response.error_detected && response.error_message) {
        const categoryLabel = response.error_category ? ` [${response.error_category}]` : "";

        // Narrow, capped corrective action for exactly ONE error
        // category. A network/loading issue is often transient (a
        // slow page, a momentary connectivity blip), unlike every
        // other category, where retrying could actively make things
        // worse (e.g. resubmitting the same wrong credentials, or
        // re-triggering an already-exists conflict) - so this is the
        // one case where waiting longer and looking again is a safe,
        // reasonable response to try, capped at exactly once per task
        // run. The model's own behavior is unchanged by this: it still
        // always reports the error and stops choosing an action, per
        // the server prompt; this retry decision is made entirely
        // client-side, based on the category alone.
        if (response.error_category === "network_or_loading_issue" && !networkRetryUsed) {
          networkRetryUsed = true;
          appendLog(
            `\nModel reported a network/loading issue${categoryLabel}: ` +
            `"${response.error_message}". This category is often transient, so ` +
            `trying once more after a longer wait, rather than stopping ` +
            `immediately.`
          );
          if (step < MAX_LOOP_STEPS) {
            await new Promise((r) => setTimeout(r, NETWORK_RETRY_WAIT_MS));
          }
          continue;
        }

        appendLog(`\nERROR DETECTED (model-reported)${categoryLabel}: ${response.error_message}`);
        appendLog("Stopping - please correct the issue and re-run the task.");
        alert(`VisionGuard detected a page error${categoryLabel}:\n\n"${response.error_message}"\n\nPlease correct the issue and try again.`);
        taskOutcome = "stopped";
        stopReasonText = `Page showed an error: "${response.error_message}"`;
        break;
      }

      if (response.action === "none") {
        if (response.rejected) {
          appendLog(
            "\nStopped - NOT a genuine task completion. The model's last " +
            "response was invalid (e.g. it picked a nonexistent element) " +
            "and was rejected by the server's validation check. The loop " +
            "gave up rather than guess, but the task was not actually " +
            "finished."
          );
          taskOutcome = "stopped";
          stopReasonText = "The AI's last suggested action was invalid and got rejected.";
        } else {
          appendLog("\nTask complete - model reports no further action needed.");
          taskOutcome = "success";
        }
        break;
      }

      let actionMightNavigate = false;

      if (response.action === "click" && response.element_id != null) {
        const targetLabel = (clickableElements.find((el) => el.id === response.element_id) || {}).label || "";
        const actionKey = `${response.action}:${response.element_id}:${targetLabel}:${activeTab.url}`;
        if (actionKeyHistory.includes(actionKey)) {
          appendLog(
            `\nStopping - model chose an action it already tried within the last ` +
            `${ACTION_HISTORY_LENGTH} attempts on this same page (element ` +
            `#${response.element_id}, "${targetLabel}"). This usually means the ` +
            `action isn't producing the expected page change - either an ` +
            `immediate repeat, or a short back-and-forth between a couple of ` +
            `wrong actions. The model has no memory of prior steps to recognize ` +
            `this on its own, so the loop stops here rather than repeating uselessly.`
          );
          taskOutcome = "stopped";
          stopReasonText = "Got stuck repeating (or alternating between) the same click(s).";
          break;
        }
        recordActionKey(actionKey);
        actionMightNavigate = true;

        appendLog(`Executing click on element #${response.element_id}...`);
        const execResult = await doExecute(response.element_id, tabId);
        appendLog(execResult.success ? `Clicked: ${execResult.clickedElement}` : `Failed: ${execResult.reason}`);

        if (!execResult.success) {
          appendLog("\nStopping loop - execution failed.");
          taskOutcome = "stopped";
          stopReasonText = `Failed to click an element: ${execResult.reason}`;
          break;
        }
      } else if (response.action === "type" && response.element_id != null && response.value_type) {
        const targetLabel = (clickableElements.find((el) => el.id === response.element_id) || {}).label || "";
        const actionKey = `${response.action}:${response.element_id}:${response.value_type}:${targetLabel}:${activeTab.url}`;
        if (actionKeyHistory.includes(actionKey)) {
          appendLog(
            `\nStopping - model chose a type action it already tried within the ` +
            `last ${ACTION_HISTORY_LENGTH} attempts on this same page (element ` +
            `#${response.element_id}, ${response.value_type}, "${targetLabel}"). ` +
            `This usually means the field already has a value the model isn't ` +
            `recognizing as filled (for example, a redacted field showing a ` +
            `placeholder in the image the model sees, rather than the real ` +
            `content), or a short back-and-forth between a couple of wrong ` +
            `actions. The loop stops here rather than repeating uselessly.`
          );
          taskOutcome = "stopped";
          stopReasonText = "Got stuck repeating (or alternating between) the same fill action(s).";
          break;
        }
        recordActionKey(actionKey);

        appendLog(`Filling element #${response.element_id} with vault value (${response.value_type})...`);
        const fillResult = await doFill(response.element_id, response.value_type, tabId);

        if (fillResult.needsVaultEntry) {
          appendLog(`\nVault has no saved "${fillResult.valueType}" value.`);
          alert(`VisionGuard needs your "${fillResult.valueType}" to continue this task, but nothing is saved in the vault yet.\n\nOpen the extension popup, fill in the Vault section, and run the task again.`);
          appendLog("Stopping - please add this to your vault and re-run the task.");
          taskOutcome = "stopped";
          stopReasonText = `Needed a "${fillResult.valueType}" value that isn't saved in the vault yet.`;
          break;
        }

        appendLog(fillResult.success ? `Filled: ${fillResult.filledElement}` : `Failed: ${fillResult.reason}`);
        if (!fillResult.success) {
          appendLog("\nStopping loop - fill failed.");
          taskOutcome = "stopped";
          stopReasonText = `Failed to fill a field: ${fillResult.reason}`;
          break;
        }
      } else {
        appendLog("\nStopping loop - no actionable response returned.");
        taskOutcome = "stopped";
        stopReasonText = "The AI didn't return a usable next action.";
        break;
      }

      if (step < MAX_LOOP_STEPS) {
        if (actionMightNavigate) {
          appendLog("Waiting for page navigation to complete before re-perceiving...\n");
          await waitAfterNavigatingAction(tabId);
        } else {
          appendLog(`Waiting ${POST_ACTION_WAIT_MS}ms for page to settle before re-perceiving...\n`);
          await new Promise((r) => setTimeout(r, POST_ACTION_WAIT_MS));
        }
      }
    }

    // Reaching here (loop condition became false rather than an
    // explicit break) means every step ran without success or an
    // explicit stop - genuinely ran out of room, not the same as any
    // of the specific reasons above.
    if (taskOutcome === null) {
      appendLog(`\nReached the maximum number of steps (${MAX_LOOP_STEPS}) without finishing.`);
      taskOutcome = "stopped";
      stopReasonText = `Reached the maximum number of steps (${MAX_LOOP_STEPS}) without finishing.`;
    }
  } catch (err) {
    appendLog(`\nLoop error: ${err.message}`);
    console.error("[VisionGuard] task loop failed:", err);
    taskOutcome = "stopped";
    stopReasonText = `Crashed with an error: ${err.message}`;
  } finally {
    runTaskBtn.disabled = false;
    resumeTaskBtn.disabled = false;

    // Local-only record of why this task stopped, keyed to this exact
    // task's text - cleared the moment it succeeds, overwritten with
    // the latest reason otherwise. Never sent anywhere, never used for
    // anything but showing a short "resume?" hint next time this same
    // task is typed in.
    if (taskOutcome === "success") {
      await clearTaskStopReason(taskInstruction);
    } else {
      await saveTaskStopReason(taskInstruction, stopReasonText || "Stopped for an unknown reason.");
    }
    await refreshResumeBanner();
  }
}

runTaskBtn.addEventListener("click", runTask);
resumeTaskBtn.addEventListener("click", runTask);