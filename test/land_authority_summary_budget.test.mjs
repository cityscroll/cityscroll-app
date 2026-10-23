import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LAND_AUTHORITY_SUMMARY_MAX_BYTES,
  resolveLandAuthoritySourceBasis,
} from "../site/land_authority_summary.mjs";
import { materializeLandAuthoritySummaries } from "../site/land_authority_summary_materialize.mjs";

const ROOT = new URL("../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, ROOT), "utf8"));
function readJsonIfExists(path) {
  try {
    return readJson(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

const landDefault = readJson("site/data/land_default_ulurp.json");
const outcomesSeed = readJsonIfExists("site/data/land_outcomes_seed.json");
const geography = readJson("site/data/community_board_geography_lookup.json");
const publishedOpportunities = readJson("site/data/land_upcoming_hearings.json");

// A tenth of the budget, so the payload has room for the publisher to resolve
// more projects before the bound is the thing that stops it.
const REQUIRED_HEADROOM = 0.1;

const PHASE_SOURCE_TYPES = new Set([
  "publisher_current_milestone",
  "materialized_phase_spine",
]);

function payloadFor(doc) {
  const { payload } = materializeLandAuthoritySummaries({
    landDefault: doc,
    outcomesSeed,
    geography,
    publishedOpportunities,
    asOf: doc.generated_at,
    generatedAt: doc.generated_at,
    artifactHashes: {},
  });
  return { payload, bytes: Buffer.byteLength(`${JSON.stringify(payload, null, 2)}\n`) };
}

/**
 * The publisher began sending a per-action array for each project, which
 * resolves more of them than the prefix-less string it replaced. More resolved
 * projects means a larger payload, and the bound is what a resident's first
 * paint is held to, so the shape has to leave room for that growth rather than
 * only fitting the corpus as it stands today.
 */
function withPerActionArrays(doc) {
  const copy = JSON.parse(JSON.stringify(doc));
  for (const [projectId, record] of Object.entries(copy.outcomes?.by_project || {})) {
    const project = copy.projects.find((row) => String(row.project_id) === projectId);
    if (!project || record.actions) continue;
    const codes = String(project.actions || "").split(";").map((code) => code.trim()).filter(Boolean);
    const numbers = String(project.ulurp_numbers || "").split(";").map((value) => value.trim()).filter(Boolean);
    if (!codes.length || codes.length !== numbers.length) continue;
    record.actions = codes.map((code, index) => ({
      action: code,
      ulurp_number: `${index === 0 ? "C" : "N"}${numbers[index]}`,
      status: "Certified",
      approved: true,
    }));
  }
  return copy;
}

test("the committed payload stays inside its bound with headroom", () => {
  const bytes = Buffer.byteLength(readFileSync(new URL("site/data/land_authority_summary.json", ROOT)));
  const ceiling = LAND_AUTHORITY_SUMMARY_MAX_BYTES * (1 - REQUIRED_HEADROOM);
  assert.ok(
    bytes <= ceiling,
    `committed payload is ${bytes} bytes; the bound is ${LAND_AUTHORITY_SUMMARY_MAX_BYTES} `
    + `and a tenth of it is reserved, so ${Math.floor(ceiling)} is the ceiling`,
  );
});

test("a corpus where every project carries per-action arrays still fits with headroom", () => {
  const plain = payloadFor(landDefault);
  const richer = payloadFor(withPerActionArrays(landDefault));
  const resolved = (payload) => Object.values(payload.summaries)
    .filter((summary) => summary.status === "resolved").length;

  assert.ok(
    resolved(richer.payload) >= resolved(plain.payload),
    "the richer publisher shape never resolves fewer projects",
  );
  const ceiling = LAND_AUTHORITY_SUMMARY_MAX_BYTES * (1 - REQUIRED_HEADROOM);
  assert.ok(
    richer.bytes <= ceiling,
    `payload with ${resolved(richer.payload)} of ${Object.keys(richer.payload.summaries).length} `
    + `resolved is ${richer.bytes} bytes, above the ${Math.floor(ceiling)}-byte ceiling`,
  );
});

test("shared provenance is published once and resolves back onto every summary", () => {
  const { payload } = payloadFor(landDefault);
  assert.ok(payload.source_basis_defaults, "the payload states the shared provenance");

  for (const summary of Object.values(payload.summaries)) {
    if (summary.status !== "resolved") continue;
    // The summary itself does not repeat what the payload already says.
    assert.equal(summary.source_basis.profile.source_type, undefined);
    assert.equal(summary.source_basis.geography.source_fields, undefined);

    const basis = resolveLandAuthoritySourceBasis(summary, payload);
    assert.equal(basis.profile.source_type, "reviewed_static_registry");
    assert.equal(basis.profile.effect_source, "reviewed_static_registry");
    // Phase provenance is either the Open Data milestone stamp or the
    // materialized spine when rich outcome evidence is present.
    assert.ok(
      PHASE_SOURCE_TYPES.has(basis.phase?.source_type ?? "publisher_current_milestone"),
      `unexpected phase source_type: ${basis.phase?.source_type}`,
    );
    assert.equal(basis.geography.source_type, "affected_review_body_for");
    assert.deepEqual(basis.geography.source_fields, ["community_district", "actions", "ulurp_numbers", "ulurp_non"]);
    assert.equal(basis.publisher.source_type, "published_hearing");
    assert.ok(basis.profile.legal_basis?.citation, "the legal citation resolves for a resolved summary");
  }
});

test("a summary read on its own still resolves its shared provenance", () => {
  const { payload } = payloadFor(landDefault);
  const summary = Object.values(payload.summaries).find((row) => row.status === "resolved");
  const basis = resolveLandAuthoritySourceBasis(summary);
  assert.equal(basis.profile.source_type, "reviewed_static_registry");
  assert.ok(basis.profile.legal_basis?.citation, "the citation falls back to the reviewed registry");
});
