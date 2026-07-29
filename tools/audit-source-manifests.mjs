import assert from "node:assert/strict";
import { readJson } from "./lib/wave4-build.mjs";
import { inspectDocument, sourceEligibility } from "../worker/src/source_vault.mjs";

if (!process.argv.includes("--fixtures")) throw new Error("use --fixtures for the bounded source policy audit");
const fixtures = readJson("data/wave4/source-vault-fixtures.json");
for (const fixture of fixtures.cases) {
  const eligibility = sourceEligibility(fixture.url);
  if (fixture.expected === "eligible") assert.equal(eligibility.eligible, true, fixture.id);
  else assert.equal(eligibility.eligible, false, fixture.id);
}
const pdf = new TextEncoder().encode("%PDF-1.7\nreference");
assert.equal(inspectDocument(pdf.buffer, "application/pdf").accepted, true);
assert.equal(inspectDocument(new TextEncoder().encode("MZ executable").buffer, "application/octet-stream").accepted, false);
assert.equal(inspectDocument(new TextEncoder().encode("EICAR-STANDARD-ANTIVIRUS-TEST-FILE").buffer, "text/plain").accepted, false);
console.log(`audited ${fixtures.cases.length} source eligibility fixtures`);
