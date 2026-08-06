#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDistrictDigestView, buildMonitorPackView, districtDigestPath, monitorPackPath, renderComposedObjectDocument } from "../site/composed_object_documents.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const registry = JSON.parse(readFileSync(join(SITE, "data/watch_templates.json"), "utf8"));
const digests = JSON.parse(readFileSync(join(SITE, "data/district_weekly_digests.json"), "utf8"));

export function composedObjectDocumentOutputs() {
  const outputs = [];
  for (const template of registry.templates || []) {
    const view = buildMonitorPackView(registry, template.id);
    outputs.push([join(SITE, monitorPackPath(template.id), "index.html"), renderComposedObjectDocument(view)]);
  }
  for (let district = 1; district <= 51; district += 1) {
    const view = buildDistrictDigestView(digests, String(district));
    outputs.push([join(SITE, districtDigestPath(district), "index.html"), renderComposedObjectDocument(view)]);
  }
  return outputs;
}

const check = process.argv.includes("--check");
let stale = 0;
for (const [path, content] of composedObjectDocumentOutputs()) {
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
    stale += 1;
    if (!check) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
  }
}
if (check && stale) { console.error(`${stale} composed object document artifact(s) are stale`); process.exit(1); }
console.log(`${check ? "Composed object documents are current" : "Composed object documents built"} (${composedObjectDocumentOutputs().length})`);
