#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { materializeEDesignationDigest } from "../warehouse/lib/e_designation_digest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(path.join(ROOT, p), "utf8"));
const stable = (v) => `${JSON.stringify(v, null, 2)}\n`;
const check = process.argv.includes("--check");
const source = read("warehouse/fixtures/e-designations/source.v1.json");
const projectsDoc = read("site/data/zap_projects_warehouse_lookup.json");
const lotsDoc = read("site/data/zap_bbl_warehouse_lookup.json");
const generatedAt = "2026-08-31T00:00:00.000Z";
const built = materializeEDesignationDigest({ projects: projectsDoc.rows, projectLots: lotsDoc.rows, sourceRows: source.rows, sourceVintage: source.source_vintage, generatedAt });
const outputs = [["site/data/e_designation_project_digest.json", built.payload], ["warehouse/receipts/proof/e_designation_project_digest_latest.json", built.receipt]];

if (check) {
  for (const [relative, value] of outputs) {
    if (readFileSync(path.join(ROOT, relative), "utf8") !== stable(value)) throw new Error(`${relative} drifted`);
  }
}
if (!check) {
  writeFileSync(path.join(ROOT, outputs[0][0]), stable(outputs[0][1]));
  writeFileSync(path.join(ROOT, outputs[1][0]), stable(outputs[1][1]));
}
console.log(`${check ? "checked" : "wrote"} E-Designation digest: ${built.receipt.counts.projects_with_conditions} projects, ${built.receipt.counts.conditions} conditions`);
