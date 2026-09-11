// VisionGuard - popup.js
//
// v5: refactored the individual step handlers (capture/detect/redact/
// send/execute) into reusable async functions, and added an automatic
// multi-step task loop on top of them.
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
const executeBtn = document.getElementById("executeBtn");
const taskInput = document.getElementById("taskInput");
const sendBtn = document.getElementById("sendBtn");
const serverResponseEl = document.getElementById("serverResponse");
const runTaskBtn = document.getElementById("runTaskBtn");

// --- Vault UI ---
// vault.js (loaded via <script> tag in popup.html, same context as this
// file - not injected into the page) provides getVault/saveVault.
const vaultNameInput = document.getElementById("vaultName");
const vaultEmailInput = document.getElementById("vaultEmail");
const vaultPhoneInput = document.getElementById("vaultPhone");
const vaultAddressInput = document.getElementById("vaultAddress");
const vaultPasswordInput = document.getElementById("vaultPassword");
const saveVaultBtn = document.getElementById("saveVaultBtn");
const vaultStatusEl = document.getElementById("vaultStatus");

async function loadVaultIntoUI() {
  const vault = await getVault();
  vaultNameInput.value = vault.name || "";
  vaultEmailInput.value = vault.email || "";
  vaultPhoneInput.value = vault.phone || "";
  vaultAddressInput.value = vault.address || "";
  vaultPasswordInput.value = vault.password || "";
}
loadVaultIntoUI();

