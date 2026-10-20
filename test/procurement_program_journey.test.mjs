// Opt-in program-history journey for retained public awards (bounded pilot).

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PROGRAM_HISTORY_BETA_SLUG,
  DEFAULT_TRAINING_PROFILE,
  buildProgramJourney,
  journeyHtmlOmitsOpenBidCta,
  profileFromFormValues,
  renderProgramJourneyHtml,
  PROGRAM_RELATION,
} from "../site/procurement_program_journey.mjs";

import {
  recordPursuitDecision,
  pursuitStateFor,
} from "../site/procurement_pursuit_state.mjs";

class FakeStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

const corpus = JSON.parse(
  readFileSync(
    new URL("../site/data/procurement_program_capabilities_corpus.json", import.meta.url),
    "utf8",
  ),
);

test("program corpus retains exactly three historical awards", () => {
  assert.equal(corpus.default_off, true);
  assert.equal(corpus.records.length, 3);
});

test("A1: training profile with no roof crew shows three awards, both categories, training overlap and coating gap", () => {
  const journey = buildProgramJourney({
    profile: DEFAULT_TRAINING_PROFILE,
    records: corpus.records,
  });
  assert.equal(journey.records.length, 3);
  assert.equal(journey.open_bid_cta, false);
  assert.equal(journey.combined_spend, null);
  assert.equal(journey.future_opening_predicted, false);
  assert.equal(journey.automatic_qualification, false);
  assert.equal(journey.pursuit_notes_mutated, false);

  const categories = new Set(journey.records.map((r) => r.category_description));
  assert.equal(categories.size, 2);

  const byId = Object.fromEntries(journey.records.map((r) => [r.notice_id, r]));
  assert.ok(byId["20220719104"]);
  assert.ok(byId["20240417107"]);
  assert.ok(byId["20260708004"]);

  const trainingOverlap = byId["20240417107"].assessments.some(
    (a) => a.state === "supported_overlap",
  );
  assert.equal(trainingOverlap, true);

  const coatingGap = byId["20240417107"].assessments.find(
    (a) => a.capability_id === "reflective_coating",
  );
  assert.equal(coatingGap.state, "stated_capability_gap");
  assert.equal(coatingGap.service_gap, "physical roof coating delivery");
  assert.ok(coatingGap.citation?.url);
});

test("A2: consortium cites 2024 passage; lead eligibility stays document-review; no future/spend/auto-qualify", () => {
  const journey = buildProgramJourney({
    profile: DEFAULT_TRAINING_PROFILE,
    records: corpus.records,
  });
  const row2024 = journey.records.find((r) => r.notice_id === "20240417107");
  const consortium = row2024.assessments.find(
    (a) => a.capability_id === "consortium_delivery",
  );
  assert.ok(consortium);
  assert.equal(consortium.state, "document_review_needed");
  assert.equal(consortium.citation.notice_id, "20240417107");
  assert.match(consortium.citation.passage, /consortium of qualified vendors/i);

  assert.equal(journey.future_opening_predicted, false);
  assert.equal(journey.combined_spend, null);
  assert.equal(journey.automatic_qualification, false);

  const exact = journey.relations.find(
    (r) =>
      r.relation === PROGRAM_RELATION.EXACT_PREDECESSOR_LINK &&
      ((r.a === "20240417107" && r.b === "20260708004") ||
        (r.a === "20260708004" && r.b === "20240417107")),
  );
  assert.ok(exact);
});

test("A2 / B2: changing capacity updates comparison only; pursuit notes untouched", () => {
  const storage = new FakeStorage();
  recordPursuitDecision(storage, {
    noticeId: "20240417107",
    decision: "pursuing",
    reason: "Capability fit",
  });
  const before = pursuitStateFor(storage, "20240417107");

  const journey = buildProgramJourney({
    profile: {
      ...DEFAULT_TRAINING_PROFILE,
      roof_installation_crew: true,
    },
    records: corpus.records,
  });
  const coating = journey.records
    .find((r) => r.notice_id === "20240417107")
    .assessments.find((a) => a.capability_id === "reflective_coating");
  assert.equal(coating.state, "supported_overlap");
  assert.equal(journey.pursuit_notes_mutated, false);
  assert.deepEqual(pursuitStateFor(storage, "20240417107"), before);
});

