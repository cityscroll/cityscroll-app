import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ACCESS_STATES,
  CONTRACT_SUBSTANCE_ACCESS_SCHEMA,
  DOCUMENT_ROLES,
  FIXED_CONTRACT_IDS,
  REQUIRED_DOCUMENT_ROLES,
  SOURCE_CLASSES,
  accessStateDisclosure,
  admitPublicDocument,
  buildContractSubstanceAccessDocument,
  indexAccessObservations,
  normalizeAccessObservation,
  roleAccessForContract,
  validateFixedContractAccessCoverage,
} from "../site/procurement_contract_substance_access.mjs";

const MATERIALIZED = JSON.parse(readFileSync(
  new URL("../site/data/procurement_contract_substance_access.json", import.meta.url),
  "utf8",
));

const OBSERVED_AT = "2026-09-18T19:15:00.000Z";
const PUBLIC_HASH = `sha256:${"ab".repeat(32)}`;

function publicCandidate(overrides = {}) {
  return {
    contract_id: "CT107120258801626",
    document_role: DOCUMENT_ROLES.EXECUTED_CONTRACT,
    source_class: SOURCE_CLASSES.PUBLIC_RETRIEVABLE_DOCUMENT,
    source_document_id: "doc-executed-1",
    public_url: "https://www.nyc.gov/assets/example/executed-contract.pdf",
    content_hash: PUBLIC_HASH,
    publication_date: "2024-08-29",
    locator: "page 1 / section Scope",
    redistribution_authority: true,
    ...overrides,
  };
}

function roleObservation(contractId, role, accessState, overrides = {}) {
  return {
    contract_id: contractId,
    document_role: role,
    access_state: accessState,
    observed_at: OBSERVED_AT,
    checked_source_ids: ["passport-public", "checkbook-contracts", "city-record-awards"],
    source_class: accessState === ACCESS_STATES.ACCOUNT_GATED
      ? SOURCE_CLASSES.PASSPORT_AUTHENTICATED_CONTRACT
      : accessState === ACCESS_STATES.METADATA_ONLY
        ? SOURCE_CLASSES.PASSPORT_PUBLIC_METADATA
        : SOURCE_CLASSES.PUBLIC_RETRIEVABLE_DOCUMENT,
    redistribution_authority: false,
    ...overrides,
  };
}

test("A1: the four fixed contracts carry dated, source-scoped states for every required role", () => {
  assert.equal(MATERIALIZED.schema, CONTRACT_SUBSTANCE_ACCESS_SCHEMA);
  const coverage = validateFixedContractAccessCoverage(MATERIALIZED);
  assert.deepEqual(coverage, { ok: true, errors: [] });

  const indexed = indexAccessObservations(MATERIALIZED.rows);
  assert.equal(FIXED_CONTRACT_IDS.length, 4);
  for (const contractId of FIXED_CONTRACT_IDS) {
    for (const role of REQUIRED_DOCUMENT_ROLES) {
      const observation = roleAccessForContract(indexed, contractId, role);
      assert.ok(observation, `${contractId}/${role}`);
      assert.ok(Object.values(ACCESS_STATES).includes(observation.access_state));
      assert.equal(observation.observed_at, OBSERVED_AT);
      assert.ok(observation.checked_source_ids.length >= 1);
      assert.ok(observation.checked_source_ids.every((id) => typeof id === "string" && id.length > 0));
    }
  }

  // BHRAGS plus the three sub-$100k contracts stay pinned by id.
  assert.deepEqual([...FIXED_CONTRACT_IDS], [
    "CT107120258801626",
    "CT110220271400991",
    "CT105720278802113",
    "CT104020273009333",
  ]);
});

test("A2: login URLs, authenticated screenshots, analytics rows, summaries, notices, and titles cannot produce public_document", () => {
  const refusals = [
    publicCandidate({
      public_url: "https://passport.cityofnewyork.us/page.aspx/en/r/login",
    }),
    publicCandidate({
      public_url: "https://a0333-passportpublic.nyc.gov/login?ReturnUrl=%2Fcontracts.html",
    }),
    publicCandidate({
      authenticated_screenshot: true,
      evidence_kind: "authenticated_screenshot",
    }),
    publicCandidate({
      source_class: SOURCE_CLASSES.PASSPORT_PUBLIC_METADATA,
      document_role: "analytics_row",
    }),
    publicCandidate({
      document_role: "project_summary",
    }),
    publicCandidate({
      document_role: "notice_description",
    }),
    publicCandidate({
      document_role: "contract_title",
      evidence_kind: "title",
    }),
  ];

  for (const candidate of refusals) {
    const admitted = admitPublicDocument(candidate);
    assert.equal(admitted.ok, false, JSON.stringify(candidate));
    assert.equal(admitted.access_state, null);
    assert.ok(admitted.reasons.length >= 1);

    const normalized = normalizeAccessObservation({
      ...candidate,
      access_state: ACCESS_STATES.PUBLIC_DOCUMENT,
      observed_at: OBSERVED_AT,
      checked_source_ids: ["passport-public", "city-record-awards"],
    });
    assert.equal(normalized, null);
  }
});

