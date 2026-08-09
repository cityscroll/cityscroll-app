#!/usr/bin/env node
/**
 * Materialize public mandate backlinks keyed by City Record notice id.
 *
 * Usage:
 *   node tools/build_notice_mandate_backlinks.mjs
 *   node tools/build_notice_mandate_backlinks.mjs --check
 *
 * Writes site/data/notice_mandate_backlinks_lookup.json (public tiers only).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { NOTICE_MANDATE_BACKLINKS_SCHEMA } from "../site/notice_mandate_backlinks.mjs";
import { buildNoticeMandateBacklinksLookup } from "./lib/notice_mandate_backlinks_index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUTPUT = join(ROOT, "site/data/notice_mandate_backlinks_lookup.json");

const INPUTS = Object.freeze({
  obligations: "site/data/agency_obligations_lookup.json",
  intelligence: "site/data/entity_intelligence_lookup.json",
  meetings: "site/data/meetings_domain_observations.json",
  rules: "site/data/rules_domain_observations.json",
  processConformance: "site/data/process_conformance_lookup.json",
  land: "site/data/zap_projects_warehouse_lookup.json",
  gate: "site/data/cross_spine_edge_gate.json",
});

const readJson = (relative) => JSON.parse(readFileSync(join(ROOT, relative), "utf8"));

function loadSources() {
  const sources = {};
  for (const [key, relative] of Object.entries(INPUTS)) {
    if (!existsSync(join(ROOT, relative))) {
      throw new Error(`missing input ${relative}`);
    }
    sources[key] = readJson(relative);
  }
  return {
    obligationsLookup: sources.obligations,
    intelligence: sources.intelligence,
    meetingsDomain: sources.meetings,
    rulesDomain: sources.rules,
    processConformance: sources.processConformance,
    landProjects: sources.land,
    crossSpineGate: sources.gate,
    generatedAt: new Date().toISOString(),
  };
}

export function buildAndWrite({ check = false } = {}) {
  const lookup = buildNoticeMandateBacklinksLookup(loadSources());
  if (lookup.schema !== NOTICE_MANDATE_BACKLINKS_SCHEMA) {
    throw new Error(`unexpected schema ${lookup.schema}`);
  }
  // Guard: no evidence_only / no_edge tiers; no graph subject_ref / evidence bags.
  // Bare mandate_id is a product filter key for one-duty Following watches — allowed.
  for (const [noticeId, rows] of Object.entries(lookup.by_notice || {})) {
    for (const row of rows) {
      const tier = String(row.publication_tier || "");
      if (tier === "evidence_only" || tier === "no_edge") {
        throw new Error(`non-public tier leaked for notice ${noticeId}: ${tier}`);
      }
      if (row.subject_ref || row.evidence || row.source_system || row.watch_href) {
        throw new Error(`machine identity leaked for notice ${noticeId}`);
      }
      if (row.mandate_id && (String(row.mandate_id).includes(":") || /\s/.test(String(row.mandate_id)))) {
        throw new Error(`non-canonical mandate_id for notice ${noticeId}: ${row.mandate_id}`);
      }
    }
  }
  const body = `${JSON.stringify(lookup, null, 2)}\n`;
  if (check) {
    if (!existsSync(OUTPUT)) {
      throw new Error("notice_mandate_backlinks_lookup.json missing — run build without --check");
    }
    const existing = readFileSync(OUTPUT, "utf8");
    const existingDoc = JSON.parse(existing);
    if (existingDoc.schema !== NOTICE_MANDATE_BACKLINKS_SCHEMA) {
      throw new Error("committed lookup has unexpected schema");
    }
    // Counts may drift with source refreshes; schema + public-only invariant is the gate.
    for (const [noticeId, rows] of Object.entries(existingDoc.by_notice || {})) {
      for (const row of rows) {
        if (row.publication_tier === "evidence_only" || row.publication_tier === "no_edge") {
          throw new Error(`committed lookup has non-public tier for ${noticeId}`);
        }
      }
    }
    console.log(
      `ok site/data/notice_mandate_backlinks_lookup.json notices=${existingDoc.counts?.notices ?? 0} edges=${existingDoc.counts?.edges ?? 0}`,
    );
    return existingDoc;
  }
  writeFileSync(OUTPUT, body, "utf8");
  console.log(
    `wrote site/data/notice_mandate_backlinks_lookup.json notices=${lookup.counts.notices} edges=${lookup.counts.edges}`,
  );
  return lookup;
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  buildAndWrite({ check });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("build_notice_mandate_backlinks.mjs")) {
  main();
}
