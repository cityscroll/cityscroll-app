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
  isExactRulemakingRef,
  matchRulemakingSiblings,
  measureRulemakingSiblingFalseMerge,
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

test("rulemakingTitleCore strips DCWP NOH/NOA and rules-relating house style", () => {
  const a = rulemakingTitleCore("DCWP NOH Rules Relating to Restaurant Surcharges");
  const b = rulemakingTitleCore("DCWP NOA Rules Relating to Restaurant Surcharges");
  assert.match(a.toLowerCase(), /restaurant surcharges/);
  assert.match(b.toLowerCase(), /restaurant surcharges/);
  assert.ok(!/\bdcwp\b/i.test(a));
  assert.ok(!/\bnoh\b/i.test(a));
  assert.ok(!/\brelating\b/i.test(a));
});

test("extractRulemakingRefTokens finds specific RCNY section cites", () => {
  const cites = extractRulemakingRefTokens(
    "Amends 28 RCNY Chapter 12 and Section 12-01 regarding detectors",
  );
  assert.ok(cites.some((t) => /28rcny/i.test(t) && /section\s*12-01/i.test(t)));
  assert.ok(cites.some((t) => t === "section 12-01"));
  assert.ok(cites.some((t) => isExactRulemakingRef(t)), `expected exact compound in ${cites.join("|")}`);
  assert.equal(isExactRulemakingRef("section 12-01"), false, "bare section is not exact alone");
});

