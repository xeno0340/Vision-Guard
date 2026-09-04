// VisionGuard - precision/recall calculator
//
// Reads your manually-annotated annotation.csv and computes real
// precision, recall, and F1 - the numbers actually worth citing in a
// feasibility slide, since they're checked against human-verified
// ground truth rather than just "the detector flagged N things."
//
// Usage: node compute-metrics.js (after filling in human_verdict column)

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ANNOTATION_PATH = join(__dirname, "annotation.csv");

if (!existsSync(ANNOTATION_PATH)) {
  console.error("No annotation.csv found - run build-annotation-sheet.js first.");
  process.exit(1);
}

// Minimal CSV parser - handles quoted fields with embedded commas, which
// npm's csv-parse would also do, but this avoids an extra dependency for
// a script this small.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") { field += c; }
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const raw = readFileSync(ANNOTATION_PATH, "utf-8");
const parsed = parseCsv(raw);
const header = parsed[0];
const rows = parsed.slice(1).filter((r) => r.length === header.length && r.some((c) => c));

const verdictCol = header.indexOf("human_verdict");
const detectorCol = header.indexOf("detector_verdict");

if (verdictCol === -1 || detectorCol === -1) {
  console.error("annotation.csv is missing expected columns - was it edited correctly?");
  process.exit(1);
}

let truePositive = 0, falsePositive = 0, falseNegative = 0, trueNegative = 0;
let unannotated = 0;

for (const row of rows) {
  const humanVerdict = (row[verdictCol] || "").trim().toLowerCase();
  const detectorFlagged = row[detectorCol] !== "not_flagged";

  if (!humanVerdict) { unannotated++; continue; }

  const humanSaysSensitive = humanVerdict === "sensitive";

  if (detectorFlagged && humanSaysSensitive) truePositive++;
  else if (detectorFlagged && !humanSaysSensitive) falsePositive++;
  else if (!detectorFlagged && humanSaysSensitive) falseNegative++;
  else trueNegative++;
}

const precision = truePositive + falsePositive > 0 ? truePositive / (truePositive + falsePositive) : null;
const recall = truePositive + falseNegative > 0 ? truePositive / (truePositive + falseNegative) : null;
const f1 = precision !== null && recall !== null && (precision + recall) > 0
  ? (2 * precision * recall) / (precision + recall)
  : null;

console.log("VisionGuard detection - ground-truth metrics\n");
console.log(`Annotated rows: ${rows.length - unannotated} / ${rows.length}`);
if (unannotated > 0) {
  console.log(`WARNING: ${unannotated} rows still have an empty human_verdict - fill these in for a complete result.\n`);
}

console.log(`True positives:  ${truePositive}  (correctly flagged as sensitive)`);
console.log(`False positives: ${falsePositive}  (flagged, but human says not sensitive)`);
console.log(`False negatives: ${falseNegative}  (missed, but human says it IS sensitive)`);
console.log(`True negatives:  ${trueNegative}  (correctly left unflagged)`);

console.log(`\nPrecision: ${precision !== null ? (precision * 100).toFixed(1) + "%" : "N/A (no positive detections)"}`);
console.log(`Recall:    ${recall !== null ? (recall * 100).toFixed(1) + "%" : "N/A (no sensitive fields in ground truth)"}`);
console.log(`F1 score:  ${f1 !== null ? f1.toFixed(3) : "N/A"}`);

if (falsePositive > 0) {
  console.log(`\nFalse positive rows (review these - overly broad patterns):`);
  rows.forEach((row) => {
    const humanVerdict = (row[verdictCol] || "").trim().toLowerCase();
    const detectorFlagged = row[detectorCol] !== "not_flagged";
    if (detectorFlagged && humanVerdict === "not_sensitive") {
      console.log(`  - ${row[header.indexOf("site_url")]} | name="${row[header.indexOf("field_name")]}" label="${row[header.indexOf("label_text")]}" -> flagged as ${row[detectorCol]}`);
    }
  });
}