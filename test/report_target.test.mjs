import assert from "node:assert/strict";
import test from "node:test";

import {
  REPORT_TARGET_SCHEMA,
  buildReportTarget,
  buildReportTargetFromAnchor,
  describeReportTarget,
  parseReportClaimAnchor,
  reportTargetCardProjection,
  reportTargetIdentity,
  resolveReportTarget,
  serializeReportTarget,
} from "../site/report_target.mjs";

test("whole-object target uses the existing object id and Copy link route", () => {
  const target = buildReportTarget({
    object_type: "procurement",
    object_id: "procurement:contract:CT123",
    canonical_url: "/procurements/procurement%3Acontract%3ACT123",
    object_label: "Street repair contract",
  });

  assert.equal(target.schema, REPORT_TARGET_SCHEMA);
  assert.equal(target.target_id, reportTargetIdentity(target));
  assert.equal(target.description, "Street repair contract");
  assert.equal(target.provenance, null);
  assert.equal(reportTargetCardProjection(target).copy_target,
    "https://cityscroll.org/procurements/procurement%3Acontract%3ACT123");
});

test("contract vendor field anchor is stable and carries existing observation provenance", () => {
  const target = buildReportTargetFromAnchor("contract:CT123#vendor", {
    object: {
      object_type: "procurement",
      procurement_id: "procurement:contract:CT123",
      compatibility: { canonical_href: "/procurements/procurement%3Acontract%3ACT123" },
      title: "Street repair contract",
      source_observation_refs: ["passport_public_contracts:row-1"],
    },
    claim_anchor: { rendered_value: "Acme Works" },
  });

  assert.equal(target.object_id, "procurement:contract:CT123");
  assert.equal(target.claim_anchor.claim_type, "field");
  assert.equal(target.claim_anchor.field_or_semantic_key, "vendor");
  assert.equal(target.claim_anchor.subject_id, "procurement:contract:CT123");
  assert.deepEqual(target.provenance.source_record_ids, ["passport_public_contracts:row-1"]);
  assert.match(target.description, /Street repair contract: Acme Works/);
});

test("entity identity anchor remains semantic across display and markup changes", () => {
  const first = buildReportTargetFromAnchor("entity:official:42#identity", {
    object_type: "entity",
    object_id: "entity:official:42",
    canonical_url: "/officials/42/",
    object_label: "Jordan Lee",
    claim_anchor: { rendered_value: "<strong>Jordan Lee</strong>" },
  });
  const second = buildReportTargetFromAnchor("entity:official:42#identity", {
    object_type: "entity",
    object_id: "entity:official:42",
    canonical_url: "/officials/42/",
    object_label: "Jordan Lee",
    claim_anchor: { rendered_value: "Jordan Lee" },
  });

  assert.equal(first.target_id, second.target_id);
  assert.equal(first.claim_anchor.claim_type, "identity");
  assert.equal(describeReportTarget(first), "Jordan Lee: identity");
});

test("land parcel relationship resolves existing project and parcel ids", () => {
  const target = buildReportTargetFromAnchor("landuse:2026M0258#parcel", {
    object_type: "land_use_project",
    object_id: "project:2026M0258",
    canonical_url: "/browse/zoning/#land/2026M0258",
    object_label: "Avenue project",
    bbl: "1006440001",
    edge: {
      type: "sits_on_parcel",
      from: "project:2026M0258",
      to: "bbl:1006440001",
      provenance: {
        source_system: "zap-bbl",
        source_record_id: "zap-bbl:2026M0258:1006440001",
        source_url: "https://zap.planning.nyc.gov/projects/2026M0258",
      },
    },
  });

  assert.deepEqual(target.claim_anchor, {
    anchor: "landuse:2026M0258#parcel",
    object_ref: "landuse:2026M0258",
    claim_type: "relationship",
    relation_type: "sits_on_parcel",
    subject_id: "project:2026M0258",
    object_id: "bbl:1006440001",
    field_or_semantic_key: "parcel",
  });
  assert.deepEqual(target.provenance, {
    source_record_ids: ["zap-bbl:2026M0258:1006440001"],
    source_urls: ["https://zap.planning.nyc.gov/projects/2026M0258"],
    systems: ["zap-bbl"],
  });
});

