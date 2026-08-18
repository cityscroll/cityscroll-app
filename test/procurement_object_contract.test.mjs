import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PROCUREMENT_OBJECT_SCHEMA,
  auditProcurementIdentityGate,
  buildProcurementObjects,
  procurementCanonicalHref,
  resolveProcurementRoute,
} from "../site/procurement_object_contract.mjs";

function sourceRecord(sourceSystem, sourceSystemId, snapshot, ingestedAt = "2026-08-18T19:46:32Z") {
  return {
    source_system: sourceSystem,
    source_system_id: sourceSystemId,
    content_hash: `${sourceSystemId}-hash`,
    normalized_snapshot: JSON.stringify(snapshot),
    raw_snapshot: JSON.stringify(snapshot),
    ingested_at: ingestedAt,
  };
}

const passport = sourceRecord(
  "passport_public_contracts",
  "contract:84126P0001001:CTR-NON-CROL-77",
  {
    ctr_id: "CTR-NON-CROL-77",
    epin: "84126P0001001",
    contract_id: "CT1841260001",
    title: "Bridge inspection",
    vendor: "HNTB Corporation",
    registration_date: "2026-07-20",
  },
);

const checkbook = sourceRecord(
  "checkbook_contracts",
  "contract:registered:CT1841260001:HNTB CORPORATION:prime-vendor:2026-07-20",
  {
    id: "CT1841260001",
    pin: "84126P0001001",
    title: "Bridge inspection",
    vendor: "HNTB Corporation",
    status: "registered",
    registered: "2026-07-20",
  },
);

test("procurement is a registered observation-fed aggregate object", () => {
  const registry = JSON.parse(readFileSync(new URL("../ontology/registry.v0.json", import.meta.url), "utf8"));
  const procurement = registry.object_types.find((entry) => entry.id === "procurement");
  assert.equal(procurement?.status, "registered");
  assert.equal(procurement?.identity_contract?.schema, PROCUREMENT_OBJECT_SCHEMA);
  assert.equal(procurement?.identity_contract?.observation_fed, true);
  assert.equal(procurement?.identity_contract?.city_record_constructor, false);
  assert.equal(procurement?.identity_contract?.descriptive_identity_forbidden, true);
});

test("CROL-negative exact observations construct one canonical procurement object", () => {
  const result = buildProcurementObjects({ sourceRecords: [passport, checkbook] });
  assert.equal(result.identity_gate.ok, true);
  assert.equal(result.objects.length, 1);

  const [object] = result.objects;
  assert.equal(object.schema, PROCUREMENT_OBJECT_SCHEMA);
  assert.equal(object.object_type, "procurement");
  assert.equal(object.procurement_id, "procurement:contract:CT1841260001");
  assert.deepEqual(object.source_observation_refs, [
    `checkbook_contracts:${checkbook.source_system_id}`,
    `passport_public_contracts:${passport.source_system_id}`,
  ]);
  assert.deepEqual(object.stages.map((stage) => stage.stage), ["registered"]);
  assert.equal(Object.hasOwn(object, "title"), false, "notice-like fields stay on observations");
  assert.equal(Object.hasOwn(object, "vendor"), false, "descriptive fields are not flattened");
  assert.ok(result.identity_edges.every((edge) => edge.status === "accepted"));
  assert.ok(result.identity_edges.every((edge) => edge.basis.startsWith("exact_")));
  assert.ok(result.cross_source_identity_joins.length > 0);
  assert.ok(result.cross_source_identity_joins.every((join) => join.status === "accepted"));
  assert.ok(result.cross_source_identity_joins.every((join) => join.basis === "exact_contract_id"));
  assert.equal(
    procurementCanonicalHref(object),
    "/procurements/procurement%3Acontract%3ACT1841260001",
  );
  assert.equal(resolveProcurementRoute(procurementCanonicalHref(object), result.objects), object);
});

