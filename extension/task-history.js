// VisionGuard - task-history.js
//
// A local, on-device record of why the LAST attempt at a given task
// stopped - nothing more. Uses chrome.storage.local, same as vault.js:
// data never leaves the device, never transmits anywhere, and is
// never sent to the server or the model.
//
// Scope, deliberately narrow: keyed by the exact task instruction text
// (normalized), holding only a short plain-English stop reason and a
// timestamp - never individual steps, never field values, never
// anything from the page itself. Cleared automatically the moment
// that exact task instruction succeeds; a different task instruction
// has its own independent entry and is never affected. This is NOT
// cross-step memory of the kind deliberately ruled out elsewhere in
// this project for privacy reasons - it persists only a single short
// sentence about the most recent outcome, purely so the person isn't
// forced to remember or scroll back through an old log themselves.

const TASK_HISTORY_STORAGE_KEY = "visionguard_task_stop_history";

// Light normalization only (trim + collapse whitespace + lowercase) -
// enough that retyping "Login" vs "login " still counts as the same
// task, without attempting any fuzzy/similarity matching that could
// surface a stop reason for a task the person didn't actually mean.
function normalizeTaskKey(taskInstruction) {
  return (taskInstruction || "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function getTaskStopReason(taskInstruction) {
  const key = normalizeTaskKey(taskInstruction);
  if (!key) return null;
  const result = await chrome.storage.local.get(TASK_HISTORY_STORAGE_KEY);
  const history = result[TASK_HISTORY_STORAGE_KEY] || {};
  return history[key] || null;
}

async function saveTaskStopReason(taskInstruction, reason) {
  const key = normalizeTaskKey(taskInstruction);
  if (!key || !reason) return;
  const result = await chrome.storage.local.get(TASK_HISTORY_STORAGE_KEY);
  const history = result[TASK_HISTORY_STORAGE_KEY] || {};
  history[key] = { reason, timestamp: Date.now() };
  await chrome.storage.local.set({ [TASK_HISTORY_STORAGE_KEY]: history });
}

async function clearTaskStopReason(taskInstruction) {
  const key = normalizeTaskKey(taskInstruction);
  if (!key) return;
  const result = await chrome.storage.local.get(TASK_HISTORY_STORAGE_KEY);
  const history = result[TASK_HISTORY_STORAGE_KEY] || {};
  if (key in history) {
    delete history[key];
    await chrome.storage.local.set({ [TASK_HISTORY_STORAGE_KEY]: history });
  }
}

// Small, dependency-free "X minutes/hours/days ago" formatter - avoids
// pulling in a date library for one line of UI text.
function formatRelativeTime(timestamp) {
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
}