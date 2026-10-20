// Opt-in historical capability-comparison journey (bounded pilot).

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_COMPARE_BETA_SLUG,
  CAPABILITY_COMPARE_PROFILE_STORAGE_KEY,
  DEFAULT_DRAIN_PROFILE,
  applyCapabilityProfileToSearchParams,
  buildCapabilityJourney,
  capabilityProfileFromSearchParams,
  journeyHtmlOmitsOpenBidCta,
  parseCapabilityProfile,
  profileFromFormValues,
  readCapabilityProfileFromStorage,
  renderCapabilityJourneyHtml,
  resolveInitialCapabilityProfile,
  serializeCapabilityProfile,
  writeCapabilityProfileToStorage,
} from "../site/procurement_capability_journey.mjs";

import {
  CAPABILITY_ASSESSMENT_STATE,
  assessmentForDuty,
} from "../site/procurement_capability_comparison.mjs";

import {
  recordPursuitDecision,
  pursuitStateFor,
  clearPursuitDecision,
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
    new URL("../site/data/procurement_capability_compare_corpus.json", import.meta.url),
    "utf8",
  ),
);

test("compare corpus retains exactly three historical awards", () => {
  assert.equal(corpus.default_off, true);
  assert.equal(corpus.records.length, 3);
  assert.deepEqual(
    corpus.records.map((r) => r.request_id),
    ["20230807115", "20231220107", "20251008021"],
  );
});

test("A1: drain-only profile shows three records with the expected assessments", () => {
  const journey = buildCapabilityJourney({
    profile: DEFAULT_DRAIN_PROFILE,
    records: corpus.records,
  });
  assert.equal(journey.records.length, 3);
  assert.equal(journey.open_bid_cta, false);
  assert.equal(journey.combined_spend, null);
  assert.equal(journey.pursuit_notes_mutated, false);

  const byId = Object.fromEntries(journey.records.map((row) => [row.notice_id, row]));
  assert.equal(byId["20230807115"].award_status, "Award");
  assert.equal(byId["20230807115"].published_on, "2023-08-11");
  assert.equal(byId["20230807115"].source_role, "award_description");

  const fdny = assessmentForDuty(byId["20230807115"].comparison, "jet_vacuum_service");
  assert.equal(fdny.state, CAPABILITY_ASSESSMENT_STATE.STATED_CAPABILITY_GAP);
  assert.equal(fdny.service_gap, "jet vacuum");
  assert.equal(fdny.ownership_required, null);

  const dot = assessmentForDuty(byId["20231220107"].comparison, "vegetation_trimming");
  assert.equal(dot.state, CAPABILITY_ASSESSMENT_STATE.STATED_CAPABILITY_GAP);
  assert.equal(dot.service_gap, "vegetation trimming");

  const dcas = assessmentForDuty(
    byId["20251008021"].comparison,
    "nonspecific_equipment_materials",
  );
  assert.equal(dcas.state, CAPABILITY_ASSESSMENT_STATE.DOCUMENT_REVIEW_NEEDED);
});

test("A2: changing capacity updates only the comparison; pursuit notes stay untouched", () => {
  const store = new FakeStorage();
  const matterRef = "notice:20230807115";
  recordPursuitDecision(store, {
    matter_ref: matterRef,
    decision: "pursuing",
    reason_code: "capacity",
    note: "keep me",
  });
  const before = pursuitStateFor(store, matterRef);

  const withJet = buildCapabilityJourney({
    profile: { ...DEFAULT_DRAIN_PROFILE, jet_vac_truck: true },
    records: corpus.records,
  });
  const withoutJet = buildCapabilityJourney({
    profile: DEFAULT_DRAIN_PROFILE,
    records: corpus.records,
  });
  const fdnyWith = assessmentForDuty(
    withJet.records.find((r) => r.notice_id === "20230807115").comparison,
    "jet_vacuum_service",
  );
  const fdnyWithout = assessmentForDuty(
    withoutJet.records.find((r) => r.notice_id === "20230807115").comparison,
    "jet_vacuum_service",
  );
  assert.equal(fdnyWith.state, CAPABILITY_ASSESSMENT_STATE.SUPPORTED_OVERLAP);
  assert.equal(fdnyWithout.state, CAPABILITY_ASSESSMENT_STATE.STATED_CAPABILITY_GAP);

  const after = pursuitStateFor(store, matterRef);
  assert.deepEqual(after, before);
  assert.equal(withJet.pursuit_notes_mutated, false);
  assert.equal(withoutJet.open_bid_cta, false);

  // Historical awards expose source review / preparation, never open-bid CTA.
  for (const row of withJet.records) {
    assert.ok(row.preparation_actions.some((a) => a.kind === "source_review" && a.href));
    assert.equal(row.preparation_actions.some((a) => /bid/i.test(a.label)), false);
  }

  clearPursuitDecision(store, matterRef);
});

test("A2 / B2: failed source load preserves the profile and offers retry", () => {
  const journey = buildCapabilityJourney({
    profile: DEFAULT_DRAIN_PROFILE,
    records: [],
    loadError: "HTTP 500",
  });
  assert.equal(journey.load_error, "HTTP 500");
  assert.equal(journey.retry_available, true);
  assert.deepEqual(journey.profile.capability_keywords, ["drain cleaning"]);
  assert.equal(journey.profile.jet_vac_truck, false);
  assert.equal(journey.records.length, 0);
  const html = renderCapabilityJourneyHtml(journey);
  assert.match(html, /data-capability-retry/);
  assert.match(html, /HTTP 500/);
  assert.equal(journeyHtmlOmitsOpenBidCta(html), true);
});