test("same title, vendor, and date never create identity", () => {
  const other = sourceRecord(
    "checkbook_contracts",
    "contract:registered:CT-DISTINCT:HNTB CORPORATION:prime-vendor:2026-07-20",
    {
      id: "CT-DISTINCT",
      pin: "EPIN-DISTINCT",
      title: "Bridge inspection",
      vendor: "HNTB Corporation",
      status: "registered",
      registered: "2026-07-20",
    },
  );
  const result = buildProcurementObjects({ sourceRecords: [checkbook, other] });
  assert.deepEqual(result.objects.map((row) => row.procurement_id), [
    "procurement:contract:CT1841260001",
    "procurement:contract:CTDISTINCT",
  ]);
  assert.deepEqual(result.cross_source_identity_joins, []);
});

test("one EPIN spanning multiple contract IDs stays split and holds EPIN-only stages", () => {
  const first = sourceRecord(
    "checkbook_contracts",
    "contract:registered:CT-ONE:VENDOR:prime-vendor:2026-07-20",
    { id: "CT-ONE", pin: "SHARED-EPIN", status: "registered" },
  );
  const second = sourceRecord(
    "checkbook_contracts",
    "contract:registered:CT-TWO:VENDOR:prime-vendor:2026-07-20",
    { id: "CT-TWO", pin: "SHARED-EPIN", status: "registered" },
  );
  const rfx = sourceRecord(
    "passport_public_rfx",
    "rfx:SHAREDEPIN:RFX-AMBIGUOUS",
    { rfp_id: "RFX-AMBIGUOUS", epin: "SHARED-EPIN", title: "Same procurement" },
  );
  const result = buildProcurementObjects({ sourceRecords: [first, second, rfx] });
  assert.deepEqual(result.objects.map((row) => row.procurement_id), [
    "procurement:contract:CTONE",
    "procurement:contract:CTTWO",
    `procurement:source:passport_public_rfx:${rfx.source_system_id}`,
  ]);
  assert.equal(result.objects.some((row) => row.source_observation_refs.length > 1), false);
  assert.equal(
    result.identity_edges.find((edge) => edge.source_observation_ref.endsWith(rfx.source_system_id))?.basis,
    "exact_publisher_source_id",
  );
});

test("City Record compatibility is evidence only and never constructs identity", () => {
  const cityRecord = sourceRecord("city_record", "20260723001", {
    request_id: "20260723001",
    pin: "84126P0001001",
    short_title: "Bridge inspection",
  });
  const alone = buildProcurementObjects({ sourceRecords: [cityRecord] });
  assert.deepEqual(alone.objects, []);
  assert.equal(alone.identity_edges.length, 0);

  const joined = buildProcurementObjects({ sourceRecords: [passport, cityRecord] });
  assert.equal(joined.objects.length, 1);
  assert.ok(joined.objects[0].source_observation_refs.includes("city_record:20260723001"));
  assert.equal(resolveProcurementRoute("/notices/20260723001", joined.objects), null);
  assert.deepEqual(joined.objects[0].compatibility.city_record_notice_hrefs, [
    "/notices/20260723001",
  ]);
});

test("identity audit fails closed below stable-id or exact-join thresholds", () => {
  const unstable = Array.from({ length: 20 }, (_, index) => sourceRecord(
    "checkbook_contracts",
    index === 0 ? "" : `contract:registered:CT-${index}:VENDOR:prime-vendor:2026-01-01`,
    index === 0 ? { vendor: "No ID" } : { id: `CT-${index}`, status: "registered" },
  ));
  const audit = auditProcurementIdentityGate(unstable);
  assert.equal(audit.stable_source_id_rate, 0.95);
  assert.equal(audit.exact_join_precision, 1);
  assert.equal(audit.ok, true);

  const failed = auditProcurementIdentityGate([
    ...unstable,
    sourceRecord("checkbook_contracts", "", { vendor: "A second missing ID" }),
  ]);
  assert.equal(failed.ok, false);
  assert.throws(
    () => buildProcurementObjects({ sourceRecords: [...unstable, sourceRecord("checkbook_contracts", "", {})] }),
    /procurement identity audit gate failed/,
  );
});
