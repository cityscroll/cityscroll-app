import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  describeContract,
  FORBIDDEN_PRIVATE_FIELDS,
  inspectForbiddenFields,
  inspectPathIdentityAgreement,
  inspectPublicIdentity,
  inspectPublicReference,
  inspectRawIdentityEscapes,
  isPublicAliasIdentity,
  PUBLIC_ALIAS_PATTERN,
  PUBLIC_NAMESPACE,
  REFERENCE_SCHEME,
} from "../tools/public_identity_contract.mjs";
import {
  aggregateArchitectureEvidence,
  entryRelativePath,
} from "../tools/architecture_evidence_shards.mjs";
import { scanPublicIdentityContract } from "../tools/inverse_control_plane_guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readRepo(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

test("the contract is a stated, versioned, public artifact", () => {
  const contract = describeContract();
  assert.equal(contract.namespace, "cityscroll-engineering");
  assert.equal(contract.reference_scheme, "engineering-record");
  assert.equal(contract.contract, "cityscroll.public-engineering-record-identity.v1");
});

test("a descriptive public identity is accepted", () => {
  for (const id of [
    `${PUBLIC_NAMESPACE}/shared-dependency-store`,
    `${PUBLIC_NAMESPACE}/working-copy-footprint`,
    `${PUBLIC_NAMESPACE}/default-reduced-card-work-profile`,
    `${PUBLIC_NAMESPACE}/living-architecture-narrative`,
  ]) {
    assert.deepEqual(inspectPublicIdentity(id, { path: "fixture.json", field: "id" }), [], id);
  }
});

test("a public identity that encodes a queue position is rejected", () => {
  for (const id of [
    `${PUBLIC_NAMESPACE}/ci-10`,
    `${PUBLIC_NAMESPACE}/ci-07-shared-dependency-store`,
    `${PUBLIC_NAMESPACE}/07`,
    `${PUBLIC_NAMESPACE}/work-item-42`,
  ]) {
    const violations = inspectPublicIdentity(id, { path: "fixture.json", field: "id" });
    assert.equal(violations.length, 1, id);
    assert.equal(violations[0].rule, "public-identity-form");
  }
});

test("the rule-6 fallback token is accepted where no descriptive name exists yet", () => {
  const id = `${PUBLIC_NAMESPACE}/c109ded0b4e91`;
  assert.deepEqual(inspectPublicIdentity(id, { path: "fixture.json", field: "id" }), []);
  assert.ok(isPublicAliasIdentity(id));
  assert.match("c109ded0b4e91", PUBLIC_ALIAS_PATTERN);
});

test("a near-miss token is not read as the fallback shape", () => {
  assert.equal(isPublicAliasIdentity(`${PUBLIC_NAMESPACE}/c109ded0b4e9`), false); // one hex short
  assert.equal(isPublicAliasIdentity(`${PUBLIC_NAMESPACE}/c109ded0b4e9111`), false); // one hex long
  assert.equal(isPublicAliasIdentity(`${PUBLIC_NAMESPACE}/shared-dependency-store`), false);
  assert.equal(isPublicAliasIdentity("some-other-namespace/c109ded0b4e91"), false);
});

test("a card id or workstream slug placed inside the public namespace is still rejected", () => {
  for (const id of [
    `${PUBLIC_NAMESPACE}/xy-03-a-descriptive-tail`,
    `${PUBLIC_NAMESPACE}/ab-02-another-descriptive-tail`,
  ]) {
    const violations = inspectPublicIdentity(id, { path: "fixture.json", field: "id" });
    assert.equal(violations.length, 1, id);
    assert.equal(violations[0].rule, "public-identity-form");
  }
});

test("an identity outside the public namespace is not this contract's business", () => {
  assert.deepEqual(
    inspectPublicIdentity("some-other-namespace/anything-at-all", { path: "f.json", field: "id" }),
    [],
  );
});

test("a well-formed cross-boundary reference is accepted and a malformed one is rejected", () => {
  const good = `${REFERENCE_SCHEME}:${PUBLIC_NAMESPACE}/living-architecture-narrative#home-wire-budget-rationale`;
  assert.deepEqual(inspectPublicReference(good, { path: "f.json", field: "stable_replacement_reference" }), []);

  const bad = `${REFERENCE_SCHEME}:some-other-namespace/thing`;
  const violations = inspectPublicReference(bad, { path: "f.json", field: "stable_replacement_reference" });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "public-reference-form");
});

