#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "site", "data");
const OUTPUT = path.join(DATA, "money_resident_snapshot.json");

async function json(name) {
  return JSON.parse(await readFile(path.join(DATA, name), "utf8"));
}

export function buildMoneyResidentSnapshot({ defaultOpen, domain, awards }) {
  const awardById = new Map((awards?.rows || []).map((row) => [String(row.request_id || ""), row]));
  const openById = new Map((defaultOpen?.notices || []).map((row) => [String(row.request_id || ""), row]));
  const byId = new Map();
  for (const observed of domain?.rows || []) {
    const id = String(observed.request_id || "");
    if (!id) continue;
    byId.set(id, {
      ...(awardById.get(id) || {}),
      ...(openById.get(id) || {}),
      ...observed,
    });
  }
  for (const [id, row] of openById) {
    if (!byId.has(id)) byId.set(id, row);
  }
  const rows = [...byId.values()].sort((left, right) =>
    String(right.start_date || "").localeCompare(String(left.start_date || "")) ||
    String(left.request_id || "").localeCompare(String(right.request_id || ""))
  );
  const generatedAt = [defaultOpen?.generated_at, domain?.retrieved_at, awards?.materialized_at]
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  return {
    schema_version: 1,
    delivery_tier: "resident-snapshot",
    generated_at: generatedAt,
    source_vintages: {
      default_open: defaultOpen?.generated_at || null,
      domain_observations: domain?.retrieved_at || null,
      award_warehouse: awards?.materialized_at || null,
    },
    count: rows.length,
    rows,
  };
}

async function main() {
  const [defaultOpen, domain, awards] = await Promise.all([
    json("money_default_open.json"),
    json("money_domain_observations.json"),
    json("ocp_awards_warehouse_lookup.json"),
  ]);
  const rendered = `${JSON.stringify(buildMoneyResidentSnapshot({ defaultOpen, domain, awards }), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    assert.equal(await readFile(OUTPUT, "utf8").catch(() => null), rendered,
      "site/data/money_resident_snapshot.json is stale; rebuild with node tools/build_money_resident_snapshot.mjs");
  } else {
    await writeFile(OUTPUT, rendered);
    process.stdout.write(`wrote ${path.relative(ROOT, OUTPUT)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
