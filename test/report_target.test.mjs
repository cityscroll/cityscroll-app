import assert from "node:assert/strict";
import test from "node:test";

import {
  REPORT_TARGET_SCHEMA,
  buildReportTarget,
  buildReportTargetFromAnchor,
  buildRelationshipReportTarget,
  describeReportTarget,
  parseReportClaimAnchor,
  reportTargetCardProjection,
  reportTargetIdentity,
  resolveReportTarget,
  serializeReportTarget,
} from "../site/report_target.mjs";
import {
  buildLandRegulatoryEffectReportTarget,
  buildMeetingGroupingReportTarget,
  buildContractVendorRelationshipReportTarget,
  buildProjectParcelRelationshipReportTarget,
  buildRulemakingLifecycleReportTarget,
} from "../site/report_issue.mjs";

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

test("Contract ↔ vendor relationship anchor names both civic endpoints", () => {
  const target = buildContractVendorRelationshipReportTarget({
    procurement_id: "procurement:contract:CT123",
    canonical_href: "/procurements/procurement%3Acontract%3ACT123",
    short_title: "Street repair contract",
    vendor_name: "Acme Works",
    vendor_entity_ref: "vendor:stem:ACME%20WORKS",
    source_observation_refs: ["passport_public_contracts:row-1"],
  });

  assert.equal(target.claim_anchor.claim_type, "relationship");
  assert.equal(target.claim_anchor.relation_type, "named_vendor");
  assert.equal(target.claim_anchor.subject_id, "procurement:contract:CT123");
  assert.equal(target.claim_anchor.object_id, "vendor:stem:ACME%20WORKS");
  assert.equal(target.description, "Street repair contract is connected to Acme Works");
  assert.deepEqual(target.provenance.source_record_ids, ["passport_public_contracts:row-1"]);
  assert.equal(target.target_id, reportTargetIdentity({
    ...target,
    object_label: "A differently formatted title",
    claim_anchor: { ...target.claim_anchor, rendered_value: "Acme Works — Street repair contract" },
  }));
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

test("project ↔ parcel relationship anchor survives unrelated presentation changes", () => {
  const edge = {
    ref: "bbl:1006440001",
    label: "Manhattan — Block 644, Lot 1",
    relation: "sited_on_parcel",
    provenance: {
      source_system: "zap-bbl",
      source_record_id: "zap-bbl:2026M0258:1006440001",
      source_url: "https://zap.planning.nyc.gov/projects/2026M0258",
    },
  };
  const target = buildProjectParcelRelationshipReportTarget({
    project_id: "2026M0258",
    project_name: "Avenue project",
  }, edge);
  const reordered = buildProjectParcelRelationshipReportTarget({
    project_id: "2026M0258",
    project_name: "Avenue project",
    unrelated_cards: ["different", "order"],
  }, { ...edge, label: "A different parcel presentation" });

  assert.equal(target.claim_anchor.anchor, "landuse:2026M0258#parcel:1006440001");
  assert.equal(target.claim_anchor.claim_type, "relationship");
  assert.equal(target.claim_anchor.relation_type, "sited_on_parcel");
  assert.equal(target.claim_anchor.subject_id, "project:2026M0258");
  assert.equal(target.claim_anchor.object_id, "bbl:1006440001");
  assert.match(target.description, /Avenue project is connected to Manhattan/);
  assert.deepEqual(target.provenance.source_record_ids, ["zap-bbl:2026M0258:1006440001"]);
  assert.equal(target.target_id, reordered.target_id);
});

test("generic relationship builder keeps the machine relation type separate from civic copy", () => {
  const target = buildRelationshipReportTarget({
    object_type: "rulemaking",
    object_id: "rulemaking:nyc-rules-9001",
    canonical_url: "/browse/rules/",
    object_label: "Commercial curb-use rule",
    anchor: "rulemaking:nyc-rules-9001#lifecycle",
    relation_type: "same_rulemaking_lifecycle",
    subject_id: "rulemaking:nyc-rules-9001",
    subject_label: "Commercial curb-use proposal",
    related_object_id: "notice:adoption-9001",
    related_object_label: "Notice of adoption",
    field_or_semantic_key: "lifecycle",
  });
  assert.equal(target.claim_anchor.relation_type, "same_rulemaking_lifecycle");
  assert.equal(target.description, "Commercial curb-use proposal is connected to Notice of adoption");
  assert.doesNotMatch(target.description, /relation_type|subject_id|object_id/);
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

test("meeting grouping target preserves constituent notices and source provenance", () => {
  const members = [
    {
      request_id: "20260814001",
      source_system: "city_record",
      source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260814001",
    },
    {
      request_id: "20260814002",
      source_system: "city_record",
      source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260814002",
    },
  ];
  const entry = {
    kind: "event",
    notice_count: 2,
    subject_ref: "meeting-object:meeting:city_record:20260814001",
    primary: {
      meeting_id: "meeting:city_record:20260814001",
      title: "Public hearing on street safety",
      affected_area: { scope: "local" },
    },
    members,
  };
  const target = buildMeetingGroupingReportTarget(entry);

  assert.equal(target.claim_anchor.claim_type, "grouping");
  assert.equal(target.claim_anchor.anchor, "meeting:city_record:20260814001#collapsed_notices");
  assert.deepEqual(target.constituent_object_ids, [
    "notice:20260814001",
    "notice:20260814002",
  ]);
  assert.deepEqual(target.provenance.source_record_ids, ["20260814001", "20260814002"]);
  assert.deepEqual(target.provenance.source_urls, members.map(member => member.source_url));
  assert.match(target.asserted_meaning, /one meeting with local place semantics/);
  assert.match(target.description, /Public hearing on street safety/);
  assert.deepEqual(entry.members, members, "report construction does not rewrite the grouping");
});

test("rulemaking lifecycle target retains notice ids and is stable across member order", () => {
  const entry = {
    kind: "rulemaking",
    notice_count: 2,
    subject_ref: "rulemaking:hpd:natural-gas-detectors",
    title: "Natural gas detector rule",
    rule_url: "https://rules.cityofnewyork.us/?p=9001",
    members: [
      { request_id: "20260301011", source_record_id: "20260301011", source_url: "https://example.test/proposal" },
      { request_id: "20260701011", source_record_id: "20260701011", source_url: "https://example.test/adoption" },
    ],
  };
  const first = buildRulemakingLifecycleReportTarget(entry);
  const second = buildRulemakingLifecycleReportTarget({
    ...entry,
    members: [...entry.members].reverse(),
  });

  assert.equal(first.claim_anchor.anchor, "rulemaking:hpd:natural-gas-detectors#lifecycle");
  assert.equal(first.canonical_url, "/#rules");
  assert.deepEqual(first.constituent_object_ids, ["notice:20260301011", "notice:20260701011"]);
  assert.deepEqual(first.provenance.source_record_ids, ["20260301011", "20260701011"]);
  assert.ok(first.provenance.source_urls.includes(entry.rule_url));
  assert.match(first.asserted_meaning, /one rulemaking lifecycle/);
  assert.equal(first.target_id, second.target_id);
});

test("land regulatory-effect target carries the derived meaning and cited source material", () => {
  const target = buildLandRegulatoryEffectReportTarget({
    project_id: "2026K0123",
    project_name: "1550 Bedford Avenue Rezoning",
    regulatory_effect: "upzone",
    regulatory_effect_confidence: "high",
    regulatory_effect_basis: {
      existing: { districts: [{ citation: { url: "https://zr.planning.nyc.gov/article-ii/chapter-3/23-21" } }] },
      proposed: { districts: [{ citation: { url: "https://zr.planning.nyc.gov/article-ii/chapter-3/23-22" } }] },
    },
  });

  assert.equal(target.claim_anchor.anchor, "landuse:2026K0123#regulatory-effect");
  assert.equal(target.claim_anchor.claim_type, "interpretation");
  assert.deepEqual(target.constituent_object_ids, ["project:2026K0123"]);
  assert.deepEqual(target.provenance.source_record_ids, ["2026K0123"]);
  assert.ok(target.provenance.source_urls.some(url => url.includes("23-22")));
  assert.match(target.asserted_meaning, /interpreted as upzone/);
  assert.equal(buildLandRegulatoryEffectReportTarget({
    project_id: "NO-PAIR",
    actions: "ZM",
  }), null, "an unsupported interpretation has no report target");
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
