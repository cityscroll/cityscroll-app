import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  PERSON_IDENTITY_LINK_METHOD,
  PERSON_IDENTITY_LINK_SCHEMA,
  projectCommunityBoardPersonAlias,
} from "../ontology/person.mjs";
import {
  PERSON_IDENTITY_LINK_LEDGER_PATH,
  PERSON_IDENTITY_LINK_LEDGER_SCHEMA,
  appendPersonIdentityLink,
  applyPersonIdentityLinkLedger,
  checkPersonIdentityLinkLedger,
  formatPersonIdentityLinkLedgerFindings,
  materializeCanonicalPersonRefs,
  openPersonIdentityLinkLedger,
  parsePersonIdentityLinkLedger,
  personIdentityLinkLedgerDiagnostics,
  personIdentityLinkRecords,
  readPersonIdentityLinkLedger,
} from "../ontology/person_identity_link_ledger.mjs";

const CHECK_TOOL = fileURLToPath(new URL("../tools/check_person_identity_link_ledger.mjs", import.meta.url));

const LEFT = "person:legistar:7801";
const RIGHT = "person:community-board:manhattan-cb-06:jane-001";
const CANONICAL = "person:reviewed:jane-doe-001";
const OPENED_AT = "2026-09-01T00:00:00Z";

const EVIDENCE = Object.freeze([{
  source_ref: "review:person-identity:001",
  source_url: "https://example.test/review/person-identity-001",
  excerpt: "The reviewed source records identify the same individual.",
  observed_at: "2026-08-20T12:00:00Z",
  fields: ["publisher_person_id"],
}]);

