// Pins the agency-identity join — worker/src/lib/agency_identity.mjs (normalize + lookup) and the
// GET /agency endpoint (worker/src/agency.mjs), which resolve a City Record notice's free-text
// agency string to its canonical identity card, sourced from NYC/NYS Open Data and precompiled
// into worker/src/data/agency_crosswalk.json by tools/build_agency_crosswalk.mjs.
//
// Fixtures-first: the anchors are REAL City Record agency strings, quoted verbatim from the
// dg92-zbpx `agency_name` column (both the legacy UPPERCASE and modern mixed-case conventions),
// plus the generalized class boundaries the normalizer must hold:
//   - the two naming conventions collapse to one key ("DEPT OF SANITATION" ≡ "Sanitation")
//   - word order can't matter ("DISTRICT ATTORNEY-MANHATTAN" ≡ "Manhattan District Attorney's…")
//   - a possessive 's in a canonical name doesn't leave a stray token
//   - an agency string the crosswalk never resolved degrades gracefully (matched:false)
//
//   node --test test/agency_identity.test.mjs   (from crol-list/worker/)

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeAgencyKey, enrichAgency, aliasTargetFor } from "../src/lib/agency_identity.mjs";
import { canonicalAgency } from "../src/lib/agencies.mjs";
import crosswalk from "../src/data/agency_crosswalk.json" with { type: "json" };
import { handleAgency } from "../src/agency.mjs";

const entries = crosswalk.entries;

// --- normalizeAgencyKey: the two City Record naming conventions must produce ONE key -----------

test("legacy UPPERCASE and modern mixed-case agency strings normalize to the same key", () => {
  // Both of these are real dg92-zbpx agency_name values for the Department of Sanitation.
  assert.equal(normalizeAgencyKey("DEPARTMENT OF SANITATION"), normalizeAgencyKey("Sanitation"));
  assert.equal(normalizeAgencyKey("DEPT OF PARKS & RECREATION"), normalizeAgencyKey("Parks and Recreation"));
  assert.equal(normalizeAgencyKey("DEPT OF ENVIRONMENT PROTECTION"), normalizeAgencyKey("Environmental Protection"));
});

test("word order does not matter (county/borough and possessive artifacts fold away)", () => {
  // "DISTRICT ATTORNEY-MANHATTAN" (City Record) vs the roster's "Manhattan District Attorney's Office".
  assert.equal(
    normalizeAgencyKey("DISTRICT ATTORNEY-MANHATTAN"),
    normalizeAgencyKey("Manhattan District Attorney's Office")
  );
  // The possessive 's must not survive as a lone "S" token.
  assert.ok(!normalizeAgencyKey("Manhattan District Attorney's Office").split(" ").includes("S"));
});

test("an all-stopword string yields an empty key rather than a garbage token", () => {
  // "Office of the Mayor" is all filler; the key must be empty, not match a random agency.
  assert.equal(normalizeAgencyKey("Office of the Mayor"), "MAYOR");
  assert.equal(normalizeAgencyKey("   "), "");
});

// --- enrichAgency: real notice agency strings resolve to the enriched identity card -----------

test("a real notice's agency string resolves through the crosswalk to the enriched record", () => {
  // Anchor: verbatim City Record string → the canonical identity card.
  const dsny = enrichAgency(entries, "DEPARTMENT OF SANITATION");
  assert.ok(dsny, "Sanitation must resolve");
  assert.match(dsny.canonical_name, /Sanitation/);
  assert.equal(dsny.acronym, "DSNY");
  assert.ok(dsny.head_name, "must carry the principal officer (head)");
  assert.ok(dsny.budget_code, "must carry the budget code");
  assert.ok(dsny.budget_adopted > 0, "must carry a positive adopted budget");

  // The modern mixed-case variant of the same agency resolves to the SAME card.
  const dsny2 = enrichAgency(entries, "Sanitation");
  assert.deepEqual(dsny2, dsny);
});

test("the class generalizes: several real agency strings each resolve to a plausible identity", () => {
  const cases = [
    ["POLICE DEPARTMENT", "NYPD"],
    ["Police Department", "NYPD"],
    ["DEPARTMENT OF CORRECTION", "DOC"],
    ["Housing Preservation and Development", "HPD"],
    ["HOUSING PRESERVATION & DVLPMNT", "HPD"],
  ];
  for (const [raw, acronym] of cases) {
    const rec = enrichAgency(entries, raw);
    assert.ok(rec, `${raw} must resolve`);
    assert.equal(rec.acronym, acronym, `${raw} → ${acronym}`);
  }
});

test("composition: the join routes through the site's canonicalAgency, not a second resolver", () => {
  // The high-volume poll-worker string is folded into Board of Elections by the SHARED
  // crosswalk (lib/agencies.mjs), and the identity card is attached to that canonical agency.
  const viaPollWorkers = enrichAgency(entries, "BOARD OF ELECTION POLL WORKERS");
  assert.ok(viaPollWorkers, "poll-worker string must resolve to an identity");
  assert.match(viaPollWorkers.canonical_name, /Board of Elections/);
  // The plain Board of Elections spelling lands on the very same canonical identity.
  assert.equal(canonicalAgency("BOARD OF ELECTION POLL WORKERS").canonical_id,
               canonicalAgency("Board of Election").canonical_id);
  assert.deepEqual(enrichAgency(entries, "Board of Election"), viaPollWorkers);
});

test("a no-match agency string degrades gracefully (null, no throw)", () => {
  assert.equal(enrichAgency(entries, "TOTALLY MADE UP AGENCY XYZ"), null);
  assert.equal(enrichAgency(entries, ""), null);
  assert.equal(enrichAgency(entries, null), null);
  // A genuine but out-of-roster body (a bi-state authority) also degrades, not crashes.
  assert.equal(enrichAgency(entries, "Port Authority of New York and New Jersey"), null);
});

// --- GET /agency endpoint ---------------------------------------------------------------------

function get(name) {
  const url = "https://api.crol-list.org/agency" + (name == null ? "" : "?name=" + encodeURIComponent(name));
  return handleAgency(new Request(url, { headers: { origin: "https://crol-list.org" } }), {});
}

test("GET /agency returns the identity card + provenance for a matched agency", async () => {
  const res = await get("DEPARTMENT OF SANITATION");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.matched, true);
  assert.equal(body.identity.acronym, "DSNY");
  // Provenance names the source datasets by their own ids — the honest-data register.
  const ids = body.provenance.sources.map((s) => s.id);
  assert.ok(ids.includes("t3jq-9nkf"));
  assert.ok(ids.includes("mwzb-yiwb"));
});

test("GET /agency returns matched:false (not an error) for an unresolved agency", async () => {
  const res = await get("TOTALLY MADE UP AGENCY XYZ");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.matched, false);
  assert.equal(body.identity, null);
  assert.ok(body.provenance, "provenance still returned so the client can say what was checked");
});

test("GET /agency without a name is a 400, and OPTIONS preflight is 204", async () => {
  assert.equal((await get(null)).status, 400);
  const pre = await handleAgency(
    new Request("https://api.crol-list.org/agency", { method: "OPTIONS", headers: { origin: "https://crol-list.org" } }),
    {}
  );
  assert.equal(pre.status, 204);
});

// --- aliasTargetFor: community-college suffix rule --------------------------------------------

test("CUNY community colleges route to the university via the college suffix rule", () => {
  assert.equal(aliasTargetFor(normalizeAgencyKey("COMMUNITY COLLEGE (MANHATTAN)")), "City University of New York");
  assert.equal(aliasTargetFor(normalizeAgencyKey("Guttman Community College")), "City University of New York");
});
