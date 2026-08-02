import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  DOSSIER_RECORD_LIMIT,
  PUBLIC_DOSSIER_VERSION,
  handleEntityDossier,
  readEntityDossier,
} from "../src/entity_dossier.mjs";
import {
  measurePublicEntityLinkConfidenceRate,
} from "../../entity_resolution/publication/link_confidence.mjs";

const ENTITY_ID = "vendor:stem:ACME CONSTRUCTION";

function d1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...args) {
          return {
            async all() { return { results: statement.all(...args) }; },
          };
        },
      };
    },
  };
}

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of ["0008_source_records.sql", "0009_entity_link.sql"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const observed = ["2026-07-30T14:00:00.000Z", "2026-08-01T09:30:00.000Z"];
  sqlite.prepare(
    `INSERT INTO canonical_entity
       (id, entity_type, display_name, attrs_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    ENTITY_ID,
    "vendor",
    "Acme Construction LLC",
    JSON.stringify({ private: "private-attrs-marker" }),
    observed[0],
    observed[1],
  );

  const sourceInsert = sqlite.prepare(
    `INSERT INTO source_records
       (source_system, source_system_id, content_hash, raw_snapshot, normalized_snapshot, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  sourceInsert.run(
    "city_record",
    "20260730001",
    "private-hash-marker-a",
    JSON.stringify({
      vendor_name: "Acme Construction LLC",
      agency_name: "Department of Design and Construction",
      pin: "85026B0001001",
      contract_amount: "$100.00",
      start_date: "2026-01-01",
      reviewer: "private-reviewer-marker",
    }),
    JSON.stringify({ vendor_name: "Acme Construction LLC", private: "private-normalized-marker" }),
    observed[0],
  );
  sourceInsert.run(
    "checkbook",
    "CT-850-1",
    "private-hash-marker-b",
    JSON.stringify({
      vendor_name: "Acme Construction LLC",
      agency_name: "Department of Design and Construction",
      pin: "85026B0001001",
      prime_contract_current_amount: "125.00",
      prime_contract_start_date: "01/02/2026",
      source_url: "https://www.checkbooknyc.com/contract/CT-850-1",
      evidence_json: "private-evidence-marker",
    }),
    JSON.stringify({ vendor_name: "Acme Construction LLC" }),
    observed[1],
  );

  const linkInsert = sqlite.prepare(
    `INSERT INTO entity_link
       (id, source_record_id, canonical_entity_id, decision, confidence, method,
        matcher_version, evidence_json, resolution_run_id, review_status, created_at)
     VALUES (?, ?, ?, 'auto_link', ?, ?, ?, ?, NULL, ?, ?)`,
  );
  linkInsert.run(
    "link-a",
    "city_record:20260730001:private-hash-marker-a",
    ENTITY_ID,
    0.98,
    "private-method-marker",
    "private-matcher-marker",
    "private-evidence-marker",
    "private-review-marker",
    observed[0],
  );
  linkInsert.run(
    "link-b",
    "checkbook:CT-850-1:private-hash-marker-b",
    ENTITY_ID,
    0.84,
    "private-method-marker",
    "private-matcher-marker",
    "private-evidence-marker",
    "private-review-marker",
    observed[1],
  );
  return { sqlite, env: { DB: d1(sqlite) } };
}

function fact(dossier, name) {
  return dossier.assertions.find((entry) => entry.fact === name);
}

function assertSensitivityBoundary(value) {
  const output = typeof value === "string" ? value : JSON.stringify(value);
  for (const marker of [
    "private-attrs-marker",
    "private-hash-marker",
    "private-normalized-marker",
    "private-reviewer-marker",
    "private-evidence-marker",
    "private-method-marker",
    "private-matcher-marker",
    "private-review-marker",
  ]) {
    assert.doesNotMatch(output, new RegExp(marker));
  }
  assert.doesNotMatch(output, /raw_snapshot|normalized_snapshot|content_hash|source_record_id/);
  assert.doesNotMatch(output, /matcher_version|evidence_json|resolution_run_id|review_status/);
}

test("dossier query retains conflicting assertions with public provenance", async () => {
  const { sqlite, env } = fixture();
  try {
    const dossier = await readEntityDossier(env.DB, ENTITY_ID);
    assert.equal(dossier.version, PUBLIC_DOSSIER_VERSION);
    assert.deepEqual(dossier.entity, {
      id: ENTITY_ID,
      type: "vendor",
      name: "Acme Construction LLC",
    });
    assert.deepEqual(dossier.scope.sources, ["checkbook", "city_record"]);
    assert.equal(dossier.scope.observed_from, "2026-07-30T14:00:00.000Z");
    assert.equal(dossier.scope.observed_through, "2026-08-01T09:30:00.000Z");
    assert.equal(dossier.scope.record_limit, DOSSIER_RECORD_LIMIT);
    assert.equal(dossier.scope.truncated, false);
    assert.match(dossier.scope.note, /Absence is not proof/);
    assert.equal(dossier.linked_records.length, 2);
    assert.deepEqual(dossier.linked_records[0].source, {
      system: "city_record",
      id: "20260730001",
      url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260730001",
    });
    assert.deepEqual(dossier.linked_records[0].link_confidence, {
      status: "strong",
      basis: "entity_link",
    });
    assert.deepEqual(dossier.linked_records[1].link_confidence, {
      status: "tentative",
      basis: "entity_link",
    });
    assert.deepEqual(dossier.link_confidence_summary, {
      strong: 1,
      tentative: 1,
      not_scored: 0,
      total: 2,
    });
    // Numeric desk scores must not appear on the public contract.
    assert.doesNotMatch(JSON.stringify(dossier), /0\.98|0\.84/);

    const linkMetric = measurePublicEntityLinkConfidenceRate([dossier]);
    assert.equal(linkMetric.metric, "public_entity_link_confidence_rate");
    assert.equal(linkMetric.rate, 1);
    assert.equal(linkMetric.labeled, 2);
    assert.equal(linkMetric.eligible, 2);

    const amounts = fact(dossier, "contract_amount");
    assert.equal(amounts.status, "disagreement");
    assert.deepEqual(amounts.assertions.map((assertion) => assertion.value), ["$100.00", "125.00"]);
    assert.deepEqual(
      amounts.assertions.map((assertion) => assertion.provenance.source.system),
      ["city_record", "checkbook"],
    );
    assert.deepEqual(
      amounts.assertions.map((assertion) => assertion.provenance.source_field),
      ["contract_amount", "prime_contract_current_amount"],
    );
    assert.ok(amounts.assertions.every((assertion) => assertion.derivation.status === "observed"));
    assert.ok(amounts.assertions.every((assertion) => assertion.confidence.status === "not_scored"));
    assert.ok(amounts.assertions.every((assertion) => assertion.review.status === "not_public"));

    const dueDate = fact(dossier, "due_date");
    assert.deepEqual(dueDate, {
      fact: "due_date",
      label: "Due date",
      status: "not_observed",
      assertions: [],
      missingness: "Not observed in the source records linked to this dossier.",
    });

    const derivedName = dossier.derived_assertions[0];
    assert.equal(derivedName.classification, "derived_conclusion");
    assert.equal(derivedName.derivation.status, "derived");
    assert.equal(derivedName.derivation.evidence_assertion_ids.length, 2);
    assert.equal(derivedName.confidence.status, "not_published");
    assertSensitivityBoundary(dossier);
  } finally {
    sqlite.close();
  }
});

test("public dossier route serves JSON and an attributed disagreement page", async () => {
  const { sqlite, env } = fixture();
  try {
    const response = await handleEntityDossier(new Request(
      `https://api.cityscroll.org/entity-dossier?id=${encodeURIComponent(ENTITY_ID)}&format=json`,
    ), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const dossier = await response.json();
    assert.equal(fact(dossier, "start_date").status, "disagreement");
    assertSensitivityBoundary(dossier);

    const htmlResponse = await handleEntityDossier(new Request(
      `https://api.cityscroll.org/entity-dossier?id=${encodeURIComponent(ENTITY_ID)}`,
    ), env);
    assert.equal(htmlResponse.status, 200);
    const html = await htmlResponse.text();
    assert.match(html, /Acme Construction LLC/);
    assert.match(html, /Linked sources report different values/);
    assert.match(html, /Source assertion/);
    assert.match(html, /Derived conclusion/);
    assert.match(html, /CityScroll display name \(not a publisher field\)/);
    assert.match(html, /Not observed/);
    assert.match(html, /Absence is not proof/);
    assert.match(html, /Explore typed public relationships/);
    assert.match(html, /\/entity-relationships\?id=vendor%3Astem%3AACME%20CONSTRUCTION/);
    assert.match(html, /Strong link/);
    assert.match(html, /Tentative link/);
    assert.match(html, /data-link-confidence-summary/);
    assert.match(html, /1 strong · 1 tentative/);
    assert.match(html, /match strength \(strong vs tentative\)/);
    assert.doesNotMatch(html, /0\.98|0\.84|98%|84%/);
    assertSensitivityBoundary(html);
  } finally {
    sqlite.close();
  }
});

test("dossier route fails closed for missing, unknown, and injected ids", async () => {
  const { sqlite, env } = fixture();
  try {
    assert.equal((await handleEntityDossier(
      new Request("https://api.cityscroll.org/entity-dossier"), env,
    )).status, 400);
    assert.equal((await handleEntityDossier(
      new Request("https://api.cityscroll.org/entity-dossier?id=vendor%3Aunknown"), env,
    )).status, 404);
    assert.equal((await handleEntityDossier(
      new Request("https://api.cityscroll.org/entity-dossier?id=%27%20OR%201%3D1--"), env,
    )).status, 404);
    assert.equal((await handleEntityDossier(
      new Request(`https://api.cityscroll.org/entity-dossier?id=${encodeURIComponent(ENTITY_ID)}`, { method: "POST" }), env,
    )).status, 405);
  } finally {
    sqlite.close();
  }
});

test("dossier unknown id returns not_yet_public — never markets empty 404 as live dossier", async () => {
  const { sqlite, env } = fixture();
  try {
    // Name-shaped / contract subject-registry ids used on demos are not canonical entity ids.
    for (const id of [
      "vendor:name:camba inc",
      "contract:CT126020278800692",
      "vendor:unknown",
    ]) {
      const response = await handleEntityDossier(
        new Request(`https://api.cityscroll.org/entity-dossier?id=${encodeURIComponent(id)}&format=json`),
        env,
      );
      assert.equal(response.status, 404, id);
      const body = await response.json();
      assert.equal(body.error, "not-found");
      assert.equal(body.public_status, "not_yet_public");
      assert.match(body.message || "", /not yet public|subject-registry|canonical/i);
    }
  } finally {
    sqlite.close();
  }
});