test("A3: an admitted public_document carries identity, URL, hash, date, and locator", () => {
  const admitted = admitPublicDocument(publicCandidate());
  assert.equal(admitted.ok, true);
  assert.equal(admitted.access_state, ACCESS_STATES.PUBLIC_DOCUMENT);
  assert.deepEqual(admitted.document, {
    contract_id: "CT107120258801626",
    source_document_id: "doc-executed-1",
    public_url: "https://www.nyc.gov/assets/example/executed-contract.pdf",
    content_hash: PUBLIC_HASH,
    publication_date: "2024-08-29",
    effective_date: "2024-08-29",
    locator: "page 1 / section Scope",
    redistribution_authority: true,
  });

  const normalized = normalizeAccessObservation({
    ...publicCandidate(),
    access_state: ACCESS_STATES.PUBLIC_DOCUMENT,
    observed_at: OBSERVED_AT,
    checked_source_ids: ["city-record-awards", "checkbook-contracts"],
  });
  assert.equal(normalized.access_state, ACCESS_STATES.PUBLIC_DOCUMENT);
  assert.equal(normalized.document.source_document_id, "doc-executed-1");
  assert.equal(normalized.document.content_hash, PUBLIC_HASH);
  assert.equal(normalized.document.locator, "page 1 / section Scope");
});

test("A4: not_located stays bounded; fetch_failed never reads as no document; account access never grants redistribution", () => {
  const notLocated = normalizeAccessObservation(roleObservation(
    "CT104020273009333",
    DOCUMENT_ROLES.PERFORMANCE_EVALUATION,
    ACCESS_STATES.NOT_LOCATED,
  ));
  const notLocatedDisclosure = accessStateDisclosure(notLocated);
  assert.equal(notLocatedDisclosure.implies_no_document, false);
  assert.deepEqual(notLocatedDisclosure.checked_source_ids, notLocated.checked_source_ids);
  assert.equal(notLocatedDisclosure.observed_at, OBSERVED_AT);
  assert.equal(notLocated.absence_claim, "no_public_document_located_in_checked_sources");

  const fetchFailed = normalizeAccessObservation(roleObservation(
    "CT104020273009333",
    DOCUMENT_ROLES.EXECUTED_CONTRACT,
    ACCESS_STATES.FETCH_FAILED,
    {
      source_class: SOURCE_CLASSES.PUBLIC_RETRIEVABLE_DOCUMENT,
      checked_source_ids: ["city-record-awards"],
    },
  ));
  const fetchDisclosure = accessStateDisclosure(fetchFailed);
  assert.equal(fetchDisclosure.implies_no_document, false);
  assert.equal(fetchDisclosure.reader_basis, "retrieval_failed");
  assert.notEqual(fetchFailed.access_state, ACCESS_STATES.NOT_LOCATED);
  assert.equal(fetchFailed.absence_claim, "fetch_failed_distinct_from_absence");

  const accountGated = normalizeAccessObservation(roleObservation(
    "CT107120258801626",
    DOCUMENT_ROLES.SITE_SCHEDULE,
    ACCESS_STATES.ACCOUNT_GATED,
    { redistribution_authority: true },
  ));
  assert.equal(accountGated.redistribution_authority, false);
  const accountDisclosure = accessStateDisclosure(accountGated);
  assert.equal(accountDisclosure.implies_redistribution_authority, false);
});

test("A5: mutations of login URLs, missing identity, failed responses, and metadata-only rows prove refusal", () => {
  const basePublic = publicCandidate();

  assert.equal(admitPublicDocument({
    ...basePublic,
    public_url: "https://passport.cityofnewyork.us/page.aspx/en/r/login?ReturnUrl=%2Fcontracts",
  }).ok, false);

  assert.equal(admitPublicDocument({
    ...basePublic,
    contract_id: "",
  }).ok, false);

  assert.equal(admitPublicDocument({
    ...basePublic,
    source_document_id: null,
  }).ok, false);

  assert.equal(admitPublicDocument({
    ...basePublic,
    content_hash: "not-a-hash",
  }).ok, false);

  assert.equal(admitPublicDocument({
    ...basePublic,
    publication_date: null,
    effective_date: null,
  }).ok, false);

  assert.equal(admitPublicDocument({
    ...basePublic,
    locator: "",
  }).ok, false);

  const metadataOnly = normalizeAccessObservation(roleObservation(
    "CT110220271400991",
    DOCUMENT_ROLES.STATEMENT_OF_WORK,
    ACCESS_STATES.PUBLIC_DOCUMENT,
    {
      source_class: SOURCE_CLASSES.PASSPORT_PUBLIC_METADATA,
      document_role: "metadata",
      public_url: "https://a0333-passportpublic.nyc.gov/contracts.html",
      source_document_id: "analytics-row-1",
      content_hash: PUBLIC_HASH,
      publication_date: "2024-01-01",
      locator: "row title",
    },
  ));
  assert.equal(metadataOnly, null);

  const metadataState = normalizeAccessObservation(roleObservation(
    "CT110220271400991",
    DOCUMENT_ROLES.STATEMENT_OF_WORK,
    ACCESS_STATES.METADATA_ONLY,
  ));
  assert.equal(metadataState.access_state, ACCESS_STATES.METADATA_ONLY);
  assert.equal(metadataState.document, null);

  const failedResponse = normalizeAccessObservation(roleObservation(
    "CT105720278802113",
    DOCUMENT_ROLES.PRICING_SCHEDULE,
    ACCESS_STATES.FETCH_FAILED,
    {
      source_class: SOURCE_CLASSES.PUBLIC_RETRIEVABLE_DOCUMENT,
      checked_source_ids: ["checkbook-contracts"],
      fetch_status: 503,
    },
  ));
  assert.equal(failedResponse.access_state, ACCESS_STATES.FETCH_FAILED);
  assert.equal(accessStateDisclosure(failedResponse).implies_no_document, false);

  const built = buildContractSubstanceAccessDocument({
    rows: MATERIALIZED.rows,
    generatedAt: MATERIALIZED.generated_at,
    observationVintage: MATERIALIZED.observation_vintage,
  });
  assert.equal(validateFixedContractAccessCoverage(built).ok, true);
  assert.equal(built.rows.length, MATERIALIZED.rows.length);
});
