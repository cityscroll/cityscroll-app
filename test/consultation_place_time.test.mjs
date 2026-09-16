import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNowSurface } from "../site/now_surface.mjs";
import { buildCommunityDistrictDigests } from "../tools/lib/community_district_digest.mjs";
import {
  COMMUNITY_DISTRICT_DIGEST_SECTIONS,
} from "../site/community_district_digest.mjs";
import {
  classifyLocationEvidence,
  locationEvidenceAllowsExactPredicate,
} from "../site/location_evidence_tier.mjs";
import {
  CONSULTATION_OPEN_CLAIM_MAX_AGE_HOURS,
  consultationConsumerRecords,
  consultationDeadline,
  consultationNowItems,
  consultationPlace,
  mergeConsultationActivity,
} from "../site/consultation_place_time.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const AS_OF = "2026-08-15T12:00:00.000Z";
const observed = "2026-08-15T00:00:00.000Z";
const base = { id: "round-1", title: "A local invitation", organizer: "Agency", observed_at: observed };

const districts = [
  ...Array.from({ length: 12 }, (_, i) => `M${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, i) => `X${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 18 }, (_, i) => `K${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 14 }, (_, i) => `Q${String(i + 1).padStart(2, "0")}`),
  "R01", "R02", "R03",
];

function emptyActivity() {
  const lenses = ["meetings", "land", "property", "rules", "money"];
  const records = Object.fromEntries(lenses.map((lens) => [lens, {}]));
  const byLevel = Object.fromEntries(districts.map((district) => [district, Object.fromEntries(lenses.map((lens) => [lens, []]))]));
  return {
    schema: "cityscroll.district_activity.v1",
    boundary_vintage: "2026-05-26",
    built_at: AS_OF,
    district_items: {
      by_level: { community_district: byLevel },
      corpora: Object.fromEntries(lenses.map((lens) => [lens, { stamp_value: "2026-08-01" }])),
      citywide: {},
      unlocated: {},
    },
    records,
    sources: Object.fromEntries(lenses.map((lens) => [lens, { counted: 0 }])),
  };
}

test("place projection preserves exact board identity, accepted address evidence, and absence", () => {
  assert.deepEqual(consultationPlace({ ...base, geography: { kind: "community_board", labels: ["CB14"], evidence: "board_identity" } }).community_districts, ["K14"]);
  assert.deepEqual(consultationPlace({ ...base, geography: { labels: ["Bloomingdale"], evidence: "accepted_address_geocoding", community_districts: ["M10"] } }).community_districts, ["M10"]);
  assert.deepEqual(consultationPlace({ ...base, geography: { kind: "corridor", labels: ["Church Avenue"] } }).community_districts, []);
  assert.equal(consultationPlace({ ...base, geography: { kind: "citywide", labels: ["New York City"] } }).scope, "citywide");
});

test("A1: district activity, digest, Near You scope, and Now place a typed consultation", async () => {
  await withPinnedClock(AS_OF, () => {
    const cb14 = {
      id: "cb14-community-budget-fy2028",
      title: "Brooklyn CB14 district needs, FY2028",
      organizer: "Brooklyn Community Board 14",
      observed_at: observed,
      deadline: { value: "2026-08-20", precision: "day" },
      geography: { kind: "community_board", labels: ["CB14"], evidence: "board_identity" },
    };
    const contribution = consultationConsumerRecords([cb14]);
    assert.equal(contribution.records[cb14.id].consultation_id, cb14.id);
    assert.deepEqual(contribution.by_community_district.K14, [cb14.id]);

    const activity = mergeConsultationActivity(emptyActivity(), [cb14]);
    assert.equal(activity.records.consultations[cb14.id].consultation_id, cb14.id);
    assert.deepEqual(activity.district_items.by_level.community_district.K14.consultations, [cb14.id]);

    const digest = buildCommunityDistrictDigests({ activity, builtAt: AS_OF });
    assert.deepEqual(
      COMMUNITY_DISTRICT_DIGEST_SECTIONS.map((section) => section.id),
      ["meetings", "land", "property", "rules", "money", "consultations"],
    );
    assert.equal(digest.by_community_district.K14.sections.consultations.items[0].consultation_id, cb14.id);
    assert.equal(digest.by_community_district.K14.sections.consultations.items[0].request_id, undefined);

    const nearYouScope = { place: { community_districts: ["K14"] }, topic: { keywords: [] } };
    assert.equal(consultationPlace(cb14).community_districts.includes("K14"), true);
    assert.equal(
      Object.values(contribution.records).some((row) => row.place.community_districts.includes("K14")),
      true,
    );
    assert.equal(nearYouScope.place.community_districts[0], "K14");

    const emptyDomains = ["money", "staffing", "rules", "property", "meetings", "land", "consultations"];
    const surface = buildNowSurface({
      ...Object.fromEntries(emptyDomains.map((domain) => [domain, { status: "available" }])),
      consultations: { status: "available", observed_at: observed, consultations: [cb14] },
    }, { today: "2026-08-15" });
    assert.ok(surface.act_by.dated.some((item) => item.id === `consultation:${cb14.id}` && item.domain === "consultations"));
  });
});

test("A2: headquarters placement is refused while evidence tier and digest ceiling hold", async () => {
  await withPinnedClock(AS_OF, () => {
    const hq = {
      ...base,
      id: "organizer-hq-tempt",
      organizer: "NYCEDC",
      organizer_address: "One World Trade Center",
      geography: {
        labels: ["One World Trade Center"],
        community_districts: ["M01"],
        evidence: "agency_hq",
        method: "agency_hq",
        confidence: 0.99,
      },
    };
    const place = consultationPlace(hq);
    assert.equal(place.headquarters_rejected, true);
    assert.deepEqual(place.community_districts, []);
    assert.equal(locationEvidenceAllowsExactPredicate({ method: place.method, confidence_tier: place.evidence_tier }), false);
    assert.equal(classifyLocationEvidence({ method: "community_board_ontology" }), "strong");

    const bloomingdale = {
      ...base,
      id: "bloomingdale-library-and-housing",
      geography: { labels: ["Bloomingdale"], evidence: "accepted_address_geocoding", community_districts: ["M10"], method: "civic_address_pip" },
    };
    const activity = mergeConsultationActivity(emptyActivity(), [hq, bloomingdale]);
    const digest = buildCommunityDistrictDigests({ activity, builtAt: AS_OF });
    assert.equal(digest.by_community_district.M01.sections.consultations.items.length, 0);
    assert.equal(digest.by_community_district.M10.sections.consultations.items[0].consultation_id, bloomingdale.id);
    assert.ok(digest.performance.measured_bytes <= digest.performance.ceiling_bytes);
    assert.equal(digest.performance.ceiling_bytes, 500_000);
  });
});

test("A4: seventy-two-hour freshness is pinned on both sides of its edge", async () => {
  await withPinnedClock(AS_OF, () => {
    const options = { asOf: AS_OF };
    assert.equal(CONSULTATION_OPEN_CLAIM_MAX_AGE_HOURS, 72);
    const freshEdge = consultationDeadline({
      ...base,
      deadline: { value: "2026-08-20", precision: "day" },
      observed_at: "2026-08-12T12:00:00.000Z",
    }, options);
    const staleEdge = consultationDeadline({
      ...base,
      deadline: { value: "2026-08-20", precision: "day" },
      observed_at: "2026-08-12T11:59:59.000Z",
    }, options);
    assert.equal(freshEdge.fresh, true);
    assert.equal(freshEdge.supported, true);
    assert.equal(staleEdge.fresh, false);
    assert.equal(staleEdge.supported, false);

    const horizonOptions = { asOf: AS_OF };
    const fresh = { ...base, observed_at: observed };
    assert.equal(consultationDeadline({ ...fresh, deadline: { value: "2026-08-15", precision: "day" } }, horizonOptions).supported, true);
    assert.equal(consultationDeadline({ ...fresh, deadline: { value: "2026-09-14", precision: "day" } }, horizonOptions).supported, true);
    assert.equal(consultationDeadline({ ...fresh, deadline: { value: "2026-09-15", precision: "day" } }, horizonOptions).supported, false);
    assert.equal(consultationDeadline({ ...fresh, deadline: { value: "2026-08-14", precision: "day" } }, horizonOptions).expired, true);
    assert.equal(consultationDeadline({ ...fresh, deadline: null }, horizonOptions).supported, false);
    const [item] = consultationNowItems([{ ...fresh, deadline: { value: "2026-08-20", precision: "day" } }], horizonOptions);
    assert.equal(item.time.precision, "day");
    assert.equal(item.place.scope, "unlocated");
  });
});
