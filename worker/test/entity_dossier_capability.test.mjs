import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ENTITY_DOSSIER_AVAILABILITY,
  ENTITY_DOSSIER_CAPABILITY_REFERENCE,
  ENTITY_DOSSIER_LIMITS,
  executeEntityDossier,
} from "../../capabilities/entity_dossier.mjs";
import {
  DOSSIER_NOT_YET_PUBLIC,
  PUBLIC_DOSSIER_VERSION,
  handleEntityDossier,
  renderEntityDossierPage,
  workerD1EntityDossier,
} from "../src/entity_dossier.mjs";

const ENTITY_ID = "vendor:stem:ACME CONSTRUCTION";

function rows() {
  return [
    {
      entity_id: ENTITY_ID,
      entity_type: "vendor",
      display_name: "Acme Construction LLC",
      source_system: "checkbook",
      source_system_id: "CT-850-1",
      raw_snapshot: JSON.stringify({
        vendor_name: "Acme Construction LLC",
        agency_name: "Department of Design and Construction",
        pin: "85026B0001001",
        prime_contract_current_amount: "125.00",
        prime_contract_start_date: "01/02/2026",
        source_url: "https://www.checkbooknyc.com/contract/CT-850-1",
        evidence_json: "private-evidence-marker",
      }),
      ingested_at: "2026-08-01T09:30:00.000Z",
      link_confidence_score: 0.84,
    },
    {
      entity_id: ENTITY_ID,
      entity_type: "vendor",
      display_name: "Acme Construction LLC",
      source_system: "city_record",
      source_system_id: "20260730001",
      raw_snapshot: JSON.stringify({
        vendor_name: "Acme Construction LLC",
        agency_name: "Department of Design and Construction",
        pin: "85026B0001001",
        contract_amount: "$100.00",
        start_date: "2026-01-01",
        reviewer: "private-reviewer-marker",
      }),
      ingested_at: "2026-07-30T14:00:00.000Z",
      link_confidence_score: 0.98,
    },
  ];
}

function dbReturning(resultRows) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async all() { return { results: resultRows }; },
          };
        },
      };
    },
  };
}

function assertPublicBoundary(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /private-|0\.98|0\.84/);
  assert.doesNotMatch(serialized, /raw_snapshot|link_confidence_score/);
}

test("direct provider preserves public dossier identity, bounds, provenance, and redaction", async () => {
  const result = await executeEntityDossier(
    workerD1EntityDossier(dbReturning(rows())),
    { entityId: ENTITY_ID },
  );

  assert.equal(result.capability_reference, ENTITY_DOSSIER_CAPABILITY_REFERENCE);
  assert.equal(result.availability, "available");
  assert.equal(result.dossier.version, PUBLIC_DOSSIER_VERSION);
  assert.deepEqual(result.dossier.entity, {
    id: ENTITY_ID,
    type: "vendor",
    name: "Acme Construction LLC",
  });
  assert.equal(result.dossier.scope.record_limit, ENTITY_DOSSIER_LIMITS.recordLimit);
  assert.equal(result.dossier.scope.truncated, false);
  assert.equal(result.dossier.linked_records.length, 2);
  assert.deepEqual(result.dossier.scope.sources, ["checkbook", "city_record"]);
  assert.deepEqual(result.dossier.link_confidence_summary, {
    strong: 1,
    tentative: 1,
    not_scored: 0,
    total: 2,
  });
  const amounts = result.dossier.assertions.find(({ fact }) => fact === "contract_amount");
  assert.equal(amounts.status, "disagreement");
  assert.deepEqual(
    amounts.assertions.map(({ provenance }) => provenance.source.system),
    ["city_record", "checkbook"],
  );
  assertPublicBoundary(result);
});

test("direct provider keeps not_yet_public distinct from unavailable", async () => {
  const notYetPublic = await executeEntityDossier(
    workerD1EntityDossier(dbReturning([])),
    { entityId: "vendor:unknown" },
  );
  assert.equal(notYetPublic.availability, "not_yet_public");
  assert.equal(notYetPublic.dossier, null);

  const noStore = await executeEntityDossier(
    workerD1EntityDossier(null),
    { entityId: ENTITY_ID },
  );
  assert.equal(noStore.availability, "unavailable");
  assert.equal(noStore.error, "no-store");

  const failed = await executeEntityDossier(
    workerD1EntityDossier({ prepare() { throw new Error("fixture outage"); } }),
    { entityId: ENTITY_ID },
  );
  assert.equal(failed.availability, "unavailable");
  assert.equal(failed.error, "dossier-unavailable");
  assert.deepEqual(ENTITY_DOSSIER_AVAILABILITY, [
    "available",
    "not_yet_public",
    "unavailable",
  ]);
});