saveVaultBtn.addEventListener("click", async () => {
  const saved = await saveVault({
    name: vaultNameInput.value.trim(),
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
const POST_ACTION_WAIT_MS = 1500; // fixed settle time after an action, before re-perceiving

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

function generateFakeValue(fakeType) {
  const FAKE_VALUES = {
    password: "••••••••••",
    email: "user@example.com",
    phone: "(555) 123-4567",
    name: "Jordan Smith",
    dob: "01/15/1990",
    address: "123 Main Street",
    card_number: "4111 1111 1111 1111",
    expiry: "12/29",
    cvv: "123",
    government_id: "XXX-XX-1234",
  };
  return FAKE_VALUES[fakeType] || "[redacted]";
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
  const el = document.querySelector(`[data-visionguard-id="${elementId}"]`);
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

// Fills a text field with a value, dispatching proper input/change
// events so frameworks (React, Vue, etc.) that listen for those events
// register the change - just setting .value directly is invisible to
// most modern form-handling code.
function executeFillByElementId(elementId, value) {
  const el = document.querySelector(`[data-visionguard-id="${elementId}"]`);
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
    // contenteditable / role=textbox (Google Forms and similar custom-
    // rendered fields) - no .value property at all, text content IS
    // the value. Focus first since some frameworks only register the
    // change if the element was genuinely focused when it changed.
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

async function doDetect() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dom-detector.js"] });
  const [domResult] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
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

  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["clickable-detector.js"] });
  const [clickableResult] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
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

async function doExecute(elementId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: executeClickByElementId,
    args: [elementId],
  });
  return result.result;
}

// Fills a field from the local vault. Returns a special
// { success: false, needsVaultEntry: true } shape if the vault has no
// value for the requested type - the caller decides how to handle that
// (currently: stop and prompt the human, never guess or leave blank
// silently).
async function doFill(elementId, valueType) {
  const vault = await getVault();
  const value = vault[valueType];

  if (!value) {
    return { success: false, needsVaultEntry: true, valueType };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: executeFillByElementId,
    args: [elementId, value],
  });
  return result.result;
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

runTaskBtn.addEventListener("click", async () => {
  const taskInstruction = taskInput.value.trim();
  if (!taskInstruction) {
    serverResponseEl.textContent = "Enter a task instruction first.";
    return;
  }

  runTaskBtn.disabled = true;
  let log = "";
  let lastActionKey = null; // tracks (action, element_id) to detect the model repeating itself
  const appendLog = (line) => {
    log += line + "\n";
    serverResponseEl.textContent = log;
  };

  try {
    for (let step = 1; step <= MAX_LOOP_STEPS; step++) {
      appendLog(`--- Step ${step}/${MAX_LOOP_STEPS} ---`);

      appendLog("Capturing and detecting current page state...");
      await doCapture();
      const { fields, clickableElements } = await doDetect();
      await doRedact();
      appendLog(`Found ${fields.length} sensitive region(s), ${clickableElements.length} clickable element(s).`);
      console.log("[VisionGuard debug] clickableElements:", clickableElements);

      // Deterministic navigation check - STEP 1 ONLY. The model was
      // explicitly instructed (in the server prompt) to recognize when
      // it's on the wrong page for the task and navigate first, but in
      // practice it repeatedly ignored that instruction and filled
      // fields on a login page even when the task said "sign up". That's
      // real evidence this specific judgment call isn't reliable for a
      // 3B model, not a prompt-wording problem worth iterating on
      // further tonight. Same fix pattern as auto-fill: take the
      // decision away from the model for the one narrow, checkable case
      // we can detect confidently in code.
      if (step === 1) {
        const taskWantsSignup = /sign\s?up|register|create\s+an?\s+account|create\s+account/i.test(taskInstruction);
        const taskWantsLogin = /log\s?in|sign\s?in/i.test(taskInstruction) && !taskWantsSignup;

        const signupNavElement = clickableElements.find(
          (el) => el.kind === "clickable" &&
            /sign\s?up|register|create\s+an?\s+account|join\s+now/i.test(el.label) &&
            // "Agree & Sign Up!" style labels are the signup FORM's own
            // submit button, not a link to navigate TO the signup page -
            // real bug found when this fired on an already-loaded signup
            // page and clicked Submit before any field was filled.
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
          const navResult = await doExecute(mismatchNav.id);
          appendLog(navResult.success ? `Clicked: ${navResult.clickedElement}` : `Failed: ${navResult.reason}`);
          lastActionKey = `click:${mismatchNav.id}`;

          if (step < MAX_LOOP_STEPS) {
            await new Promise((r) => setTimeout(r, POST_ACTION_WAIT_MS));
          }
          continue;
        }
      }

      // Check for a page-level error DETERMINISTICALLY via DOM text,
      // before even calling the model. This is more reliable than
      // asking the VLM to visually read and self-report error text,
      // and also saves an unnecessary inference call once we already
      // know the page is showing a failure.
      const [tabForErrorCheck] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.scripting.executeScript({ target: { tabId: tabForErrorCheck.id }, files: ["error-detector.js"] });
      const [errorResult] = await chrome.scripting.executeScript({
        target: { tabId: tabForErrorCheck.id },
        func: () => detectPageErrors(),
      });

      if (errorResult.result.found) {
        appendLog(`\nERROR DETECTED ON PAGE: "${errorResult.result.message}"`);
        appendLog("Stopping - please correct the issue and re-run the task.");
        alert(`VisionGuard detected a page error:\n\n"${errorResult.result.message}"\n\nPlease correct the issue and try again.`);
        break;
      }

      // Same deterministic pattern as the error check above, for the
      // opposite signal: a genuine success/confirmation message. Without
      // this, the model has no way to know a task already succeeded and
      // will keep interacting with whatever's left on the page (real
      // observed case: clicking "Submit another response" after a form
      // had already been submitted successfully, since nothing told it
      // that page state meant "done").
      const [successResult] = await chrome.scripting.executeScript({
        target: { tabId: tabForErrorCheck.id },
        func: () => detectPageSuccess(),
      });

      if (successResult.result.found) {
        appendLog(`\nSuccess confirmation detected on page: "${successResult.result.message}"`);
        appendLog("Task complete - stopping here rather than continuing to interact with a completed page.");
        break;
      }

      // Deterministic auto-fill pass: fill any empty fillable field the
      // vault has a value for, BEFORE asking the model what to do -
      // EXCEPT on step 1. The model must always get to make the first
      // move on a fresh task, because "is this even the right page for
      // this task?" is a judgment call auto-fill can't make - it just
      // fills whatever's in front of it with no sense of context. If
      // the user says "sign up" while sitting on a login page, step 1
      // needs to recognize that and navigate first; only once we're
      // plausibly on the right page should deterministic filling take
      // over, which is why this only activates from step 2 onward.
      const vaultForFill = await getVault();
      const emptyFillableWithVaultValue = step > 1
        ? clickableElements.find(
            (el) => el.kind === "fillable" && !el.hasContent && vaultForFill[el.fillableType]
          )
        : null;

      if (emptyFillableWithVaultValue) {
        appendLog(
          `Auto-filling "${emptyFillableWithVaultValue.label}" (${emptyFillableWithVaultValue.fillableType}) ` +
          `from vault - skipping model reasoning for this step, since this is a ` +
          `deterministic fill, not a judgment call.`
        );
        const fillResult = await doFill(emptyFillableWithVaultValue.id, emptyFillableWithVaultValue.fillableType);
        appendLog(fillResult.success ? `Filled: ${fillResult.filledElement}` : `Failed: ${fillResult.reason}`);

        if (step < MAX_LOOP_STEPS) {
          // Chrome hard-caps captureVisibleTab() calls per second
          // (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND) - 400ms was too
          // fast and tripped that limit on a real run. A fill doesn't
          // need the full 1500ms navigation-settle wait, but it does
          // need enough headroom to stay under Chrome's own rate limit.
          await new Promise((r) => setTimeout(r, 1200));
        }
        continue; // next loop iteration re-detects and checks for more fields to fill
      }

      // If the task explicitly says not to submit/click further, and
      // there's nothing left for the deterministic auto-fill pass to
      // fill, the task is genuinely done - full stop, no model call.
      // Without this, the model has no concept of "the task was only
      // ever autofill" and will wander into clicking something else
      // once filling is finished (real observed case: it correctly
      // avoided the Submit button per instruction, then clicked "Sign
      // in to Google" instead, since nothing told it there was nothing
      // left to legitimately do).
      const taskSaysNoSubmit = /\bdon'?t\s+submit\b|\bdo\s+not\s+submit\b|without\s+submitting/i.test(taskInstruction);
      if (taskSaysNoSubmit && step > 1) {
        appendLog(
          `\nTask says not to submit, and there's nothing left to auto-fill from the ` +
          `vault. Treating the task as complete here rather than asking the model to ` +
          `invent a next action it was never asked to take.`
        );
        break;
      }

      appendLog("Reasoning...");
      const response = await doSend(taskInstruction);
      appendLog(`action: ${response.action}, element_id: ${response.element_id}`);
      appendLog(`note: ${response.note}`);

      // Keep the model's own error self-report too, as a secondary
      // check - the DOM scan above covers the common case reliably,
      // but this catches anything visually implied that has no
      // matching text keyword (e.g. a red border with no message).
      if (response.error_detected && response.error_message) {
        appendLog(`\nERROR DETECTED (model-reported): ${response.error_message}`);
        appendLog("Stopping - please correct the issue and re-run the task.");
        alert(`VisionGuard detected a page error:\n\n"${response.error_message}"\n\nPlease correct the issue and try again.`);
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
        } else {
          appendLog("\nTask complete - model reports no further action needed.");
        }
        break;
      }

      if (response.action === "click" && response.element_id != null) {
        // Repeat-action safeguard: the model has no memory of prior steps
        // in this loop, so it can't tell "I already tried this and it
        // didn't work" - it just sees a similar-looking page and repeats
        // itself. Detecting this in code (not asking the model to) stops
        // a genuinely stuck loop from burning through every remaining
        // step on the same failing action.
        const actionKey = `${response.action}:${response.element_id}`;
        if (actionKey === lastActionKey) {
          appendLog(
            `\nStopping - model chose the same action twice in a row ` +
            `(element #${response.element_id}). This usually means the ` +
            `action isn't producing the expected page change (e.g. a ` +
            `login attempt that fails and returns to the same form). ` +
            `The model has no memory of prior steps to recognize this on ` +
            `its own, so the loop stops here rather than repeating ` +
            `uselessly.`
          );
          break;
        }
        lastActionKey = actionKey;

        appendLog(`Executing click on element #${response.element_id}...`);
        const execResult = await doExecute(response.element_id);
        appendLog(execResult.success ? `Clicked: ${execResult.clickedElement}` : `Failed: ${execResult.reason}`);

        if (!execResult.success) {
          appendLog("\nStopping loop - execution failed.");
          break;
        }
      } else if (response.action === "type" && response.element_id != null && response.value_type) {
        // Same repeat-safeguard as click actions - this was previously
        // ONLY checked for clicks, which is exactly why the model could
        // repeat an identical "type" request 4 times in a row (steps
        // 3-6 of the DeluGeRPG run) without the loop ever catching it.
        const actionKey = `${response.action}:${response.element_id}:${response.value_type}`;
        if (actionKey === lastActionKey) {
          appendLog(
            `\nStopping - model chose the same type action twice in a row ` +
            `(element #${response.element_id}, ${response.value_type}). This ` +
            `usually means the field already has a value the model isn't ` +
            `recognizing as filled (for example, a redacted field showing a ` +
            `placeholder in the image the model sees, rather than the real ` +
            `content). The loop stops here rather than repeating uselessly.`
          );
          break;
        }
        lastActionKey = actionKey;

        appendLog(`Filling element #${response.element_id} with vault value (${response.value_type})...`);
        const fillResult = await doFill(response.element_id, response.value_type);

        if (fillResult.needsVaultEntry) {
          appendLog(`\nVault has no saved "${fillResult.valueType}" value.`);
          alert(`VisionGuard needs your "${fillResult.valueType}" to continue this task, but nothing is saved in the vault yet.\n\nOpen the extension popup, fill in the Vault section, and run the task again.`);
          appendLog("Stopping - please add this to your vault and re-run the task.");
          break;
        }

        appendLog(fillResult.success ? `Filled: ${fillResult.filledElement}` : `Failed: ${fillResult.reason}`);
        if (!fillResult.success) {
          appendLog("\nStopping loop - fill failed.");
          break;
        }
      } else {
        appendLog("\nStopping loop - no actionable response returned.");
        break;
      }

      if (step < MAX_LOOP_STEPS) {
        appendLog(`Waiting ${POST_ACTION_WAIT_MS}ms for page to settle before re-perceiving...\n`);
        await new Promise((r) => setTimeout(r, POST_ACTION_WAIT_MS));
      }
    }
  } catch (err) {
    appendLog(`\nLoop error: ${err.message}`);
    console.error("[VisionGuard] task loop failed:", err);
  } finally {
    runTaskBtn.disabled = false;
  }
});