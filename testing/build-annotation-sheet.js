// VisionGuard - annotation sheet builder
//
// Reads results.json (from run-detection-test.js) and produces a CSV
// where every candidate field - detected AND not detected - gets one
// row, with the detector's verdict shown alongside a blank column for
// YOU to fill in the true answer. This is the manual step that turns
// a raw detection count into an actual precision/recall number.
//
// Usage: node build-annotation-sheet.js
// Then open annotation.csv in Excel/Google Sheets, fill the
// "human_verdict" column with "sensitive" or "not_sensitive" for each
// row based on the label/name/placeholder shown, save as CSV, and run
// compute-metrics.js against it.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(__dirname, "results.json");
const OUTPUT_PATH = join(__dirname, "annotation.csv");

if (!existsSync(RESULTS_PATH)) {
  console.error("No results.json found - run `npm test` first.");
  process.exit(1);
}

const results = JSON.parse(readFileSync(RESULTS_PATH, "utf-8"));

function csvEscape(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Matches a candidate field to a detected field by position - the
// detector's redaction coordinates come from the same page state as
// the candidate scan, so x/y should line up exactly.
function findDetectorVerdict(candidate, detectedFields) {
  const match = detectedFields.find(
    (d) => d.x === candidate.x && d.y === candidate.y
  );
  return match ? match.category : "not_flagged";
}

const rows = [
  ["site_url", "site_category", "field_name", "field_id", "field_type",
   "placeholder", "label_text", "detector_verdict", "human_verdict"],
];

let totalCandidates = 0;

for (const site of results) {
  if (site.status !== "ok") continue;
  for (const candidate of site.allCandidateFields || []) {
    totalCandidates++;
    const verdict = findDetectorVerdict(candidate, site.detectedFields);
    rows.push([
      site.url,
      site.category,
      candidate.name,
      candidate.id,
      candidate.type,
      candidate.placeholder,
      candidate.labelText,
      verdict,
      "", // human_verdict - fill this in manually
    ]);
  }
}

const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
writeFileSync(OUTPUT_PATH, csv);

console.log(`Wrote ${totalCandidates} candidate fields to annotation.csv`);
console.log(`\nNext steps:`);
console.log(`1. Open annotation.csv in Excel or Google Sheets`);
console.log(`2. For each row, look at field_name/placeholder/label_text and decide:`);
console.log(`   is this field ACTUALLY sensitive (password/PII/payment/government ID)?`);
console.log(`3. Fill the human_verdict column with exactly "sensitive" or "not_sensitive"`);
console.log(`4. Save as CSV (keep the same filename: annotation.csv)`);
console.log(`5. Run: node compute-metrics.js`);