test("capability validation fails closed on identity, version, or redaction drift", async () => {
  const direct = await executeEntityDossier(
    workerD1EntityDossier(dbReturning(rows())),
    { entityId: ENTITY_ID },
  );
  const providerFor = (dossier) => ({
    capabilityReference: ENTITY_DOSSIER_CAPABILITY_REFERENCE,
    providerId: "worker-d1.entity-dossier",
    async execute() {
      return { ...direct, dossier };
    },
  });

  await assert.rejects(
    executeEntityDossier(providerFor({
      ...direct.dossier,
      entity: { ...direct.dossier.entity, id: "vendor:other" },
    }), { entityId: ENTITY_ID }),
    /identity must match/,
  );
  await assert.rejects(
    executeEntityDossier(providerFor({
      ...direct.dossier,
      version: "public_entity_dossier_v2",
    }), { entityId: ENTITY_ID }),
    /schema version drifted/,
  );
  await assert.rejects(
    executeEntityDossier(providerFor({
      ...direct.dossier,
      raw_snapshot: "private-marker",
    }), { entityId: ENTITY_ID }),
    /exposes private field/,
  );
});

test("JSON and HTML adapters are byte-compatible with the provider result", async () => {
  const db = dbReturning(rows());
  const direct = await executeEntityDossier(
    workerD1EntityDossier(db),
    { entityId: ENTITY_ID },
  );

  const jsonResponse = await handleEntityDossier(new Request(
    `https://api.cityscroll.org/entity-dossier?id=${encodeURIComponent(ENTITY_ID)}&format=json`,
  ), { DB: db });
  assert.equal(jsonResponse.status, 200);
  assert.equal(await jsonResponse.text(), JSON.stringify(direct.dossier));

  const htmlResponse = await handleEntityDossier(new Request(
    `https://api.cityscroll.org/entity-dossier?id=${encodeURIComponent(ENTITY_ID)}`,
  ), { DB: db });
  assert.equal(htmlResponse.status, 200);
  assert.equal(await htmlResponse.text(), renderEntityDossierPage(direct.dossier));
  assertPublicBoundary(await handleEntityDossier(new Request(
    `https://api.cityscroll.org/entity-dossier?id=${encodeURIComponent(ENTITY_ID)}&format=json`,
  ), { DB: db }).then((response) => response.text()));
});

test("HTTP adapter preserves not_yet_public and unavailable response bytes", async () => {
  const missing = await handleEntityDossier(new Request(
    "https://api.cityscroll.org/entity-dossier?id=vendor%3Aunknown&format=json",
  ), { DB: dbReturning([]) });
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), JSON.stringify(DOSSIER_NOT_YET_PUBLIC));

  const unavailable = await handleEntityDossier(new Request(
    `https://api.cityscroll.org/entity-dossier?id=${encodeURIComponent(ENTITY_ID)}&format=json`,
  ), { DB: { prepare() { throw new Error("fixture outage"); } } });
  assert.equal(unavailable.status, 503);
  assert.equal(await unavailable.text(), JSON.stringify({ error: "dossier-unavailable" }));
});

test("record ceiling remains enforced through direct invocation", async () => {
  const seed = rows()[0];
  const manyRows = Array.from({ length: ENTITY_DOSSIER_LIMITS.recordLimit + 1 }, (_, index) => ({
    ...seed,
    source_system_id: `CT-850-${index}`,
    ingested_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));
  const result = await executeEntityDossier(
    workerD1EntityDossier(dbReturning(manyRows)),
    { entityId: ENTITY_ID },
  );
  assert.equal(result.availability, "available");
  assert.equal(result.dossier.scope.truncated, true);
  assert.equal(result.dossier.scope.record_limit, ENTITY_DOSSIER_LIMITS.recordLimit);
  assert.equal(result.dossier.linked_records.length, ENTITY_DOSSIER_LIMITS.recordLimit);
});
