// VisionGuard - popup.js
// Step 2: capture the visible tab and preview it here.
// No redaction, no server call yet - just proving we can see the screen.

const captureBtn = document.getElementById("captureBtn");
const statusEl = document.getElementById("status");
const previewContainer = document.getElementById("preview-container");
const previewImg = document.getElementById("preview");

// Shared state across the three steps - capture, detect, redact.
// We need the last screenshot AND the last detected fields together
// to actually draw the redaction boxes in the right place.
let lastCaptureDataUrl = null;
let lastDetectedFields = null;
let lastDevicePixelRatio = 1;
let lastActualDevicePixelRatio = 1; // kept separate - used to convert server bbox coords back to CSS pixels for clicking
let lastActionResponse = null; // the server's last returned action, for the execute step
let lastClickableElements = null; // Set-of-Mark: numbered clickable elements for the model to choose from

// Loads a data URL into an actual <img> element (BlazeFace needs a real
// DOM image/canvas to read pixels from, not just a base64 string) and
// runs detectFaces() on it, from face-detector.js.
function detectFacesInDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      try {
        const faces = await detectFaces(img);
        resolve(faces);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

const detectBtn = document.getElementById("detectBtn");
const fieldsContainer = document.getElementById("fields-container");

detectBtn.addEventListener("click", async () => {
  statusEl.textContent = "Scanning page for sensitive fields...";
  fieldsContainer.innerHTML = "";
  detectBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Step 1: inject dom-detector.js so detectSensitiveFields() exists
    // in the page's own context (not the extension's context).
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["dom-detector.js"],
    });

    // Step 2: now call that function and get its return value back.
    const [injectionResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => detectSensitiveFields(),
    });

    const { fields, devicePixelRatio, viewport } = injectionResult.result;
    lastActualDevicePixelRatio = devicePixelRatio;

    // DOM fields are in CSS pixels - scale to device pixels now so
    // everything downstream (redaction, face results) is in one
    // consistent coordinate space: device pixels, matching the screenshot.
    const domFieldsScaled = fields.map((f) => ({
      category: f.category,
      x: Math.round(f.x * devicePixelRatio),
      y: Math.round(f.y * devicePixelRatio),
      width: Math.round(f.width * devicePixelRatio),
      height: Math.round(f.height * devicePixelRatio),
    }));

    let allFields = domFieldsScaled;

    // Run face detection too, if we have a captured screenshot to scan.
    // Face coordinates from BlazeFace are already in device-pixel space
    // (they come from the screenshot image directly), so no scaling needed.
    if (lastCaptureDataUrl) {
      statusEl.textContent = "Scanning for faces...";
      const faces = await detectFacesInDataUrl(lastCaptureDataUrl);
      allFields = allFields.concat(faces);
    }

    // Save for the redact step - now in device pixels throughout,
    // so the redact step no longer needs to multiply by devicePixelRatio.
    lastDetectedFields = allFields;
    lastDevicePixelRatio = 1; // already applied above

    // Set-of-Mark: also detect every clickable element on the page, so
    // the model can pick a numbered element instead of guessing coordinates.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["clickable-detector.js"],
    });
    const [clickableResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => detectClickableElements(),
    });
    lastClickableElements = clickableResult.result.elements;
    console.log(`[VisionGuard] found ${lastClickableElements.length} clickable elements`);

    if (allFields.length === 0) {
      statusEl.textContent = "Scan complete - no sensitive fields or faces found.";
    } else {
      statusEl.textContent = `Found ${allFields.length} sensitive region(s) (DOM + face).`;
    }

    fieldsContainer.innerHTML = allFields
      .map(
        (f, i) =>
          `<div style="padding:4px 0; border-bottom:1px solid #333;">
            #${i + 1} <strong>${f.category}</strong> —
            x:${f.x} y:${f.y} w:${f.width} h:${f.height}
          </div>`
      )
      .join("");
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    console.error("[VisionGuard] detection failed:", err);
  } finally {
    detectBtn.disabled = false;
  }
});

captureBtn.addEventListener("click", async () => {
  statusEl.textContent = "Capturing...";
  captureBtn.disabled = true;

  try {
    // captureVisibleTab grabs a screenshot of the current tab as a
    // base64 data URL. It only works on the ACTIVE tab of the CURRENT
    // window, and requires the "activeTab" permission (already in manifest).
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: "png",
    });

    previewImg.src = dataUrl;
    lastCaptureDataUrl = dataUrl;
    previewContainer.classList.add("visible");
    statusEl.textContent = `Captured (${Math.round(dataUrl.length / 1024)} KB)`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    console.error("[VisionGuard] capture failed:", err);
  } finally {
    captureBtn.disabled = false;
  }
});