test("A3: rendered journey omits open-bid CTA and includes source citations", () => {
  const journey = buildCapabilityJourney({
    profile: DEFAULT_DRAIN_PROFILE,
    records: corpus.records,
  });
  const html = renderCapabilityJourneyHtml(journey);
  assert.equal(journeyHtmlOmitsOpenBidCta(html), true);
  assert.match(html, /data-open-bid-cta="false"/);
  assert.match(html, /20230807115/);
  assert.match(html, /pump truck, jet vacuum and video camera inspectional services/);
  assert.match(html, /VEGETATION TRIMMING/);
  assert.match(html, /document review needed/i);
  assert.match(html, /capability-profile-form/);
});

test("profileFromFormValues round-trips the drain-only answers", () => {
  const profile = profileFromFormValues({
    capability_keywords: "drain cleaning",
    jet_vac_truck: "false",
    landscaping: "false",
  });
  assert.deepEqual(profile.capability_keywords, ["drain cleaning"]);
  assert.equal(profile.jet_vac_truck, false);
  assert.equal(profile.landscaping, false);
});

test("beta slug is registered default-off in the public flag registry", () => {
  const registry = JSON.parse(
    readFileSync(new URL("../site/beta-flags.json", import.meta.url), "utf8"),
  );
  const flag = registry.flags.find((f) => f.slug === CAPABILITY_COMPARE_BETA_SLUG);
  assert.ok(flag);
  assert.equal(flag.default_off, true);
  assert.ok(flag.removal_date >= "2026-10-20");
});

test("standalone compare page ships with noscript source links", () => {
  const html = readFileSync(
    fileURLToPath(new URL("../site/contracts-capability-compare.html", import.meta.url)),
    "utf8",
  );
  assert.match(html, /<noscript>/);
  assert.match(html, /notices\/20230807115/);
  assert.match(html, /notices\/20231220107/);
  assert.match(html, /notices\/20251008021/);
  assert.match(html, /beta_flags\.js/);
  assert.match(html, /app\/capability-compare\.mjs/);
});

test("capability profile persists across sessionStorage remount (Back)", () => {
  const storage = new FakeStorage();
  const typed = profileFromFormValues({
    capability_keywords: "jet vac, catch basin",
    jet_vac_truck: "true",
    landscaping: "false",
  });
  assert.equal(writeCapabilityProfileToStorage(storage, typed), true);
  assert.ok(storage.getItem(CAPABILITY_COMPARE_PROFILE_STORAGE_KEY));

  const restored = readCapabilityProfileFromStorage(storage);
  assert.deepEqual(restored.capability_keywords, ["jet vac", "catch basin"]);
  assert.equal(restored.jet_vac_truck, true);
  assert.equal(restored.landscaping, false);

  // Remount path: URL has only beta, storage carries the typed form.
  const remount = resolveInitialCapabilityProfile({
    searchParams: new URLSearchParams("beta=capability-compare"),
    storage,
  });
  assert.deepEqual(remount.capability_keywords, ["jet vac", "catch basin"]);
  assert.equal(remount.jet_vac_truck, true);
  assert.equal(remount.landscaping, false);
});

test("URL profile fields win over sessionStorage and round-trip", () => {
  const storage = new FakeStorage();
  writeCapabilityProfileToStorage(
    storage,
    profileFromFormValues({
      capability_keywords: "from-storage",
      jet_vac_truck: "false",
      landscaping: "false",
    }),
  );
  const params = new URLSearchParams(
    "beta=capability-compare&capability_keywords=from-url%2C+hydro&jet_vac_truck=true",
  );
  const fromUrl = capabilityProfileFromSearchParams(params);
  assert.deepEqual(fromUrl.capability_keywords, ["from-url", "hydro"]);
  assert.equal(fromUrl.jet_vac_truck, true);

  const resolved = resolveInitialCapabilityProfile({ searchParams: params, storage });
  assert.deepEqual(resolved.capability_keywords, ["from-url", "hydro"]);
  assert.equal(resolved.jet_vac_truck, true);

  const next = new URLSearchParams("beta=capability-compare");
  applyCapabilityProfileToSearchParams(next, resolved);
  assert.equal(next.get("beta"), "capability-compare");
  assert.match(next.get("capability_keywords"), /from-url/);
  assert.equal(next.get("jet_vac_truck"), "true");

  const roundTrip = parseCapabilityProfile(serializeCapabilityProfile(resolved));
  assert.deepEqual(roundTrip.capability_keywords, ["from-url", "hydro"]);
});

test("resolveInitialCapabilityProfile falls back to the drain default", () => {
  const profile = resolveInitialCapabilityProfile({
    searchParams: new URLSearchParams("beta=capability-compare"),
    storage: new FakeStorage(),
  });
  assert.deepEqual(profile.capability_keywords, [...DEFAULT_DRAIN_PROFILE.capability_keywords]);
  assert.equal(profile.jet_vac_truck, false);
  assert.equal(profile.landscaping, false);
});
