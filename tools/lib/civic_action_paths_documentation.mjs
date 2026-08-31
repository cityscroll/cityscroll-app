/**
 * Civic Action Path documentation and visual-evidence receipt.
 *
 * This is a fail-closed proof that the architecture document, before/after
 * captures, fixtures, tests, and implementation pointers stay joined. It does
 * not invent a parallel Action Path contract.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stableStringify } from "../../ontology/action_path_coverage.mjs";
import { EXACT_REPLAY_FAMILY } from "./action_path_generalization_audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const DOCUMENTATION_SCHEMA = "cityscroll.civic_action_paths_documentation.v1";
export const DOCUMENTATION_METHOD = "civic_action_paths_documentation_v1";
export const DOCUMENTATION_JSON = "docs/evidence/civic-action-paths/documentation-receipt.json";
export const DOCUMENTATION_MD = "docs/evidence/civic-action-paths/documentation-receipt.md";
export const DOCUMENTATION_DOC = "docs/civic-action-paths.md";
export const BEFORE_MANIFEST = "docs/evidence/civic-action-paths/before/capture-manifest.json";
export const AFTER_MANIFEST = "docs/evidence/civic-action-paths/after/capture-manifest.json";
export const WAYS_CAPTURE = "docs/evidence/civic-action-paths/after/ways-to-participate-capture.json";

export const VIEWPORTS = Object.freeze([
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]);

const EVIDENCE_OBJECT_URL = /^backstage:\/\/cityscroll-evidence\/objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.webp$/;
const FORBIDDEN = /because you commented|your comment caused|follow all DOT rules|follow all DOT hearings|cross-board policy|citywide board default|button density/i;

export const REQUIRED_HEADINGS = Object.freeze([
  "Action Path v0 contract",
  "Continuation safety",
  "Council hearing continuation",
  "DOT City-Owned Bicycle Racks",
  "Community Board evidence policy",
  "Domain coverage",
  "Remaining gaps",
  "Future adapter guidance",
  "Visual evidence",
  "Verification",
]);

export const REQUIRED_PHRASES = Object.freeze([
  "derived product projection",
  "not a universal graph noun",
  "rules.request_ids",
  "source_does_not_establish",
  "cross_board_inference",
  "Follow what happens next",
  "never attributes adoption or effectiveness to a resident comment",
  "unknown never becomes zero",
  "no_action",
  "stale_opportunity",
  "rulemaking:dot:bicycle-owned-racks",
  "20260317026",
  "20260706041",
  "August 13, 2026",
  "matter:79200",
]);

export const REQUIRED_BEFORE_FIXTURES = Object.freeze([
  "strict_matter_join",
  "multi_matter_join",
  "no_matter_join",
  "cb_source_backed",
  "cb_unknown",
  "dot_bicycle_racks_rulemaking",
]);

export const REQUIRED_AFTER_FIXTURES = Object.freeze([
  "strict_matter_join",
  "unmatched_hearing",
  "cb_source_backed",
  "cb_unknown",
  "dot_t2_adoption",
  "dot_t3_effective",
]);

export const IMPLEMENTATION_REFS = Object.freeze([
  "site/action_path_v0.mjs",
  "site/action_registry.js",
  "site/council_hearing_matter_continuation.mjs",
  "site/council_hearing_action_path.mjs",
  "site/civic_outcome_transition.mjs",
  "site/community_board_participation.mjs",
  "worker/src/lib/continuation_replay.mjs",
  "ontology/action_path_coverage.mjs",
  "tools/lib/action_path_generalization_audit.mjs",
]);

export const PROOF_TESTS = Object.freeze([
  "test/action_path_v0.test.mjs",
  "test/action_path_coverage.test.mjs",
  "test/action_path_generalization_audit.test.mjs",
  "test/council_hearing_matter_continuation.test.mjs",
  "test/civic_outcome_transition.test.mjs",
  "test/community_board_participation.test.mjs",
  "test/civic_action_paths_documentation.test.mjs",
  "worker/test/continuation_replay.test.mjs",
]);

export const FIXTURES = Object.freeze([
  "test/fixtures/action_path_v0.json",
  "ontology/fixtures/dimensions/action_path_coverage.json",
  "site/data/meeting_outcomes_snapshot.json",
  "site/data/community_board_participation.json",
  "site/data/rules_domain_observations.json",
]);

function readText(root, rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

function readJson(root, rel) {
  return JSON.parse(readText(root, rel));
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    value.forEach(freezeDeep);
    return Object.freeze(value);
  }
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function captureKey(row) {
  return `${row.fixture}::${row.viewport}`;
}

function viewportNames(captures, fixture) {
  return new Set((captures || []).filter((row) => row.fixture === fixture).map((row) => row.viewport));
}

function missingViewportPairs(captures, fixtures) {
  const missing = [];
  for (const fixture of fixtures) {
    const seen = viewportNames(captures, fixture);
    for (const viewport of VIEWPORTS) {
      if (!seen.has(viewport.name)) missing.push(`${fixture}/${viewport.name}`);
    }
  }
  return missing;
}

export function documentationFindings(root = ROOT) {
  const findings = [];
  const doc = existsSync(path.join(root, DOCUMENTATION_DOC)) ? readText(root, DOCUMENTATION_DOC) : "";
  if (!doc) findings.push({ message: "docs/civic-action-paths.md is missing" });
  for (const heading of REQUIRED_HEADINGS) {
    if (!doc.includes(`## ${heading}`)) {
      findings.push({ message: `documentation missing heading: ${heading}` });
    }
  }
  for (const phrase of REQUIRED_PHRASES) {
    if (!doc.toLowerCase().includes(phrase.toLowerCase())) {
      findings.push({ message: `documentation missing required phrase: ${phrase}` });
    }
  }
  if (FORBIDDEN.test(doc)) {
    findings.push({ message: "documentation contains a forbidden causal, fallback, or cross-board claim" });
  }

  for (const rel of [...IMPLEMENTATION_REFS, ...PROOF_TESTS, ...FIXTURES, BEFORE_MANIFEST, AFTER_MANIFEST, WAYS_CAPTURE]) {
    if (!existsSync(path.join(root, rel))) {
      findings.push({ message: `missing linked file: ${rel}` });
    }
  }

  const before = existsSync(path.join(root, BEFORE_MANIFEST)) ? readJson(root, BEFORE_MANIFEST) : { captures: [] };
  const after = existsSync(path.join(root, AFTER_MANIFEST)) ? readJson(root, AFTER_MANIFEST) : { captures: [] };
  for (const missing of missingViewportPairs(before.captures, REQUIRED_BEFORE_FIXTURES)) {
    findings.push({ message: `before capture missing ${missing}` });
  }
  for (const missing of missingViewportPairs(after.captures, REQUIRED_AFTER_FIXTURES)) {
    findings.push({ message: `after capture missing ${missing}` });
  }

  for (const row of after.captures || []) {
    const file = String(row.file || "");
    if (file.startsWith("backstage://") && !EVIDENCE_OBJECT_URL.test(file)) {
      findings.push({ message: `after capture is not an evidence object: ${file}` });
    }
    const text = JSON.stringify(row.observations || {});
    if (FORBIDDEN.test(text)) {
      findings.push({ message: `after capture ${captureKey(row)} contains a forbidden claim` });
    }
  }

  const strict = (after.captures || []).find((row) => row.fixture === "strict_matter_join" && row.viewport === "desktop");
  if (strict && strict.observations?.follow_cta !== true) {
    findings.push({ message: "strict hearing after-state must show Follow what happens next" });
  }
  if (strict && strict.observations?.calendar_creates_watch === true) {
    findings.push({ message: "calendar click must remain distinct from Following" });
  }
  const unmatched = (after.captures || []).find((row) => row.fixture === "unmatched_hearing");
  if (unmatched && unmatched.observations?.follow_cta === true) {
    findings.push({ message: "unmatched hearing must not show a matter continuation" });
  }
  const negative = (after.captures || []).find((row) => row.fixture === "cb_unknown");
  if (negative && negative.observations?.apply_now === true) {
    findings.push({ message: "negative board must not fabricate Apply now" });
  }
  const positive = (after.captures || []).find((row) => row.fixture === "cb_source_backed");
  if (positive && positive.observations?.attend === false) {
    findings.push({ message: "positive board must keep a source-backed attend path" });
  }
  return findings;
}

export function assembleCivicActionPathsDocumentationReceipt(root = ROOT) {
  const before = readJson(root, BEFORE_MANIFEST);
  const after = readJson(root, AFTER_MANIFEST);
  const ways = readJson(root, WAYS_CAPTURE);
  return freezeDeep({
    schema: DOCUMENTATION_SCHEMA,
    method: DOCUMENTATION_METHOD,
    card_id: "cityscroll-civic-action-paths/cap-9",
    derived_projection: true,
    semantic_graph_noun: false,
    exact_replay_family: EXACT_REPLAY_FAMILY,
    actorless: true,
    unknown_as_zero: false,
    cross_board_inference: false,
    non_causality: "CityScroll reports what happened to the rulemaking and never attributes adoption or effectiveness to a resident comment.",
    documentation: DOCUMENTATION_DOC,
    headings: [...REQUIRED_HEADINGS],
    implementation_refs: [...IMPLEMENTATION_REFS],
    tests: [...PROOF_TESTS],
    fixtures: [...FIXTURES],
    canaries: {
      council_single_matter: {
        request_id: "20260707022",
        subject_ref: "matter:79200",
        later_state: "Laid Over by Subcommittee",
      },
      council_multiple_matters: { request_id: "20260707021" },
      council_unmatched: { request_id: "20260728026" },
      dot_bicycle_racks: {
        subject_ref: "rulemaking:dot:bicycle-owned-racks",
        t1_notice: "20260317026",
        t2_notice: "20260706041",
        t3_effective: "2026-08-13",
      },
      community_board_positive: "community-board:manhattan-cb-02",
      community_board_negative: "community-board:bronx-cb-02",
    },
    evidence: {
      before: {
        manifest: BEFORE_MANIFEST,
        viewports: VIEWPORTS,
        capture_count: (before.captures || []).length,
      },
      after: {
        manifest: AFTER_MANIFEST,
        ways_to_participate: WAYS_CAPTURE,
        viewports: VIEWPORTS,
        capture_count: (after.captures || []).length,
        board_capture_count: (ways.captures || []).length,
      },
    },
    remaining_gaps: [
      "matter:{legistar_id} exact compiler family",
      "community-board committee-identity replay",
      "land, money, staffing, and property Action Path continuation adapters",
    ],
  });
}

export function assertCivicActionPathsDocumentationReceipt(receipt, root = ROOT) {
  const findings = documentationFindings(root);
  if (receipt?.schema !== DOCUMENTATION_SCHEMA) {
    findings.push({ message: "documentation receipt schema mismatch" });
  }
  if (receipt?.exact_replay_family !== EXACT_REPLAY_FAMILY) {
    findings.push({ message: "documentation receipt must keep rules.request_ids as the exact family" });
  }
  if (receipt?.semantic_graph_noun === true || receipt?.unknown_as_zero === true || receipt?.cross_board_inference === true) {
    findings.push({ message: "documentation receipt inverted a safety flag" });
  }
  if (findings.length) {
    const error = new Error(findings.map((row) => row.message).join("; "));
    error.findings = findings;
    throw error;
  }
  return receipt;
}

export function renderCivicActionPathsDocumentationMarkdown(receipt) {
  const lines = [
    "# Civic Action Paths documentation receipt",
    "",
    "This receipt joins the Action Path v0 contract, continuation safety, Community Board evidence policy, domain coverage, remaining gaps, visual evidence, tests, and implementation references. Screenshots are not proof by themselves.",
    "",
    `- Exact replay family: \`${receipt.exact_replay_family}\``,
    `- Semantic graph noun: ${receipt.semantic_graph_noun}`,
    `- Cross-board inference: ${receipt.cross_board_inference}`,
    `- Unknown as zero: ${receipt.unknown_as_zero}`,
    `- Non-causality: ${receipt.non_causality}`,
    "",
    "## Implementation",
    "",
    ...receipt.implementation_refs.map((ref) => `- \`${ref}\``),
    "",
    "## Tests",
    "",
    ...receipt.tests.map((ref) => `- \`${ref}\``),
    "",
    "## Fixtures",
    "",
    ...receipt.fixtures.map((ref) => `- \`${ref}\``),
    "",
    "## Remaining gaps",
    "",
    ...receipt.remaining_gaps.map((gap) => `- ${gap}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export { stableStringify };