test("an escaped identity field is rejected even though it parses to a legal identity", () => {
  const escaped = '{\n  "id": "cityscroll-\\u0065ngineering/shared-dependency-store"\n}';
  assert.equal(JSON.parse(escaped).id, `${PUBLIC_NAMESPACE}/shared-dependency-store`);
  const violations = inspectRawIdentityEscapes(escaped, { path: "fixture.json", fields: ["id"] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "escaped-identity-field");
});

test("a plainly spelled identity field passes the escape rule", () => {
  const plain = '{\n  "id": "cityscroll-engineering/shared-dependency-store"\n}';
  assert.deepEqual(inspectRawIdentityEscapes(plain, { path: "fixture.json", fields: ["id"] }), []);
});

test("a violation message never echoes the value it rejected", () => {
  const escaped = '{"id": "cityscroll-\\u0065ngineering/shared-dependency-store"}';
  const [violation] = inspectRawIdentityEscapes(escaped, { path: "fixture.json", fields: ["id"] });
  assert.ok(!JSON.stringify(violation).includes("shared-dependency-store"));
});

test("a private source id or alias mapping is not a valid public field", () => {
  for (const field of FORBIDDEN_PRIVATE_FIELDS) {
    const violations = inspectForbiddenFields({ [field]: "anything" }, { path: "fixture.json" });
    assert.equal(violations.length, 1, field);
    assert.equal(violations[0].rule, "private-field-in-public-document");
  }
});

test("forbidden fields are found at any depth", () => {
  const violations = inspectForbiddenFields(
    { entries: [{ meta: { private_record: "x" } }] },
    { path: "fixture.json" },
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].field, "entries[0].meta.private_record");
});

test("a path that does not decode to the declared identity is rejected", () => {
  const id = `${PUBLIC_NAMESPACE}/shared-dependency-store`;
  assert.deepEqual(inspectPathIdentityAgreement({ path: entryRelativePath(id), id, expectedPath: entryRelativePath(id) }), []);
  const violations = inspectPathIdentityAgreement({
    path: "architecture/evidence.d/something-else.json",
    id,
    expectedPath: entryRelativePath(id),
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "path-identity-mismatch");
});

test("the aggregator applies the contract to every committed entry", () => {
  const result = aggregateArchitectureEvidence({ root: ROOT });
  assert.equal(result.status, "PASS", result.findings.join("; "));
  for (const entry of result.entries) {
    assert.deepEqual(inspectPublicIdentity(entry.id, { path: entry._path, field: "id" }), [], entry.id);
    assert.equal(entry._path, entryRelativePath(entry.id));
  }
});

test("the migrated engineering records are present, plainly spelled, and path-consistent", () => {
  const expected = [
    `${PUBLIC_NAMESPACE}/shared-dependency-store`,
    `${PUBLIC_NAMESPACE}/working-copy-footprint`,
    // Landed separately, on its own branch. Asserted here because the boundary is
    // a property of the whole registry, not of the entries one change happens to
    // rename: a second change adopting the namespace must meet the same contract.
    `${PUBLIC_NAMESPACE}/default-reduced-card-work-profile`,
  ];
  for (const id of expected) {
    const path = entryRelativePath(id);
    const text = readRepo(path);
    assert.equal(JSON.parse(text).id, id);
    assert.deepEqual(inspectRawIdentityEscapes(text, { path, fields: ["id"] }), []);
  }
});

test("the migrated records keep their implementation status and projections", () => {
  const store = JSON.parse(readRepo(entryRelativePath(`${PUBLIC_NAMESPACE}/shared-dependency-store`)));
  assert.equal(store.status, "implemented");
  assert.equal(store.fingerprint, "ci-07-shared-dependency-store.v1");
  assert.ok(store.projections.some((row) => row.path === "worker/pnpm-lock.yaml"));

  const footprint = JSON.parse(readRepo(entryRelativePath(`${PUBLIC_NAMESPACE}/working-copy-footprint`)));
  assert.equal(footprint.status, "implemented");
  assert.equal(footprint.fingerprint, "ci-09-act-working-copy-footprint.v1");
  assert.ok(footprint.projections.some((row) => row.path === "tools/card-profile/closure.v1.json"));
});

test("the classification inventory references engineering records, not private registers", () => {
  const path = "docs/repository-control-plane/classification.v1.json";
  const text = readRepo(path);
  const document = JSON.parse(text);
  const referencing = document.entries.filter((row) => row.register_id.startsWith(`${PUBLIC_NAMESPACE}/`));
  assert.ok(referencing.length >= 3);
  for (const row of referencing) {
    assert.deepEqual(inspectPublicIdentity(row.register_id, { path, field: "register_id" }), [], row.id);
    assert.deepEqual(
      inspectPublicReference(row.stable_replacement_reference, { path, field: "stable_replacement_reference" }),
      [],
      row.id,
    );
  }
  assert.deepEqual(inspectForbiddenFields(document, { path }), []);
});

test("the boundary check applies the contract to public JSON documents", () => {
  const offending = JSON.stringify({ id: `${PUBLIC_NAMESPACE}/ci-10` }, null, 2);
  const findings = scanPublicIdentityContract({ path: "fixture.json", text: offending });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "public-identity-contract");

  const clean = JSON.stringify({ id: `${PUBLIC_NAMESPACE}/default-reduced-card-work-profile` }, null, 2);
  assert.deepEqual(scanPublicIdentityContract({ path: "fixture.json", text: clean }), []);
});

test("a document that never mentions the namespace is not parsed by the contract check", () => {
  assert.deepEqual(scanPublicIdentityContract({ path: "fixture.json", text: "{ not valid json" }), []);
});

test("the public architecture-evidence contract no longer equates entry ids with development records", () => {
  const readme = readRepo("architecture/evidence.d/README.md");
  assert.match(readme, /stable public change or engineering-record identity/i);
  assert.match(readme, /not part of the public schema/i);
  assert.match(readme, /machine schema names kept/i);
  assert.ok(!/Entry `id` is the card id/i.test(readme));
});
