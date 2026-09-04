// VisionGuard - detection test harness (v3)
//
// v3 changes for scaling to ~70+ real sites:
// - Checkpointing: results are written to disk after EVERY site, not just
//   at the end. A crash or Ctrl+C partway through loses nothing except
//   the site in progress. Re-running skips URLs already completed.
// - Politeness delay between sites - reduces the chance of automated
//   traffic getting flagged, and is generally the respectful way to
//   run any kind of automated multi-site testing.
// - Captures metadata for EVERY filled field (name, id, label, type),
//   not just the ones the detector flagged - this is what the
//   annotation step (build-annotation-sheet.js) needs to compute real
//   precision/recall, since you need to know what the detector DIDN'T
//   flag too, not just what it did.

import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sites = JSON.parse(readFileSync(join(__dirname, "site-list.json"), "utf-8"));

const detectorSource = readFileSync(
  join(__dirname, "..", "extension", "dom-detector.js"),
  "utf-8"
);

const RESULTS_PATH = join(__dirname, "results.json");
const DEBUG_DIR = join(__dirname, "debug-screenshots");
if (!existsSync(DEBUG_DIR)) mkdirSync(DEBUG_DIR);

const POLITENESS_DELAY_MS = 1500;

const DUMMY_VALUES = {
  password: "TestPass123!",
  email: "test@example.com",
  text: "Test Value",
  tel: "5551234567",
  number: "1234",
};

const CONSENT_BUTTON_TEXTS = [
  "Accept all", "Accept All", "Accept", "I Accept", "Allow all",
  "Allow All", "Agree", "I Agree", "OK", "Got it", "Continue",
];

function loadExistingResults() {
  if (!existsSync(RESULTS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(RESULTS_PATH, "utf-8"));
  } catch {
    return []; // corrupted/partial file from an interrupted run - start fresh
  }
}

function saveResults(results) {
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
}

async function dismissConsentBanner(page) {
  for (const text of CONSENT_BUTTON_TEXTS) {
    try {
      const button = page.getByRole("button", { name: text, exact: false });
      if (await button.first().isVisible({ timeout: 800 })) {
        await button.first().click({ timeout: 800 });
        await page.waitForTimeout(300);
        return true;
      }
    } catch {}
  }
  return false;
}

async function fillAllFields(page) {
  const inputs = await page.locator("input, textarea").all();
  let filledCount = 0;

  for (const input of inputs) {
    try {
      const type = (await input.getAttribute("type")) || "text";
      const isVisible = await input.isVisible();
      if (!isVisible) continue;
      if (["submit", "button", "hidden", "file", "image", "reset"].includes(type)) continue;

      if (type === "checkbox" || type === "radio") {
        await input.check({ force: true, timeout: 2000 }).catch(() => {});
      } else {
        const value = DUMMY_VALUES[type] || DUMMY_VALUES.text;
        await input.fill(value, { timeout: 2000 }).catch(() => {});
      }
      filledCount++;
    } catch {}
  }
  return filledCount;
}

