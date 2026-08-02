/**
 * Multi-notice rulemaking stitch — proposal / hearing / adoption siblings.
 *
 * verify:
 *   node --test worker/test/rulemaking_siblings.test.mjs worker/test/nyc_rules.test.mjs worker/test/subject_registry.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attachRulemakingSiblings,
  classifyRulemakingRole,
  extractRulemakingRefTokens,
  groupRulemakingSiblings,
  matchRulemakingSiblings,
  rulemakingSubjectRef,
  rulemakingTitleCore,
} from "../src/lib/rules.mjs";
import {
  linksFromRuleRecord,
  subjectsConnected,
} from "../src/lib/subject_registry.mjs";

function ruleNotice(opts) {
  return {
    request_id: opts.request_id,
    agency: opts.agency || "Housing Preservation and Development",
    title: opts.title,
    notice_date: opts.notice_date || "2026-03-01T00:00:00.000",
    stage: opts.stage || "proposed",
    city_record: {
      request_id: opts.request_id,
      agency: opts.agency || "Housing Preservation and Development",
      title: opts.title,
      notice_date: opts.notice_date || "2026-03-01T00:00:00.000",
      notice_type: opts.notice_type || "Agency Rules",
      additional_description_1: opts.body || "",
    },
    nyc_rules: opts.nyc_rules === undefined
      ? {
          url: opts.rules_url || null,
          guid: opts.rules_guid || null,
          title: opts.rules_title || opts.title,
          agency_abbr: opts.agency_abbr || "HPD",
          agency_name: "HPD",
          summary: opts.body || "",
          adoption_published_at: opts.adoption_published_at || null,
          notice_type: opts.rule_notice_type || null,
        }
      : opts.nyc_rules,
    join: opts.join || { matched: !!opts.rules_guid, confidence: opts.rules_guid ? "high" : undefined },
  };
}

// ---------------------------------------------------------------------------
// Title core / refs / role
// ---------------------------------------------------------------------------

test("rulemakingTitleCore strips proposal / hearing / adoption boilerplate", () => {
  const coreA = rulemakingTitleCore("Notice of Proposed Rule — Natural Gas Detectors in Dwelling Units");
  const coreB = rulemakingTitleCore("Notice of Adoption of Natural Gas Detectors in Dwelling Units");
  const coreC = rulemakingTitleCore("Public Hearing on Natural Gas Detectors in Dwelling Units");
  assert.match(coreA.toLowerCase(), /natural gas detectors/);
  assert.match(coreB.toLowerCase(), /natural gas detectors/);
  assert.match(coreC.toLowerCase(), /natural gas detectors/);
  // Lifecycle words removed so cores overlap.
  assert.ok(!/\bproposed\b/i.test(coreA));
  assert.ok(!/\badoption\b/i.test(coreB));
});

test("extractRulemakingRefTokens finds RCNY and section cites", () => {
  const tokens = extractRulemakingRefTokens(
    "Amends 28 RCNY Chapter 12 and Section 12-01 regarding detectors",
  );
  assert.ok(tokens.some((t) => /28rcny/i.test(t) || /28\s*rcny/i.test(t)));
  assert.ok(tokens.some((t) => /chapter\s*12/i.test(t)));
});

test("classifyRulemakingRole maps proposal / hearing / adoption", () => {
  assert.equal(
    classifyRulemakingRole(ruleNotice({
      request_id: "1",
      title: "Proposed rule regarding natural gas detectors",
      stage: "comment-open",
    })),
    "proposal",
  );
  assert.equal(
    classifyRulemakingRole(ruleNotice({
      request_id: "2",
      title: "Public Hearing on natural gas detectors",
      stage: "hearing",
    })),
    "hearing",
  );
  assert.equal(
    classifyRulemakingRole(ruleNotice({
      request_id: "3",
      title: "Notice of Adoption — Natural Gas Detectors",
      stage: "adopted",
      adoption_published_at: "2026-07-01T12:00:00.000Z",
    })),
    "adoption",
  );
});

// ---------------------------------------------------------------------------
// Pair match — high confidence only
// ---------------------------------------------------------------------------

test("matchRulemakingSiblings: proposal + adoption with strong title stitch", () => {
  const proposal = ruleNotice({
    request_id: "20260301001",
    title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-03-01T00:00:00.000",
    stage: "comment-open",
  });
  const adoption = ruleNotice({
    request_id: "20260701001",
    title: "Notice of Adoption — Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-07-01T00:00:00.000",
    stage: "adopted",
    adoption_published_at: "2026-07-01T12:00:00.000Z",
  });
  const result = matchRulemakingSiblings(proposal, adoption);
  assert.equal(result.matched, true);
  assert.equal(result.confidence, "high");
  assert.equal(result.method, "title_agency_window");
});

test("matchRulemakingSiblings: shared rules guid is high confidence", () => {
  const a = ruleNotice({
    request_id: "A1",
    title: "Proposed widgets",
    rules_guid: "https://rules.cityofnewyork.us/?p=4242",
    notice_date: "2026-01-01T00:00:00.000",
  });
  const b = ruleNotice({
    request_id: "A2",
    title: "Adoption of something else entirely about frogs",
    rules_guid: "https://rules.cityofnewyork.us/?p=4242",
    notice_date: "2026-06-01T00:00:00.000",
  });
  const result = matchRulemakingSiblings(a, b);
  assert.equal(result.matched, true);
  assert.equal(result.confidence, "high");
  assert.equal(result.method, "shared_rules_id");
});

test("matchRulemakingSiblings: unrelated titles do not stitch", () => {
  const gas = ruleNotice({
    request_id: "G1",
    title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-03-01T00:00:00.000",
  });
  const parking = ruleNotice({
    request_id: "P1",
    title: "Proposed Rule — Alternate Side Parking Suspension Calendar",
    notice_date: "2026-03-15T00:00:00.000",
  });
  const result = matchRulemakingSiblings(gas, parking);
  assert.equal(result.matched, false);
});

test("matchRulemakingSiblings: different agencies do not stitch", () => {
  const hpd = ruleNotice({
    request_id: "H1",
    title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
    agency: "Housing Preservation and Development",
    agency_abbr: "HPD",
  });
  const dot = ruleNotice({
    request_id: "D1",
    title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
    agency: "Department of Transportation",
    agency_abbr: "DOT",
  });
  const result = matchRulemakingSiblings(hpd, dot);
  assert.equal(result.matched, false);
  assert.match(result.basis, /agency/i);
});

test("matchRulemakingSiblings: outside lifecycle window does not stitch on title alone", () => {
  const early = ruleNotice({
    request_id: "E1",
    title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
    notice_date: "2024-01-01T00:00:00.000",
  });
  const late = ruleNotice({
    request_id: "E2",
    title: "Notice of Adoption — Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-07-01T00:00:00.000",
  });
  const result = matchRulemakingSiblings(early, late);
  assert.equal(result.matched, false);
});

// ---------------------------------------------------------------------------
// Group + attach: three siblings → one subject; unrelated stays separate
// ---------------------------------------------------------------------------

test("three sibling rule notices stitch to one subject; unrelated does not", () => {
  const proposal = ruleNotice({
    request_id: "20260301011",
    title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-03-01T00:00:00.000",
    stage: "comment-open",
  });
  const hearing = ruleNotice({
    request_id: "20260415011",
    title: "Public Hearing on Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-04-15T00:00:00.000",
    stage: "hearing",
  });
  const adoption = ruleNotice({
    request_id: "20260701011",
    title: "Notice of Adoption — Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-07-01T00:00:00.000",
    stage: "adopted",
    adoption_published_at: "2026-07-01T12:00:00.000Z",
  });
  const unrelated = ruleNotice({
    request_id: "20260320099",
    title: "Proposed Rule — Lead-Based Paint Inspection Fees",
    notice_date: "2026-03-20T00:00:00.000",
    stage: "proposed",
  });

  const stamped = attachRulemakingSiblings([proposal, hearing, adoption, unrelated]);
  assert.equal(stamped.length, 4);

  const byId = Object.fromEntries(stamped.map((r) => [r.request_id, r]));
  const subject = byId["20260301011"].rulemaking_subject_ref;
  assert.ok(subject, "proposal must receive a rulemaking subject");
  assert.equal(byId["20260415011"].rulemaking_subject_ref, subject);
  assert.equal(byId["20260701011"].rulemaking_subject_ref, subject);
  assert.notEqual(byId["20260320099"].rulemaking_subject_ref, subject);

  // Each sibling lists the other two; unrelated has no multi-notice match.
  assert.equal(byId["20260301011"].related_notices.length, 2);
  assert.equal(byId["20260415011"].related_notices.length, 2);
  assert.equal(byId["20260701011"].related_notices.length, 2);
  assert.equal(byId["20260320099"].related_notices.length, 0);
  assert.equal(byId["20260320099"].rulemaking_join.matched, false);

  const roles = new Set(
    [byId["20260301011"], byId["20260415011"], byId["20260701011"]]
      .map((r) => r.rulemaking_join.role),
  );
  assert.deepEqual([...roles].sort(), ["adoption", "hearing", "proposal"]);

  // related_notices carry roles + join provenance
  const relatedIds = byId["20260301011"].related_notices.map((n) => n.request_id).sort();
  assert.deepEqual(relatedIds, ["20260415011", "20260701011"]);
  for (const rel of byId["20260301011"].related_notices) {
    assert.equal(rel.join.matched, true);
    assert.equal(rel.join.confidence, "high");
    assert.ok(rel.role);
  }

  // Group inventory
  const groups = groupRulemakingSiblings([proposal, hearing, adoption, unrelated]);
  const multi = groups.filter((g) => g.join.notice_count > 1);
  assert.equal(multi.length, 1);
  assert.equal(multi[0].join.notice_count, 3);
  assert.equal(multi[0].subject_ref, subject);
});

test("notice identities stay distinct — link not merge", () => {
  const a = ruleNotice({
    request_id: "20260101001",
    title: "Proposed Rule — Scaffold Safety Training Hours",
    notice_date: "2026-01-01T00:00:00.000",
  });
  const b = ruleNotice({
    request_id: "20260601001",
    title: "Notice of Adoption — Scaffold Safety Training Hours",
    notice_date: "2026-06-01T00:00:00.000",
    stage: "adopted",
  });
  const stamped = attachRulemakingSiblings([a, b]);
  assert.equal(stamped[0].request_id, "20260101001");
  assert.equal(stamped[1].request_id, "20260601001");
  assert.equal(stamped[0].rulemaking_subject_ref, stamped[1].rulemaking_subject_ref);
  assert.notEqual(stamped[0].request_id, stamped[1].request_id);
});

test("linksFromRuleRecord emits same_rulemaking edges for stitched siblings", () => {
  const proposal = ruleNotice({
    request_id: "20260301011",
    title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-03-01T00:00:00.000",
    stage: "comment-open",
    rules_guid: "https://rules.cityofnewyork.us/?p=9991",
    join: { matched: true, confidence: "high", basis: "fixture" },
  });
  const adoption = ruleNotice({
    request_id: "20260701011",
    title: "Notice of Adoption — Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-07-01T00:00:00.000",
    stage: "adopted",
    rules_guid: "https://rules.cityofnewyork.us/?p=9991",
    join: { matched: true, confidence: "high", basis: "fixture" },
  });
  const [p, a] = attachRulemakingSiblings([proposal, adoption]);
  const pLinks = linksFromRuleRecord(p);
  const aLinks = linksFromRuleRecord(a);

  assert.equal(pLinks.subject_refs.notice, "notice:20260301011");
  assert.equal(aLinks.subject_refs.notice, "notice:20260701011");

  const sameP = pLinks.subject_links.filter((l) => l.type === "same_rulemaking");
  const sameA = aLinks.subject_links.filter((l) => l.type === "same_rulemaking");
  assert.equal(sameP.length, 1);
  assert.equal(sameA.length, 1);
  // Ordered endpoints — same undirected pair.
  assert.equal(sameP[0].from, sameA[0].from);
  assert.equal(sameP[0].to, sameA[0].to);
  assert.equal(sameP[0].evidence.basis, "rulemaking_sibling_stitch");
  assert.ok(
    subjectsConnected("notice:20260301011", "notice:20260701011", pLinks.subject_links),
  );
  // about_notice to rules still present on matched joins.
  assert.ok(pLinks.subject_links.some((l) => l.type === "about_notice"));
});

test("singleton notices get a subject but no related_notices", () => {
  const alone = ruleNotice({
    request_id: "SOLO1",
    title: "Proposed Rule — Unique One-Off Filing Fees",
    notice_date: "2026-05-01T00:00:00.000",
  });
  const [stamped] = attachRulemakingSiblings([alone]);
  assert.ok(stamped.rulemaking_subject_ref);
  assert.deepEqual(stamped.related_notices, []);
  assert.equal(stamped.rulemaking_join.matched, false);
  assert.equal(stamped.rulemaking_join.method, "single_notice");
});

test("rulemakingSubjectRef prefers shared rules id when present", () => {
  const rows = [
    ruleNotice({
      request_id: "R1",
      title: "Proposed widgets",
      rules_guid: "https://rules.cityofnewyork.us/?p=77",
      agency_abbr: "HPD",
    }),
    ruleNotice({
      request_id: "R2",
      title: "Adopted widgets",
      rules_guid: "https://rules.cityofnewyork.us/?p=77",
      agency_abbr: "HPD",
    }),
  ];
  const ref = rulemakingSubjectRef(rows, { method: "shared_rules_id" });
  assert.match(ref, /^rulemaking:hpd:rules:/);
});
