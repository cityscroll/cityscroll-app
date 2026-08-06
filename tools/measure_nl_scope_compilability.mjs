#!/usr/bin/env node

// Deterministic measurement of the current NL parser's typed-scope coverage.
// This deliberately measures the committed suggestion pool because production
// search text is not retained (analytics stores only aggregate dimensions).

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUGGESTION_POOL } from "../worker/src/lib/suggestions.mjs";

const require = createRequire(import.meta.url);
const parser = require("../site/nl_parse.js");
const ROOT = dirname(fileURLToPath(import.meta.url));
const RECEIPT = join(ROOT, "..", "docs", "evidence", "nl-scope-compilability.json");
const REPORT = join(ROOT, "..", "docs", "evidence", "nl-scope-compilability.md");
const LENSES = ["money", "people", "land", "property", "rules", "meetings", "alerts"];

function normalize(text) {
  return ` ${String(text).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function words(text) {
  const stop = new Set("the a an of in on for to and or with show me find list all near over under within new nyc city our your their about that this week month what can comment open competitive exams exam guide council district community board process stage hearing hearings auction disposition forecast contracts closing".split(" "));
  return [...new Set(String(text).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word.length > 3 && !stop.has(word)))].slice(0, 4);
}

function deviceFilter(text, lens) {
  const low = normalize(text);
  if (lens === "money") return parser.parseNL(text);
  if (lens === "alerts") {
    if (/\brezon\w*\b|\bzoning\b/.test(low)) {
      const place = (text.match(/(?:near|by|around)\s+(.+)$/i) || [])[1];
      return { watchType: "rezone", place: place ? place.trim() : null };
    }
    return parser.parseNL(text);
  }
  const out = { keywords: [] };
  const boros = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];
  if (lens === "land") {
    out.boro = boros.find((b) => low.includes(` ${b.toLowerCase()} `)) || null;
    out.councilDistrict = parser.extractCouncilDistrict(low);
    out.communityDistrict = parser.communityDistrictWithBoro(low, out.boro) || parser.extractCommunityDistrict(low);
    out.nearMe = parser.extractNearMe(low);
    if (/\b(all|closed|approved|completed)\b/.test(low) && /\b(status|including|incl)\b/.test(low)) out.status = "all";
  } else if (lens === "people") {
    if (parser.extractStaffingGuide(low)) return { keywords: [], view: "guide", lookupType: "role" };
    const personish = /\b(person|people|someone|somebody|individual|named|name of|mr|ms|mrs)\b/.test(low);
    const roleish = /\b(role|roles|title|titles|position|job|jobs)\b/.test(low);
    if (personish && !roleish) { out.lookupType = "person"; return { ...out, keywords: [text.match(/(?:named|name of)\s+([A-Za-z][A-Za-z'’.-]+)/i)?.[1] || "person"] }; }
    out.lookupType = "role";
  } else if (lens === "rules") {
    out.process = parser.extractRulesProcess(low);
    out.agency = parser.extractAgency(low);
  } else if (lens === "property") {
    out.process = parser.extractPropertyProcess(low);
    out.agency = parser.extractAgency(low);
    out.nearMe = parser.extractNearMe(low);
    out.borough = boros.find((b) => low.includes(` ${b.toLowerCase()} `)) || null;
  } else if (lens === "meetings") {
    out.when = parser.extractMeetingWhen(low);
    out.process = parser.extractMeetingsProcess(low);
    out.nearMe = parser.extractNearMe(low);
    out.agency = parser.extractAgency(low);
    out.borough = boros.find((b) => low.includes(` ${b.toLowerCase()} `)) || null;
    if (/\bcomment on\b|\btestify\b|\battend\b/.test(low) && !out.when) out.when = "week";
  }
  out.keywords = words(text);
  if (lens === "land" && out.boro) {
    const boroWords = new Set(out.boro.toLowerCase().split(/\s+/));
    out.keywords = out.keywords.filter((word) => !boroWords.has(word));
  }
  if (out.councilDistrict) out.keywords = out.keywords.filter((word) => word !== out.councilDistrict && word !== "district" && word !== "council");
  if (out.process) out.keywords = out.keywords.filter((word) => !["public", "process", "comment", "hearing", "hearings", "auction", "proposal", "adoption", "effective", "scheduled", "agenda", "outcomes"].includes(word));
  return out;
}

function typedFields(filter) {
  return Object.entries(filter).filter(([key, value]) => key !== "keywords" && value !== null && value !== false && value !== "" && (!Array.isArray(value) || value.length)).map(([key]) => key);
}

function residualTypes(lens, text, filter) {
  if (!Array.isArray(filter.keywords) || !filter.keywords.length) return [];
  const low = text.toLowerCase();
  if (lens === "people" && filter.lookupType === "person") return ["person"];
  if (lens === "land" && /\d/.test(text)) return ["parcel_or_neighborhood"];
  if (lens === "land") return ["land_project_topic"];
  if (lens === "property") return ["property_asset_or_topic"];
  if (lens === "rules") return ["rule_topic"];
  if (lens === "meetings") return [/(landmark|council|community board|taxi)/.test(low) ? "meeting_subject" : "meeting_topic"];
  return ["procurement_topic"];
}

function classify(lens, text, filter) {
  const residual = Array.isArray(filter.keywords) ? filter.keywords : [];
  const typed = typedFields(filter);
  const classification = residual.length ? (typed.length ? "partially-compilable" : "free-text-only") : (typed.length ? "fully-compilable" : "free-text-only");
  return { lens, text, filter, typed_fields: typed, residual_keywords: residual, residual_entity_types: residualTypes(lens, text, filter), classification };
}

function fraction(count, total) { return total ? Number((count / total).toFixed(4)) : 0; }

function buildReceipt() {
  const rows = SUGGESTION_POOL.filter(({ lens }) => LENSES.includes(lens)).map(({ lens, text, idx }) => ({ idx, ...classify(lens, text, deviceFilter(text, lens)) }));
  const byLens = Object.fromEntries(LENSES.map((lens) => {
    const subset = rows.filter((row) => row.lens === lens);
    const counts = Object.fromEntries(["fully-compilable", "partially-compilable", "free-text-only"].map((kind) => [kind, subset.filter((row) => row.classification === kind).length]));
    const residuals = [...new Set(subset.flatMap((row) => row.residual_entity_types))].sort();
    return [lens, { queries: subset.length, counts, fractions: Object.fromEntries(Object.entries(counts).map(([kind, count]) => [kind, fraction(count, subset.length)])), residual_entity_types: residuals }];
  }));
  const closest = [...LENSES].sort((a, b) => byLens[b].fractions["fully-compilable"] - byLens[a].fractions["fully-compilable"] || byLens[a].fractions["free-text-only"] - byLens[b].fractions["free-text-only"]);
  return {
    schema_version: 1,
    title: "NL-to-scope compilability measurement",
    corpus: { kind: "synthetic", query_count: rows.length, source: "worker/src/lib/suggestions.mjs:SUGGESTION_POOL", rationale: "Production search text is not retained; analytics records aggregate lens/detail/area dimensions only." },
    definition: { pure_scope: "At least one typed non-keyword field and no keyword residue", partially_compilable: "At least one typed field plus keyword residue", free_text_only: "No typed field, or keywords are the only narrowing signal" },
    parser: { implementation: "site/app/search-share.mjs:deviceParse plus site/nl_parse.js:parseNL", measured_mode: "offline device parser", date_independent: true },
    by_lens: byLens,
    closest_to_keyword_retirement: closest,
    rows,
  };
}

function markdown(receipt) {
  const lines = ["# NL-to-scope compilability", "", "This is a deterministic synthetic measurement of the offline parser. Production query text is not retained: first-party analytics stores aggregate dimensions, not search text. The corpus is the committed suggestion pool, which exercises the parser's forced-field schemas across the seven supported lenses.", "", "Fractions are measured over the query count shown; `fully-compilable` means at least one typed field and no free-text keyword residue.", "", "| Lens | Queries | Fully | Partial | Free-text only | Residual entity types |", "| --- | ---: | ---: | ---: | ---: | --- |"];
  for (const lens of LENSES) { const x = receipt.by_lens[lens]; lines.push(`| ${lens} | ${x.queries} | ${x.fractions["fully-compilable"]} | ${x.fractions["partially-compilable"]} | ${x.fractions["free-text-only"]} | ${x.residual_entity_types.join(", ") || "—"} |`); }
  lines.push("", `Closest to keyword retirement in this corpus: **${receipt.closest_to_keyword_retirement.join(", ")}**. This is a readiness signal, not a product decision; the corpus is synthetic and small.`, "", "Run `node tools/measure_nl_scope_compilability.mjs` to regenerate the JSON receipt and this report, or add `--check` to verify both committed artifacts.", "");
  return lines.join("\n");
}

const receipt = buildReceipt();
const output = JSON.stringify(receipt, null, 2) + "\n";
const report = markdown(receipt);
if (process.argv.includes("--check")) {
  assert.equal(readFileSync(RECEIPT, "utf8"), output, "NL scope receipt is stale; regenerate it");
  assert.equal(readFileSync(REPORT, "utf8"), report, "NL scope report is stale; regenerate it");
} else {
  writeFileSync(RECEIPT, output);
  writeFileSync(REPORT, report);
}
console.log(`NL scope compilability: ${receipt.corpus.query_count} synthetic queries; ${receipt.closest_to_keyword_retirement.join(", ")} lead on fully-compilable share.`);