function withLedger(run) {
  const root = mkdtempSync(join(tmpdir(), "crol-person-link-ledger-"));
  const path = join(root, "person_identity_links.jsonl");
  try {
    openPersonIdentityLinkLedger({ path, openedAt: OPENED_AT });
    return run(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function storedRecords(path) {
  return personIdentityLinkRecords(readPersonIdentityLinkLedger(path).entries);
}

function checkLedger(path) {
  return checkPersonIdentityLinkLedger(readPersonIdentityLinkLedger(path).entries);
}

function codes(result) {
  return result.findings.map(({ code }) => code);
}

/** Append a hand-written line so the check sees a record the writer would refuse. */
function appendRaw(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

function malformedRecord(overrides) {
  return {
    schema: PERSON_IDENTITY_LINK_SCHEMA,
    version: "1.0.0",
    left_identity: LEFT,
    right_identity: RIGHT,
    relation: "same_person",
    status: "accepted",
    method: PERSON_IDENTITY_LINK_METHOD,
    evidence: EVIDENCE,
    observed_at: "2026-08-21T12:00:00Z",
    reviewed_at: "2026-08-22T12:00:00Z",
    canonical_person_ref: CANONICAL,
    provenance: { evidence_count: 1, evidence_refs: ["review:person-identity:001"], review_required: true },
    record_kind: "identity_link",
    record_id: "pil-0001",
    appended_at: "2026-09-02T00:00:00Z",
    reviewer: "identity-review-desk",
    review_note: null,
    ...overrides,
  };
}

test("the committed ledger is header-first, append-only, and passes its own check", () => {
  const ledger = readPersonIdentityLinkLedger(PERSON_IDENTITY_LINK_LEDGER_PATH);
  assert.equal(ledger.exists, true);
  const [header] = ledger.entries;
  assert.equal(header.line, 1);
  assert.equal(header.record.schema, PERSON_IDENTITY_LINK_LEDGER_SCHEMA);
  assert.equal(header.record.link_schema, PERSON_IDENTITY_LINK_SCHEMA);
  assert.equal(header.record.policy.append_only, true);
  assert.equal(header.record.policy.accepted_only_canonical_person_ref, true);
  assert.equal(header.record.policy.method, PERSON_IDENTITY_LINK_METHOD);

  const result = checkPersonIdentityLinkLedger(ledger.entries);
  assert.deepEqual(codes(result), []);
  assert.equal(result.ok, true);
});

test("the writer appends reviewed records and never rewrites a stored decision", () => {
  withLedger((path) => {
    appendPersonIdentityLink({
      path,
      recordId: "pil-0001",
      appendedAt: "2026-09-02T00:00:00Z",
      reviewer: "identity-review-desk",
      reviewNote: "Opened for review.",
      leftIdentity: LEFT,
      rightIdentity: RIGHT,
      status: "candidate",
      evidence: EVIDENCE,
      observedAt: "2026-08-21T12:00:00Z",
    });
    const afterFirst = readFileSync(path, "utf8");

    appendPersonIdentityLink({
      path,
      recordId: "pil-0002",
      appendedAt: "2026-09-03T00:00:00Z",
      reviewer: "identity-review-desk",
      leftIdentity: LEFT,
      rightIdentity: RIGHT,
      status: "accepted",
      evidence: EVIDENCE,
      observedAt: "2026-08-21T12:00:00Z",
      reviewedAt: "2026-09-03T00:00:00Z",
      canonicalPersonRef: CANONICAL,
    });
    const afterSecond = readFileSync(path, "utf8");

    assert.ok(afterSecond.startsWith(afterFirst), "an append must leave earlier lines byte-identical");
    const records = storedRecords(path);
    assert.deepEqual(records.map(({ record_id: id }) => id), ["pil-0001", "pil-0002"]);
    assert.deepEqual(records.map(({ status }) => status), ["candidate", "accepted"]);
    assert.deepEqual(records.map(({ ledger_line: line }) => line), [2, 3]);
    assert.equal(records[0].method, PERSON_IDENTITY_LINK_METHOD);
    assert.equal(records[0].pair_key, records[1].pair_key);
    assert.deepEqual(codes(checkLedger(path)), []);

    assert.throws(
      () => appendPersonIdentityLink({
        path,
        recordId: "pil-0002",
        appendedAt: "2026-09-04T00:00:00Z",
        reviewer: "identity-review-desk",
        leftIdentity: LEFT,
        rightIdentity: RIGHT,
        status: "rejected",
        evidence: EVIDENCE,
        observedAt: "2026-08-21T12:00:00Z",
        reviewedAt: "2026-09-04T00:00:00Z",
      }),
      /already stored/,
    );
    assert.throws(
      () => openPersonIdentityLinkLedger({ path, openedAt: OPENED_AT }),
      /opened once/,
    );
    assert.equal(readFileSync(path, "utf8"), afterSecond);
  });
});

test("the check refuses a method that is not the reviewed assertion", () => {
  withLedger((path) => {
    appendRaw(path, malformedRecord({ method: "name_similarity" }));
    const result = checkLedger(path);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), ["method_not_reviewed_assertion"]);
    assert.match(
      formatPersonIdentityLinkLedgerFindings(result.findings, "ledger.jsonl"),
      /^ledger\.jsonl:2 \[method_not_reviewed_assertion\] pil-0001: method must be explicit_reviewed_assertion, found name_similarity$/,
    );
  });
});

test("the check refuses evidence with no source locator", () => {
  withLedger((path) => {
    appendRaw(path, malformedRecord({
      record_id: "pil-0001",
      evidence: [{ excerpt: "Both records show the same name." }],
    }));
    appendRaw(path, malformedRecord({
      record_id: "pil-0002",
      appended_at: "2026-09-03T00:00:00Z",
      right_identity: "person:community-board:queens-cb-07:jane-001",
      evidence: [],
    }));
    const result = checkLedger(path);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), ["evidence_source_locator_missing", "evidence_missing"]);
    assert.deepEqual(result.findings.map(({ line }) => line), [2, 3]);
  });
});

