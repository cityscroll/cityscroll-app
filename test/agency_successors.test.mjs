// OTI agency former-name / successor densify — kill sample + precision bar.
//
//   node --test test/agency_successors.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { resolveAgencyIdentity, canonicalAgency } from "../site/agency_identity.mjs";
import { sameAgency } from "../entity_resolution/normalizers/agency.mjs";
import { enrichAgency } from "../worker/src/lib/agency_identity.mjs";
import crosswalk from "../worker/src/data/agency_crosswalk.json" with { type: "json" };
import {
  AGENCY_SUCCESSOR_KILL_SAMPLE,
  AGENCY_SUCCESSOR_PRECISION_FLOOR,
  extractSuccessorEdges,
  materializeSuccessorAliasMap,
  measureSuccessorKillSample,
  densifyCrosswalkWithSuccessors,
  splitFormerField,
} from "../tools/lib/agency_successors.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(
  join(ROOT, "test/fixtures/agency_successors/oti_former_names_sample.json"),
  "utf8",
));
const receipt = JSON.parse(readFileSync(
  join(ROOT, "site/data/agency_sources/verification_receipts/agency_successors_2026-08-11.json"),
  "utf8",
));

function baseResolve(raw) {
  return resolveAgencyIdentity(raw, { skipSuccessors: true });
}

test("splitFormerField keeps multi-value OTI lists and drops empties", () => {
  assert.deepEqual(
    splitFormerField("Department of Sanitation;NYC Sanitation"),
    ["Department of Sanitation", "NYC Sanitation"],
  );
  assert.deepEqual(splitFormerField(null), []);
  assert.deepEqual(splitFormerField(""), []);
});

test("extractSuccessorEdges emits only publisher-backed former surfaces", () => {
  const edges = extractSuccessorEdges(fixture.rows);
  assert.ok(edges.length >= 40, `expected densify volume, got ${edges.length}`);
  assert.ok(edges.every((e) => e.source_id === "t3jq-9nkf"));
  assert.ok(edges.every((e) => e.basis === "oti_alternate_or_former_names_v1"));
  assert.ok(edges.every((e) => e.former_surface && e.current_name));
  // DoITT full title and Art Commission are published former names.
  assert.ok(edges.some((e) => /Information Technology and Telecommunications/i.test(e.former_surface)
    && /Technology and Innovation/i.test(e.current_name)));
  assert.ok(edges.some((e) => e.former_surface === "Art Commission"
    && e.current_name === "Public Design Commission"));
  // Null former fields never invent edges.
  const empty = extractSuccessorEdges([{ name: "Solo Agency", operational_status: "Active" }]);
  assert.equal(empty.length, 0);
});

test("dated kill sample clears the 95% precision bar and closes residual renames", () => {
  const edges = extractSuccessorEdges(fixture.rows);
  const aliasMap = materializeSuccessorAliasMap(edges, { baseResolve });
  const measured = measureSuccessorKillSample({ edges, baseResolve, aliasMap });
  assert.equal(AGENCY_SUCCESSOR_KILL_SAMPLE.as_of, "2026-08-11");
  assert.equal(measured.precision, 1);
  assert.ok(measured.precision >= AGENCY_SUCCESSOR_PRECISION_FLOOR);
  assert.equal(measured.negatives.false_merges, 0);
  assert.equal(measured.positives.residual_after, 0);
  assert.equal(measured.positives.fixed, measured.positives.residual_before);
  assert.equal(measured.positives.fix_rate_on_residual, 1);
  assert.equal(measured.materialize_edges, true);
  assert.equal(measured.clears_precision_bar, true);
});

test("product resolve joins densified renames and holds hard negatives", () => {
  // Gold gv0-026 + OTI residual renames.
  assert.equal(
    canonicalAgency("Dept of Info Tech & Telecomm").canonical_id,
    canonicalAgency("Office of Technology and Innovation").canonical_id,
  );
  assert.equal(sameAgency("Art Commission", "Public Design Commission"), true);
  assert.equal(
    sameAgency("Office of Emergency Management", "New York City Emergency Management"),
    true,
  );
  assert.equal(
    sameAgency("Department of Education", "New York City Public Schools"),
    true,
  );
  assert.equal(
    sameAgency(
      "Mayor's Office to Combat Domestic Violence",
      "Mayor's Office to End Domestic and Gender-Based Violence",
    ),
    true,
  );
  assert.equal(
    sameAgency(
      "New York County District Attorney's Office",
      "Manhattan District Attorney's Office",
    ),
    true,
  );

  // Hard negatives stay distinct.
  assert.equal(
    sameAgency("Manhattan District Attorney's Office", "Brooklyn District Attorney's Office"),
    false,
  );
  assert.equal(sameAgency("Department of Correction", "Board of Correction"), false);
  assert.equal(
    sameAgency("N.Y.C. Transit Authority", "Metropolitan Transportation Authority"),
    false,
  );
});

test("crosswalk stamps former_names without fabricating nulls", () => {
  const oti = crosswalk.entries["information-technology-and-telecommunications"];
  assert.ok(oti, "OTI identity card present");
  assert.ok(Array.isArray(oti.former_names) && oti.former_names.length >= 1);
  assert.ok(oti.former_names.some((n) => /Information Technology/i.test(n)));
  assert.equal(oti.successor_basis, "oti_alternate_or_former_names_v1");

  const pdc = crosswalk.entries["public-design-commission"];
  assert.ok(pdc?.former_names?.includes("Art Commission"));

  // Source-null stays null on entries with no OTI former surface.
  const stamped = densifyCrosswalkWithSuccessors(
    { entries: { solo: { canonical_name: "Solo", variants: ["Solo"] } } },
    [],
    { materialize: true },
  );
  assert.equal(stamped.crosswalk.entries.solo.former_names, null);
  assert.equal(stamped.crosswalk.entries.solo.former_acronyms, null);

  // enrichAgency still routes through the shared canonical id.
  const a = enrichAgency(crosswalk.entries, "Art Commission");
  const b = enrichAgency(crosswalk.entries, "Public Design Commission");
  assert.ok(a && b);
  assert.deepEqual(a, b);
});

test("committed receipt matches the fixture kill sample", () => {
  assert.equal(receipt.schema, "cityscroll.agency_successor_kill_sample.v1");
  assert.equal(receipt.as_of, "2026-08-11");
  assert.equal(receipt.source.id, "t3jq-9nkf");
  assert.ok(receipt.precision >= AGENCY_SUCCESSOR_PRECISION_FLOOR);
  assert.equal(receipt.clears_precision_bar, true);
  assert.equal(receipt.materialize_edges, true);
  assert.equal(receipt.residual.after, 0);
  assert.equal(receipt.residual.fix_rate_on_residual, 1);
  assert.equal(receipt.kill_sample.negatives.false_merges, 0);
  // Previously-broken residual count is recorded for the fix-rate claim.
  assert.equal(receipt.residual.before, 6);
  assert.equal(receipt.residual.fixed, 6);
});