test("land regulatory-effect fallback is a derived interpretation", () => {
  const target = buildReportTargetFromAnchor("landuse:2026M0258#regulatory-effect", {
    object_id: "project:2026M0258",
    object_type: "land_use_project",
    canonical_url: "/browse/zoning/#land/2026M0258",
    object_label: "Avenue project",
    claim_anchor: { rendered_value: "Upzone" },
  });
  assert.equal(target.claim_anchor.claim_type, "interpretation");
  assert.equal(target.claim_anchor.field_or_semantic_key, "regulatory-effect");
  assert.equal(target.target_id, reportTargetIdentity({ ...target, description: "different" }));
});

test("meeting grouping anchor is independent of member/list order", () => {
  const first = buildReportTargetFromAnchor("meeting:city_record:20260814001#collapsed_notices", {
    object: {
      meeting_id: "meeting:city_record:20260814001",
      title: "Public hearing",
      source_record: { source_system: "city_record", identifier: "20260814001", url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260814001" },
    },
    canonical_url: "/meetings/meeting%3Acity_record%3A20260814001",
    claim_anchor: { rendered_value: "2 notices" },
  });
  const second = buildReportTargetFromAnchor("meeting:city_record:20260814001#collapsed_notices", {
    object_type: "meeting",
    object_id: "meeting:city_record:20260814001",
    canonical_url: "/meetings/meeting%3Acity_record%3A20260814001",
    object_label: "Public hearing",
    source: { source_system: "city_record", source_record_ids: ["20260814001"], source_urls: ["https://a856-cityrecord.nyc.gov/RequestDetail/20260814001"] },
    claim_anchor: { rendered_value: "2 notices, reordered" },
  });

  assert.equal(first.target_id, second.target_id);
  assert.equal(first.claim_anchor.claim_type, "grouping");
  assert.equal(first.description, "Public hearing: grouped notices");
  assert.deepEqual(first.provenance, second.provenance);
});

test("rulemaking lifecycle anchor resolves subject ref and remains source-absent when none exists", () => {
  const target = buildReportTargetFromAnchor("rulemaking:nyc-rules-9001#lifecycle", {
    canonical_url: "/browse/rules/",
    object_label: "Commercial curb-use rule",
  });
  assert.equal(target.object_id, "rulemaking:nyc-rules-9001");
  assert.equal(target.claim_anchor.claim_type, "lifecycle");
  assert.equal(target.claim_anchor.subject_id, "rulemaking:nyc-rules-9001");
  assert.equal(target.provenance, null);
  assert.equal(target.description, "Commercial curb-use rule: lifecycle");
});

test("anchor parsing rejects positional or malformed anchors", () => {
  assert.deepEqual(parseReportClaimAnchor("contract:CT123#vendor").claim_type, "field");
  assert.throws(() => parseReportClaimAnchor("contract:CT123"), /claim anchor/);
  assert.throws(() => parseReportClaimAnchor("contract:CT123#vendor#first"), /claim anchor/);
});

test("serialization and re-resolution are deterministic", () => {
  const target = buildReportTarget({
    object_type: "meeting",
    object_id: "meeting:community_board:harbor",
    canonical_url: "/meetings/meeting%3Acommunity_board%3Aharbor",
    object_label: "Harbor meeting",
    claim_anchor: "meeting:community_board:harbor#collapsed_notices",
    provenance: {
      source_system: "community_board",
      source_record_ids: ["event-2", "event-1"],
      source_urls: ["https://example.test/2", "https://example.test/1"],
    },
  });
  assert.equal(serializeReportTarget(target), serializeReportTarget(resolveReportTarget(JSON.parse(serializeReportTarget(target)))));
});