test("the check refuses display names and non-generic endpoint ids", () => {
  withLedger((path) => {
    appendRaw(path, malformedRecord({ record_id: "pil-0001", left_identity: "Ada Lovelace" }));
    appendRaw(path, malformedRecord({
      record_id: "pil-0002",
      appended_at: "2026-09-03T00:00:00Z",
      left_identity: "official:7801",
      right_identity: "community-board-person:manhattan-cb-06:jane-001",
    }));
    const result = checkLedger(path);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), [
      "endpoint_not_generic_person_id",
      "endpoint_not_generic_person_id",
      "endpoint_not_generic_person_id",
    ]);
    assert.match(result.findings[0].message, /left_identity must be a generic person identity, found "Ada Lovelace"/);
    assert.deepEqual(result.findings.slice(1).map(({ line }) => line), [3, 3]);
  });
});

test("only an accepted current record materializes a canonical person reference", () => {
  withLedger((path) => {
    appendPersonIdentityLink({
      path,
      recordId: "pil-0001",
      appendedAt: "2026-09-02T00:00:00Z",
      reviewer: "identity-review-desk",
      leftIdentity: LEFT,
      rightIdentity: RIGHT,
      status: "candidate",
      evidence: EVIDENCE,
      observedAt: "2026-08-21T12:00:00Z",
      canonicalPersonRef: CANONICAL,
    });

    const boardPerson = projectCommunityBoardPersonAlias({
      boardId: "manhattan-cb-06",
      personKey: "jane-001",
      displayName: "Ada Lovelace",
    });
    assert.equal(boardPerson.canonical_person_ref, null);

    const candidateOnly = storedRecords(path);
    assert.equal(candidateOnly[0].canonical_person_ref, null, "a candidate never carries a canonical reference");
    assert.equal(materializeCanonicalPersonRefs(candidateOnly).size, 0);
    assert.equal(applyPersonIdentityLinkLedger(boardPerson, candidateOnly).canonical_person_ref, null);

    appendPersonIdentityLink({
      path,
      recordId: "pil-0002",
      appendedAt: "2026-09-03T00:00:00Z",
      reviewer: "identity-review-desk",
      leftIdentity: LEFT,
      rightIdentity: RIGHT,
      status: "accepted",
      evidence: EVIDENCE,
      observedAt: "2026-08-21T12:00:00Z",
      reviewedAt: "2026-09-03T00:00:00Z",
      canonicalPersonRef: CANONICAL,
    });

    const accepted = storedRecords(path);
    assert.deepEqual([...materializeCanonicalPersonRefs(accepted)], [[LEFT, CANONICAL], [RIGHT, CANONICAL]]);
    const linked = applyPersonIdentityLinkLedger(boardPerson, accepted);
    assert.equal(linked.canonical_person_ref, CANONICAL);
    assert.equal(linked.source_alias.identity, "community-board-person:manhattan-cb-06:jane-001",
      "an accepted link keeps the source identity addressable");

    appendPersonIdentityLink({
      path,
      recordId: "pil-0003",
      appendedAt: "2026-09-04T00:00:00Z",
      reviewer: "identity-review-desk",
      reviewNote: "Reversed on further review of the source records.",
      leftIdentity: LEFT,
      rightIdentity: RIGHT,
      status: "rejected",
      evidence: EVIDENCE,
      observedAt: "2026-08-21T12:00:00Z",
      reviewedAt: "2026-09-04T00:00:00Z",
    });

    const reversed = storedRecords(path);
    assert.equal(reversed.length, 3, "the superseded accepted record stays on disk");
    assert.equal(materializeCanonicalPersonRefs(reversed).size, 0);
    assert.equal(applyPersonIdentityLinkLedger(boardPerson, reversed).canonical_person_ref, null);
    assert.deepEqual(codes(checkLedger(path)), []);
  });
});

test("the check refuses a canonical reference on a candidate or rejected record", () => {
  withLedger((path) => {
    appendRaw(path, malformedRecord({ record_id: "pil-0001", status: "candidate" }));
    appendRaw(path, malformedRecord({
      record_id: "pil-0002",
      appended_at: "2026-09-03T00:00:00Z",
      status: "rejected",
    }));
    const result = checkLedger(path);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), ["canonical_ref_on_non_accepted", "canonical_ref_on_non_accepted"]);
  });
});