test("A3: rendered journey omits open-bid CTA and includes source citations", () => {
  const journey = buildProgramJourney({
    profile: DEFAULT_TRAINING_PROFILE,
    records: corpus.records,
  });
  const html = renderProgramJourneyHtml(journey);
  assert.equal(journeyHtmlOmitsOpenBidCta(html), true);
  assert.match(html, /20240417107/);
  assert.match(html, /white, reflective coating/);
  assert.match(html, /Back to Contracts Browse/);
});

test("failed source load preserves profile and offers retry", () => {
  const journey = buildProgramJourney({
    profile: DEFAULT_TRAINING_PROFILE,
    loadError: "HTTP 503",
  });
  assert.equal(journey.retry_available, true);
  assert.equal(journey.records.length, 0);
  assert.equal(journey.profile.job_training, true);
  const html = renderProgramJourneyHtml(journey);
  assert.match(html, /data-program-retry/);
});

test("failed source load also offers existing notice source links", () => {
  const journey = buildProgramJourney({
    profile: DEFAULT_TRAINING_PROFILE,
    loadError: "HTTP 503",
  });
  assert.equal(journey.source_links.length, 3);
  assert.deepEqual(
    journey.source_links.map((link) => link.notice_id),
    ["20220719104", "20240417107", "20260708004"],
  );
  const html = renderProgramJourneyHtml(journey);
  assert.match(html, /data-program-source-links/);
  assert.match(html, /data-program-retry/);
  assert.match(html, /href="https:\/\/cityscroll\.org\/notices\/20220719104\/"/);
  assert.match(html, /href="https:\/\/cityscroll\.org\/notices\/20240417107\/"/);
  assert.match(html, /href="https:\/\/cityscroll\.org\/notices\/20260708004\/"/);
  // Browse back-link alone must not be the only navigational affordance.
  const noticeHrefs = [...html.matchAll(/href="(https:\/\/cityscroll\.org\/notices\/[^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.equal(noticeHrefs.length, 3);
});

test("profileFromFormValues round-trips training answers", () => {
  const profile = profileFromFormValues({
    capability_keywords: "job training, employer placement",
    job_training: "true",
    employer_placement: "true",
    roof_installation_crew: "false",
  });
  assert.equal(profile.job_training, true);
  assert.equal(profile.employer_placement, true);
  assert.equal(profile.roof_installation_crew, false);
});

test("beta slug is registered default-off constant", () => {
  assert.equal(PROGRAM_HISTORY_BETA_SLUG, "program-history");
});

test("beta slug is registered default-off in the public flag registry", () => {
  const registry = JSON.parse(
    readFileSync(new URL("../site/beta-flags.json", import.meta.url), "utf8"),
  );
  const flag = registry.flags.find((f) => f.slug === PROGRAM_HISTORY_BETA_SLUG);
  assert.ok(flag);
  assert.equal(flag.default_off, true);
  assert.ok(flag.removal_date >= "2026-10-20");
});

test("standalone program-history page ships with noscript source links", () => {
  const html = readFileSync(
    fileURLToPath(new URL("../site/contracts-program-history.html", import.meta.url)),
    "utf8",
  );
  assert.match(html, /<noscript>/);
  assert.match(html, /notices\/20220719104/);
  assert.match(html, /notices\/20240417107/);
  assert.match(html, /notices\/20260708004/);
  assert.match(html, /beta_flags\.js/);
  assert.match(html, /app\/program-history\.mjs/);
});