// --- Step 4: Redact ---
// Draws the captured screenshot onto a canvas, then paints solid black
// rectangles over every detected sensitive field. Coordinates from the
// DOM detector are in CSS pixels; the screenshot is in device pixels,
// so we multiply by devicePixelRatio to line them up correctly.

const redactBtn = document.getElementById("redactBtn");
const redactedContainer = document.getElementById("redacted-container");
const redactedCanvas = document.getElementById("redactedCanvas");

redactBtn.addEventListener("click", async () => {
  if (!lastCaptureDataUrl) {
    statusEl.textContent = "Capture the screen first.";
    return;
  }
  if (!lastDetectedFields) {
    statusEl.textContent = "Detect sensitive fields first.";
    return;
  }

  statusEl.textContent = "Redacting...";

  const img = new Image();
  img.onload = () => {
    redactedCanvas.width = img.width;
    redactedCanvas.height = img.height;

    const ctx = redactedCanvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    // Black out each sensitive field, scaled from CSS px to device px.
    ctx.fillStyle = "#000000";
    lastDetectedFields.forEach((field) => {
      const x = field.x * lastDevicePixelRatio;
      const y = field.y * lastDevicePixelRatio;
      const w = field.width * lastDevicePixelRatio;
      const h = field.height * lastDevicePixelRatio;
      ctx.fillRect(x, y, w, h);
    });

    // Draw numbered labels for every clickable element (Set-of-Mark),
    // scaled from CSS px to device px same as everything else. This is
    // what lets the model pick a number instead of guessing coordinates.
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
    statusEl.textContent = `Redacted ${lastDetectedFields.length} region(s).`;
  };
  img.src = lastCaptureDataUrl;
});

// This function gets injected into the actual page. Unlike the old
// coordinate-guessing approach, this finds the EXACT element the model
// chose via the stable data-visionguard-id tag set during detection -
// so once the model picks the right number, the click is guaranteed
// accurate, no fuzzy point-based lookup involved.
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

// --- Step 7: execute the action the server told us to take ---

const executeBtn = document.getElementById("executeBtn");

executeBtn.addEventListener("click", async () => {
  if (!lastActionResponse || lastActionResponse.action !== "click" || lastActionResponse.element_id == null) {
    serverResponseEl.textContent += "\n\nNothing to execute - need a 'click' action with an element_id from the server first.";
    return;
  }

  const elementId = lastActionResponse.element_id;

  executeBtn.disabled = true;
  serverResponseEl.textContent += `\n\nExecuting click on element #${elementId}...`;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: executeClickByElementId,
      args: [elementId],
    });

    if (result.result.success) {
      serverResponseEl.textContent += `\nClicked: ${result.result.clickedElement}`;
    } else {
      serverResponseEl.textContent += `\nFailed: ${result.result.reason}`;
    }
  } catch (err) {
    serverResponseEl.textContent += `\nExecution error: ${err.message}`;
    console.error("[VisionGuard] execute failed:", err);
  } finally {
    executeBtn.disabled = false;
  }
});

// Exposed for the send step - converts the current redacted canvas to a
// base64 PNG string.
function getRedactedImageBase64() {
  const dataUrl = redactedCanvas.toDataURL("image/png");
  return dataUrl.split(",")[1]; // strip the "data:image/png;base64," prefix
}

// --- Step 5: send redacted image to the server ---
// This is the actual privacy boundary crossing: everything before this
// point stays on-device. Only the redacted image + task text leave the
// browser, exactly as the problem statement requires.

const taskInput = document.getElementById("taskInput");
const sendBtn = document.getElementById("sendBtn");
const serverResponseEl = document.getElementById("serverResponse");

const SERVER_URL = "http://localhost:8000/agent/step";

sendBtn.addEventListener("click", async () => {
  if (redactedCanvas.width === 0) {
    serverResponseEl.textContent = "Nothing to send - run capture, detect, and redact first.";
    return;
  }

  const taskInstruction = taskInput.value.trim() || "(no instruction given)";
  const imageBase64 = getRedactedImageBase64();
  const redactedRegionsCount = lastDetectedFields ? lastDetectedFields.length : 0;
  const clickableElements = (lastClickableElements || []).map((el) => ({
    id: el.id,
    label: el.label,
  }));

  serverResponseEl.textContent = "Sending redacted image to server...";
  sendBtn.disabled = true;

  try {
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

    if (!res.ok) {
      throw new Error(`Server responded with ${res.status}`);
    }

    const data = await res.json();
    lastActionResponse = data;
    serverResponseEl.textContent =
      `action: ${data.action}\n` +
      `element_id: ${data.element_id}\n` +
      `note: ${data.note}`;
  } catch (err) {
    serverResponseEl.textContent = `Error sending to server: ${err.message}\n` +
      `(Is the FastAPI server running on localhost:8000?)`;
    console.error("[VisionGuard] send failed:", err);
  } finally {
    sendBtn.disabled = false;
  }
});