// Collects metadata for EVERY filled field - this is the full candidate
// set the annotation step needs, independent of what the detector chose.
function collectAllCandidateFields() {
  const results = [];
  document.querySelectorAll("input, textarea").forEach((el, idx) => {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (["submit", "button", "hidden", "file", "image", "reset"].includes(type)) return;

    const hasContent = type === "checkbox" || type === "radio" ? el.checked : (el.value || "").trim().length > 0;
    if (!hasContent) return;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    let labelText = "";
    if (el.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel) labelText = forLabel.textContent.trim();
    }
    if (!labelText) {
      const wrappingLabel = el.closest("label");
      if (wrappingLabel) labelText = wrappingLabel.textContent.trim();
    }

    results.push({
      candidateIndex: idx,
      type,
      name: el.getAttribute("name") || "",
      id: el.getAttribute("id") || "",
      placeholder: el.getAttribute("placeholder") || "",
      labelText,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  });
  return results;
}

async function testSite(browser, site, index) {
  const page = await browser.newPage();
  const result = {
    url: site.url,
    category: site.category || "uncategorized",
    note: site.note,
    status: "ok",
    pageTitle: null,
    finalUrl: null,
    consentDismissed: false,
    totalCandidateFields: 0,
    fieldsFilled: 0,
    allCandidateFields: [],
    detectedFields: [],
    error: null,
    debugScreenshot: null,
  };

  try {
    await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1000);

    result.consentDismissed = await dismissConsentBanner(page);
    if (result.consentDismissed) await page.waitForTimeout(500);

    result.pageTitle = await page.title();
    result.finalUrl = page.url();
    result.totalCandidateFields = await page.locator("input, textarea").count();
    result.fieldsFilled = await fillAllFields(page);

    result.allCandidateFields = await page.evaluate(collectAllCandidateFields);

    const detection = await page.evaluate((src) => {
      eval(src);
      return detectSensitiveFields();
    }, detectorSource);
    result.detectedFields = detection.fields;

    if (result.totalCandidateFields === 0) {
      const screenshotPath = join(DEBUG_DIR, `site-${index}-empty.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
      result.debugScreenshot = screenshotPath;
    }
  } catch (err) {
    result.status = "error";
    result.error = err.message;
  } finally {
    await page.close();
  }

  return result;
}

async function main() {
  const existingResults = loadExistingResults();
  const alreadyTested = new Set(existingResults.map((r) => r.url));
  const remaining = sites.filter((s) => !alreadyTested.has(s.url));

  console.log(`VisionGuard detection test - ${sites.length} sites total`);
  console.log(`Already completed: ${existingResults.length}, remaining: ${remaining.length}\n`);

  if (remaining.length === 0) {
    console.log("All sites already tested. Delete testing/results.json to start a fresh run.");
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const results = [...existingResults];

  for (let i = 0; i < remaining.length; i++) {
    const site = remaining[i];
    const globalIndex = sites.findIndex((s) => s.url === site.url);
    process.stdout.write(`[${results.length + 1}/${sites.length}] ${site.url} ... `);

    const result = await testSite(browser, site, globalIndex);
    results.push(result);
    saveResults(results); // checkpoint after every site

    if (result.status === "error") {
      console.log(`ERROR: ${result.error}`);
    } else if (result.totalCandidateFields === 0) {
      console.log(`0 fields (title: "${result.pageTitle}")`);
    } else {
      const categoryCounts = {};
      result.detectedFields.forEach((f) => {
        categoryCounts[f.category] = (categoryCounts[f.category] || 0) + 1;
      });
      console.log(
        `${result.fieldsFilled}/${result.totalCandidateFields} filled, ` +
        `${result.detectedFields.length} flagged (${JSON.stringify(categoryCounts)})`
      );
    }

    if (i < remaining.length - 1) {
      await new Promise((r) => setTimeout(r, POLITENESS_DELAY_MS));
    }
  }

  await browser.close();

  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));

  const successful = results.filter((r) => r.status === "ok");
  const totalCandidates = successful.reduce((sum, r) => sum + r.fieldsFilled, 0);
  const totalDetected = successful.reduce((sum, r) => sum + r.detectedFields.length, 0);

  console.log(`Sites tested: ${results.length} (${successful.length} succeeded, ${results.length - successful.length} errored)`);
  console.log(`Total filled fields: ${totalCandidates}`);
  console.log(`Total flagged as sensitive: ${totalDetected}`);
  console.log(`Raw flag rate: ${totalCandidates > 0 ? ((totalDetected / totalCandidates) * 100).toFixed(1) : 0}%`);
  console.log(`\nThis is NOT precision/recall - run build-annotation-sheet.js next`);
  console.log(`for a ground-truth-based accuracy measurement.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  console.error("Progress so far is saved in results.json - re-run to resume.");
  process.exit(1);
});