test("extractRulemakingRefTokens drops bare title N, non-numeric sections, chapter-alone", () => {
  const boilerplate = extractRulemakingRefTokens(
    "Pursuant to Title 1 of the Rules of the City of New York (RCNY) "
    + "and Title 28 of the RCNY, these sections authorize the agency "
    + "under Chapter 11 without amending a numbered section.",
  );
  assert.equal(boilerplate.length, 0, `expected no generic tokens, got ${JSON.stringify(boilerplate)}`);

  const pluralSections = extractRulemakingRefTokens(
    "This proposed rule would amend sections 4-01 and 4-08 of Chapter 4 of Title 34 of the Rules of the City of New York",
  );
  assert.ok(pluralSections.some((t) => t === "section 4-01"), pluralSections.join("|"));
  assert.ok(pluralSections.some((t) => t === "section 4-08"), pluralSections.join("|"));
  // Title-scoped compounds are exact.
  assert.ok(
    pluralSections.some((t) => isExactRulemakingRef(t) && /34rcny/.test(t) && /4-01/.test(t)),
    pluralSections.join("|"),
  );
  assert.ok(!pluralSections.some((t) => /^sections?$/i.test(t) || /^title\s+\d+$/i.test(t)));
  assert.ok(!pluralSections.some((t) => /^chapter\s+\d+$/i.test(t)));
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

test("matchRulemakingSiblings: months-apart genuine siblings still stitch; DCWP boilerplate does not", () => {
  const proposal = ruleNotice({
    request_id: "MOPED-P",
    agency: "Department of Transportation",
    agency_abbr: "DOT",
    title: "Proposed Rule — Operation of Mopeds on Bridges",
    notice_date: "2026-01-15T00:00:00.000",
  });
  const adoption = ruleNotice({
    request_id: "MOPED-A",
    agency: "Department of Transportation",
    agency_abbr: "DOT",
    title: "Notice of Adoption — Operation of Mopeds on Bridges",
    notice_date: "2026-07-20T00:00:00.000",
    stage: "adopted",
  });
  const mopeds = matchRulemakingSiblings(proposal, adoption);
  assert.equal(mopeds.matched, true);
  assert.equal(mopeds.confidence, "high");
  assert.ok(mopeds.days_apart >= 180, "proposal and adoption months apart");

  // Shared "Rules Relating to" / NOH / NOA house style must not join unrelated matters.
  const restaurant = ruleNotice({
    request_id: "DCWP-R",
    agency: "Consumer and Worker Protection",
    agency_abbr: "DCWP",
    title: "DCWP NOH Rules Relating to Restaurant Surcharges",
    notice_date: "2026-02-01T00:00:00.000",
  });
  const carWash = ruleNotice({
    request_id: "DCWP-C",
    agency: "Consumer and Worker Protection",
    agency_abbr: "DCWP",
    title: "DCWP NOA Rules Relating to Car Wash Records",
    notice_date: "2026-05-15T00:00:00.000",
  });
  const delivery = ruleNotice({
    request_id: "DCWP-D",
    agency: "Consumer and Worker Protection",
    agency_abbr: "DCWP",
    title: "DCWP NOH Rules Relating to Contracted Delivery Workers",
    notice_date: "2026-03-10T00:00:00.000",
  });
  assert.equal(matchRulemakingSiblings(restaurant, carWash).matched, false);
  assert.equal(matchRulemakingSiblings(restaurant, delivery).matched, false);
  assert.equal(matchRulemakingSiblings(carWash, delivery).matched, false);

  // Same topic under NOH/NOA still stitches (genuine DCWP sibling pair).
  const creditNoh = ruleNotice({
    request_id: "DCWP-CC1",
    agency: "Consumer and Worker Protection",
    agency_abbr: "DCWP",
    title: "DCWP NOH: Credit Card Limitations",
    notice_date: "2026-02-12T00:00:00.000",
  });
  const creditNoa = ruleNotice({
    request_id: "DCWP-CC2",
    agency: "Consumer and Worker Protection",
    agency_abbr: "DCWP",
    title: "DCWP NOA Credit Card Limitations",
    notice_date: "2026-06-06T00:00:00.000",
  });
  assert.equal(matchRulemakingSiblings(creditNoh, creditNoa).matched, true);
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

test("matchRulemakingSiblings: bare title 1 RCNY boilerplate does not merge", () => {
  // DOB field case: elevators vs energy code both cite Title 1 of the RCNY.
  const elevators = ruleNotice({
    request_id: "DOB-ELEV",
    agency: "Department of Buildings",
    agency_abbr: "DOB",
    title: "Proposed Rule Amendment of Rules Relating to Elevators, Escalators, Personnel Hoists and Moving Walks",
    notice_date: "2026-02-25T00:00:00.000",
    body:
      "Chapter 11 of Title 1 of the Rules of the City of New York. "
      + "These sections of Title 1 RCNY have not been updated in decades.",
  });
  const energy = ruleNotice({
    request_id: "DOB-ENERGY",
    agency: "Department of Buildings",
    agency_abbr: "DOB",
    title: "Amendments Related to the NYC Energy Conservation Code",
    notice_date: "2026-07-23T00:00:00.000",
    body:
      "amend Sections RCNY 5000-01 and 101-07 of Title 1 Of the Rules of the City of New York "
      + "to conform to changes in the New York City Energy Conservation Code.",
  });
  const capa = ruleNotice({
    request_id: "DOB-CAPA",
    agency: "Department of Buildings",
    agency_abbr: "DOB",
    title: "DOB Regulatory Agenda Fiscal Year 2027",
    notice_date: "2026-04-01T00:00:00.000",
    body: "Pursuant to Title 1 of the RCNY the Department publishes its annual regulatory agenda.",
  });
  assert.equal(matchRulemakingSiblings(elevators, energy).matched, false);
  assert.equal(matchRulemakingSiblings(elevators, capa).matched, false);
  assert.equal(matchRulemakingSiblings(energy, capa).matched, false);

  const groups = groupRulemakingSiblings([elevators, energy, capa]);
  const multi = groups.filter((g) => g.join.notice_count > 1);
  assert.equal(multi.length, 0, "Title 1 boilerplate must not union-find chain-merge DOB matters");
});

test("matchRulemakingSiblings: specific section cite + title-core merges; exact section alone does not", () => {
  const proposal = ruleNotice({
    request_id: "HPD-GAS-P",
    agency: "Housing Preservation and Development",
    agency_abbr: "HPD",
    title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-03-01T00:00:00.000",
    body: "Amends 28 RCNY Chapter 12 Section 12-01 regarding natural gas detectors.",
  });
  const adoption = ruleNotice({
    request_id: "HPD-GAS-A",
    agency: "Housing Preservation and Development",
    agency_abbr: "HPD",
    title: "Notice of Adoption — Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-07-01T00:00:00.000",
    stage: "adopted",
    body: "Adopts amendments to 28 RCNY Chapter 12 Section 12-01 on natural gas detectors.",
  });
  const gas = matchRulemakingSiblings(proposal, adoption);
  assert.equal(gas.matched, true);
  assert.equal(gas.confidence, "high");
  assert.ok(
    gas.method === "shared_reference" || gas.method === "title_agency_window",
    `expected shared_reference or title path, got ${gas.method}`,
  );

  // Same exact 34 RCNY §4-01, unrelated topics — must NOT high-confidence stitch.
  const fhv = ruleNotice({
    request_id: "DOT-FHV",
    agency: "Department of Transportation",
    agency_abbr: "DOT",
    title: "FHV and Taxi Parking at Commercial Meters",
    notice_date: "2026-07-14T00:00:00.000",
    body: "Amends sections 4-01 and 4-08 of Chapter 4 of Title 34 of the RCNY for FHV parking.",
  });
  const racks = ruleNotice({
    request_id: "DOT-BIKE",
    agency: "Department of Transportation",
    agency_abbr: "DOT",
    title: "City-Owned Bicycle Racks",
    notice_date: "2026-07-06T00:00:00.000",
    body: "Amends sections 4-01 and 4-12 of Chapter 4 of Title 34 of the RCNY for bicycle racks.",
  });
  const cross = matchRulemakingSiblings(fhv, racks);
  assert.equal(cross.matched, false, "exact section without title-core must not merge");
});

test("field case 20260714029: FHV commercial-meter parking does not absorb bicycle racks / truck routes / agenda", () => {
  // Documented demo rules-lifecycle-spine. Live over-stitch produced
  // rulemaking:dot:ref:sections with bicycle racks, truck routes, FY agenda.
  const fhv = ruleNotice({
    request_id: "20260714029",
    agency: "Department of Transportation",
    agency_abbr: "DOT",
    title: "Notice of Public Hearing and Opportunity to Comment-  FHV and Taxi Parking at Commercial Meters and Commercial Vehicle Markings",
    notice_date: "2026-07-22T00:00:00.000",
    stage: "hearing",
    body:
      "This proposed rule would amend sections 4-01 and 4-08 of Chapter 4 of Title 34 "
      + "of the Rules of the City of New York (\"RCNY\") to update provisions relating to "
      + "commercial vehicle markings and to allow for-hire vehicles to park in commercial parking meter areas.",
  });
  // Genuine sibling — same commercial-meter / FHV parking rulemaking.
  const fhvSibling = ruleNotice({
    request_id: "20260714030",
    agency: "Department of Transportation",
    agency_abbr: "DOT",
    title: "Notice of Proposed Rule — FHV and Taxi Parking at Commercial Meters and Commercial Vehicle Markings",
    notice_date: "2026-07-14T00:00:00.000",
    stage: "comment-open",
    body:
      "DOT proposes to amend sections 4-01 and 4-08 of Chapter 4 of Title 34 of the RCNY "
      + "regarding FHV and taxi parking at commercial meters.",
  });
  const bikeProposal = ruleNotice({
    request_id: "20260317026",
    agency: "Department of Transportation",
    agency_abbr: "DOT",
    title: "DOT Proposed Rules Relating to City-Owned Bicycle Racks",
    notice_date: "2026-03-25T00:00:00.000",
    body:
      "The proposed rule would amend sections of Chapter 4 of Title 34 of the Rules of the City of New York "
      + "regarding city-owned bicycle racks.",
  });
  const bikeAdoption = ruleNotice({
    request_id: "20260706041",
    agency: "Department of Transportation",
    agency_abbr: "DOT",
    title: "Notice of Adoption: City-Owned Bicycle Racks",
    notice_date: "2026-07-14T00:00:00.000",
    stage: "adopted",
    body:
      "DOT adopts rules relating to city-owned bicycle racks under Title 34 of the RCNY. "
      + "These sections govern placement of city-owned bicycle racks.",
  });
  const trucks = ruleNotice({
    request_id: "20260417003",
    agency: "Department of Transportation",
    agency_abbr: "DOT",
    title: "Proposed Amendment of Citywide Truck Routes",
    notice_date: "2026-05-04T00:00:00.000",
    body:
      "Amendments to Title 34 of the Rules of the City of New York regarding citywide truck routes. "
      + "These sections of the RCNY establish truck route designations.",
  });
  const agenda = ruleNotice({
    request_id: "20260401099",
    agency: "Department of Transportation",
    agency_abbr: "DOT",
    title: "DOT Regulatory Agenda for Fiscal Year 2027",
    notice_date: "2026-04-15T00:00:00.000",
    body:
      "Pursuant to Title 34 of the Rules of the City of New York the Department publishes its regulatory agenda. "
      + "These sections outline planned rulemakings for the fiscal year.",
  });

  assert.equal(matchRulemakingSiblings(fhv, fhvSibling).matched, true, "genuine FHV siblings must still stitch");
  assert.equal(matchRulemakingSiblings(fhv, bikeProposal).matched, false);
  assert.equal(matchRulemakingSiblings(fhv, bikeAdoption).matched, false);
  assert.equal(matchRulemakingSiblings(fhv, trucks).matched, false);
  assert.equal(matchRulemakingSiblings(fhv, agenda).matched, false);

  const stamped = attachRulemakingSiblings([
    fhv, fhvSibling, bikeProposal, bikeAdoption, trucks, agenda,
  ]);
  const byId = Object.fromEntries(stamped.map((r) => [r.request_id, r]));
  const fhvSubject = byId["20260714029"].rulemaking_subject_ref;
  assert.ok(fhvSubject);
  assert.equal(byId["20260714030"].rulemaking_subject_ref, fhvSubject);
  // Must not be the generic ref:sections subject from the live bug.
  assert.ok(!/ref:sections\b/i.test(fhvSubject), fhvSubject);
  for (const id of ["20260317026", "20260706041", "20260417003", "20260401099"]) {
    assert.notEqual(
      byId[id].rulemaking_subject_ref,
      fhvSubject,
      `${id} must not share FHV commercial-meter subject`,
    );
  }
  const fhvRelated = new Set(byId["20260714029"].related_notices.map((n) => n.request_id));
  assert.deepEqual([...fhvRelated].sort(), ["20260714030"]);
  assert.ok(!fhvRelated.has("20260317026"));
  assert.ok(!fhvRelated.has("20260706041"));
  assert.ok(!fhvRelated.has("20260417003"));
  assert.ok(!fhvRelated.has("20260401099"));
});

test("measureRulemakingSiblingFalseMerge flags shared_reference low-cohesion groups", () => {
  // Simulate the old failure mode: unrelated titles forced into one group.
  // The proxy must catch this even when method is shared_reference.
  const a = ruleNotice({
    request_id: "FM1",
    agency: "Department of Transportation",
    agency_abbr: "DOT",
    title: "FHV and Taxi Parking at Commercial Meters",
    notice_date: "2026-07-01T00:00:00.000",
  });
  const b = ruleNotice({
    request_id: "FM2",
    agency: "Department of Transportation",
    agency_abbr: "DOT",
    title: "City-Owned Bicycle Racks",
    notice_date: "2026-07-02T00:00:00.000",
  });
  const c = ruleNotice({
    request_id: "FM3",
    agency: "Department of Transportation",
    agency_abbr: "DOT",
    title: "Citywide Truck Routes Amendment",
    notice_date: "2026-07-03T00:00:00.000",
  });
  // Genuine multi group should not flag.
  const g1 = ruleNotice({
    request_id: "OK1",
    title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-03-01T00:00:00.000",
  });
  const g2 = ruleNotice({
    request_id: "OK2",
    title: "Notice of Adoption — Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-07-01T00:00:00.000",
  });
  const groups = [
    {
      subject_ref: "rulemaking:dot:ref:sections",
      notices: [a, b, c],
      join: { method: "shared_reference", notice_count: 3 },
    },
    {
      subject_ref: "rulemaking:hpd:gas-detectors",
      notices: [g1, g2],
      join: { method: "title_agency_window", notice_count: 2 },
    },
  ];
  const m = measureRulemakingSiblingFalseMerge(groups);
  assert.equal(m.multi_groups, 2);
  assert.equal(m.flagged_groups, 1);
  assert.ok(m.false_merge_rate > 0);
  const bad = m.audits.find((x) => x.subject_ref === "rulemaking:dot:ref:sections");
  assert.equal(bad.flagged_false_merge_risk, true);
  assert.ok(bad.flag_reasons.includes("low_title_core_overlap"));
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
