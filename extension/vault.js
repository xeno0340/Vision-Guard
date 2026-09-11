// VisionGuard - vault.js
//
// A local, on-device store for low-sensitivity, reusable personal info
// (name, email, phone, address) that the agent can autofill without
// asking each time. Uses chrome.storage.local - data never leaves the
// device, never syncs to any account, never transmits anywhere.
//
// Deliberately EXCLUDES password, payment, and government ID data -
// those remain human-entered only, always, with no autofill path at
// all. This mirrors the same boundary already used for CAPTCHA and
// sensitive-field handling throughout the system: the agent acts
// autonomously on low-stakes data, and defers to the human on anything
// high-stakes, rather than treating all data uniformly.

const VAULT_STORAGE_KEY = "visionguard_vault";
// NOTE (prototype stage): "password" is included here for demo/testing
// convenience at this stage of the project (internal hackathon round,
// still to be submitted as a prototype to the SIH portal - not a
// production system). This intentionally relaxes the stricter "never
// autofill passwords" boundary described elsewhere in this project's
// documentation. Before any real deployment, this should be removed
// and password fields should go back to requiring manual human entry
// every time, with no vault-based autofill path at all.
const VAULT_FIELDS = ["name", "email", "phone", "address", "password"];

async function getVault() {
  const result = await chrome.storage.local.get(VAULT_STORAGE_KEY);
  return result[VAULT_STORAGE_KEY] || {};
}

async function saveVault(vaultData) {
  const filtered = {};
  VAULT_FIELDS.forEach((field) => {
    if (vaultData[field]) filtered[field] = vaultData[field];
  });
  await chrome.storage.local.set({ [VAULT_STORAGE_KEY]: filtered });
  return filtered;
}

async function clearVault() {
  await chrome.storage.local.remove(VAULT_STORAGE_KEY);
}