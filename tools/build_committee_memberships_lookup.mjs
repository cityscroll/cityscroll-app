#!/usr/bin/env node
/** Build the exact member_id join slice from the warehouse CSV. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommitteeMembershipLookup } from "../site/committee_memberships_build.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = path.join(ROOT, "warehouse/raw/city-council-committee-membership/rows.csv");
const PEOPLE = path.join(ROOT, "site/data/people_domain_observations.json");
const OUTS = [
  path.join(ROOT, "site/data/official_committee_memberships_lookup.json"),
  path.join(ROOT, "worker/src/data/official_committee_memberships_lookup.json"),
];

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const parse = (line) => {
    const out = []; let field = ""; let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (c === '"' && line[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = !quoted;
      else if (c === "," && !quoted) { out.push(field); field = ""; }
      else field += c;
    }
    out.push(field); return out;
  };
  const headers = parse(lines.shift()).map((v) => v.trim());
  return lines.map((line) => Object.fromEntries(parse(line).map((v, i) => [headers[i], v])));
}

function main() {
  const check = process.argv.includes("--check");
  if (!existsSync(RAW)) throw new Error(`missing warehouse CSV: ${RAW}`);
  const source = JSON.parse(readFileSync(PEOPLE, "utf8"));
  const doc = buildCommitteeMembershipLookup(parseCsv(readFileSync(RAW, "utf8")), source);
  if (check) {
    const existing = JSON.parse(readFileSync(OUTS[0], "utf8"));
    const stable = (value) => { const { generated_at, ...rest } = value; return JSON.stringify(rest); };
    if (stable(existing) !== stable(doc)) throw new Error("committee membership lookup drift — rebuild");
    console.log(`committee memberships ok rows=${doc.linked_row_count} people=${doc.linked_person_count}`); return;
  }
  for (const out of OUTS) { mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`); }
  console.log(`wrote committee membership lookup rows=${doc.linked_row_count} people=${doc.linked_person_count}`);
}
main();