test("candidate and rejected records stay inspectable as non-linking evidence", () => {
  withLedger((path) => {
    appendPersonIdentityLink({
      path,
      recordId: "pil-0001",
      appendedAt: "2026-09-02T00:00:00Z",
      reviewer: "identity-review-desk",
      leftIdentity: LEFT,
      rightIdentity: RIGHT,
      status: "candidate",
      evidence: EVIDENCE,
      observedAt: "2026-08-21T12:00:00Z",
    });
    appendPersonIdentityLink({
      path,
      recordId: "pil-0002",
      appendedAt: "2026-09-03T00:00:00Z",
      reviewer: "identity-review-desk",
      reviewNote: "The two records describe different people.",
      leftIdentity: LEFT,
      rightIdentity: "person:community-board:queens-cb-07:jane-001",
      status: "rejected",
      evidence: EVIDENCE,
      observedAt: "2026-08-21T12:00:00Z",
      reviewedAt: "2026-09-03T00:00:00Z",
    });

    const diagnostics = personIdentityLinkLedgerDiagnostics(storedRecords(path));
    assert.equal(diagnostics.total, 2);
    assert.equal(diagnostics.accepted.length, 0);
    assert.equal(diagnostics.candidate.length, 1);
    assert.equal(diagnostics.rejected.length, 1);
    assert.equal(diagnostics.non_linking.length, 2);
    assert.equal(diagnostics.materialized.length, 0);
    for (const row of diagnostics.rows) {
      assert.equal(row.linking, false);
      assert.equal(row.canonical_person_ref, null);
      assert.deepEqual(row.evidence_refs, ["review:person-identity:001"]);
      assert.equal(row.reviewer, "identity-review-desk");
    }

    const listing = spawnSync(process.execPath, [CHECK_TOOL, "--diagnostics", "--ledger", path], { encoding: "utf8" });
    assert.equal(listing.status, 0);
    assert.match(listing.stdout, /accepted 0, candidate 1, rejected 1/);
    assert.match(listing.stdout, /pil-0001 candidate \(current\/non-linking\)/);
    assert.match(listing.stdout, /pil-0002 rejected \(current\/non-linking\)/);
    assert.match(listing.stdout, /canonical_person_ref=none/);
    assert.match(listing.stdout, /materialized canonical references: 0/);
  });
});

test("the check command exits zero on a clean ledger and non-zero on each violation", () => {
  const clean = spawnSync(process.execPath, [CHECK_TOOL, "--check"], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /reviewed identity-link ledger ok/);

  withLedger((path) => {
    appendRaw(path, malformedRecord({
      record_id: "pil-0001",
      method: "unique_name_match",
      left_identity: "Ada Lovelace",
      evidence: [{ excerpt: "Same name on both rosters." }],
    }));
    const dirty = spawnSync(process.execPath, [CHECK_TOOL, "--check", "--ledger", path], { encoding: "utf8" });
    assert.equal(dirty.status, 1);
    const lines = dirty.stderr.trim().split("\n");
    assert.equal(lines.length, 4, dirty.stderr);
    assert.match(lines[0], /\[method_not_reviewed_assertion\]/);
    assert.match(lines[1], /\[endpoint_not_generic_person_id\]/);
    assert.match(lines[2], /\[evidence_source_locator_missing\]/);
    assert.match(lines[3], /3 violation\(s\) in 1 stored link record\(s\)/);
  });
});

test("the check refuses a ledger with no header and an unparsable line", () => {
  const entries = parsePersonIdentityLinkLedger([
    JSON.stringify(malformedRecord({})),
    "{ not json",
  ].join("\n"));
  const result = checkPersonIdentityLinkLedger(entries);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["missing_header", "unparsable_line"]);
});
