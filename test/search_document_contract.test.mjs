import assert from "node:assert/strict";
import test from "node:test";

import {
  SEARCH_DOCUMENT_DOMAINS,
  SEARCH_DOCUMENT_OBJECT_TYPES,
  SEARCH_DOCUMENT_OUTCOMES,
  SEARCH_DOCUMENT_SCHEMA,
  SEARCH_TEXT_MAX_LENGTH,
  admitSearchDocument,
  rankSearchDocuments,
} from "../site/search_document_contract.mjs";
import { searchResultHref, searchResultLane } from "../site/search_document.mjs";

function candidate(overrides = {}) {
  return {
    schema: SEARCH_DOCUMENT_SCHEMA,
    object_ref: "procurement:81626S0021001",
    object_type: "procurement",
    domain: "contracts",
    canonical_href: "/browse/contracts/?mode=award&q=81626S0021001",
    title: "Pesticides and Mosquito Control Products",
    summary: "Public comment on a proposed contract award.",
    search_text: "Pesticides mosquito control contract award 81626S0021001",
    source_family: "city_record_notice",
    source_observation_refs: ["notice:20260710020"],
    process_role: null,
    classification: {
      method: "canonical_object_projection",
      basis: "exact_e_pin",
    },
    provenance: {
      producer: "city_record_notice_search_projection.v1",
      evidence_hrefs: ["/notices/20260710020"],
    },
    ...overrides,
  };
}

test("object types and product domains are independent closed vocabularies", () => {
  assert.deepEqual(SEARCH_DOCUMENT_OUTCOMES, [
    "indexed",
    "unclassified",
    "unsupported",
    "not_indexed",
    "evidence_only",
  ]);
  assert.ok(SEARCH_DOCUMENT_OBJECT_TYPES.includes("procurement"));
  assert.ok(SEARCH_DOCUMENT_OBJECT_TYPES.includes("unclassified"));
  assert.ok(!SEARCH_DOCUMENT_OBJECT_TYPES.includes("contracts"));
  assert.ok(SEARCH_DOCUMENT_DOMAINS.includes("contracts"));
  assert.ok(!SEARCH_DOCUMENT_DOMAINS.includes("procurement"));
  assert.ok(Object.isFrozen(SEARCH_DOCUMENT_OBJECT_TYPES));
  assert.ok(Object.isFrozen(SEARCH_DOCUMENT_DOMAINS));
});

test("an indexed SearchDocument retains a canonical route and provenance", () => {
  const admitted = admitSearchDocument(candidate(), { outcome: "indexed" });
  assert.equal(admitted.outcome, "indexed");
  assert.deepEqual(admitted.errors, []);
  assert.equal(admitted.document.schema, SEARCH_DOCUMENT_SCHEMA);
  assert.equal(admitted.document.canonical_href, "/browse/contracts/?mode=award&q=81626S0021001");
  assert.deepEqual(admitted.document.source_observation_refs, ["notice:20260710020"]);
  assert.equal(admitted.document.provenance.producer, "city_record_notice_search_projection.v1");
  assert.ok(Object.isFrozen(admitted.document));
  assert.ok(Object.isFrozen(admitted.document.classification));
  assert.ok(Object.isFrozen(admitted.document.provenance));
});

test("unknown types fail closed instead of entering a substantive domain", () => {
  const admitted = admitSearchDocument(candidate({
    object_type: "publisher_miscellaneous",
    domain: "mandates",
  }), { outcome: "indexed" });
  assert.equal(admitted.outcome, "unclassified");
  assert.equal(admitted.document, null);
  assert.ok(admitted.errors.includes("object_type"));
});

test("indexed objects reject evidence routes and unsafe routes", () => {
  for (const canonical_href of [
    "/notices/20260710020",
    "https://attacker.example/notices/20260710020",
    "//attacker.example/notices/20260710020",
    "/#notice/20260710020",
  ]) {
    const admitted = admitSearchDocument(candidate({ canonical_href }), { outcome: "indexed" });
    assert.equal(admitted.outcome, "not_indexed", canonical_href);
    assert.equal(admitted.document, null, canonical_href);
    assert.ok(admitted.errors.includes("canonical_href"), canonical_href);
  }
});

test("evidence-only observations retain their notice route without acquiring a domain", () => {
  const admitted = admitSearchDocument(candidate({
    object_ref: "notice:unknown-001",
    object_type: "unclassified",
    domain: null,
    canonical_href: "/notices/unknown-001",
    title: "Publisher category without a registered object mapping",
    search_text: "Publisher category without a registered object mapping",
    source_observation_refs: ["notice:unknown-001"],
    classification: {
      method: "fail_closed",
      basis: "no_registered_object_mapping",
    },
    provenance: {
      producer: "city_record_notice_search_projection.v1",
      evidence_hrefs: ["/notices/unknown-001"],
    },
  }), { outcome: "evidence_only" });

  assert.equal(admitted.outcome, "evidence_only");
  assert.equal(admitted.document.object_type, "unclassified");
  assert.equal(admitted.document.domain, null);
  assert.equal(admitted.document.canonical_href, "/notices/unknown-001");
});

test("the client accepts canonical object routes and has no unknown-to-mandate fallback", () => {
  assert.equal(searchResultLane({ domain: "contracts" }), "contracts");
  assert.equal(searchResultLane({ domain: "publisher_miscellaneous" }), null);
  assert.equal(searchResultLane({ object_type: "unknown" }), null);
  assert.equal(searchResultHref({
    outcome: "indexed",
    canonical_href: "/browse/contracts/?mode=award&q=81626S0021001",
  }), "/browse/contracts/?mode=award&q=81626S0021001");
  assert.equal(searchResultHref({
    outcome: "indexed",
    canonical_href: "/notices/20260710020",
  }), null);
  assert.equal(searchResultHref({
    outcome: "evidence_only",
    canonical_href: "/notices/20260710020",
  }), "/notices/20260710020");
});

test("search text is bounded and every producer outcome is registered", () => {
  const tooLong = admitSearchDocument(candidate({
    search_text: "x".repeat(SEARCH_TEXT_MAX_LENGTH + 1),
  }), { outcome: "indexed" });
  assert.equal(tooLong.outcome, "not_indexed");
  assert.ok(tooLong.errors.includes("search_text"));
  assert.throws(
    () => admitSearchDocument(candidate(), { outcome: "best_effort" }),
    /producer outcome/,
  );
});

test("ranking sees only validated immutable documents and cannot reclassify them", () => {
  const first = candidate();
  const second = candidate({
    object_ref: "meeting:city_record:20260814001",
    object_type: "meeting",
    domain: "meetings",
    canonical_href: "/meetings/meeting%3Acity_record%3A20260814001",
    title: "Public hearing",
    search_text: "Public hearing",
    source_family: "shared_meeting",
    source_observation_refs: ["city_record:20260814001"],
    classification: { method: "canonical_meeting", basis: "source_qualified_id" },
    provenance: { producer: "shared_meeting_search_projection.v1" },
  });
  let calls = 0;
  const ranked = rankSearchDocuments([first, second], (document) => {
    calls += 1;
    assert.ok(Object.isFrozen(document));
    assert.throws(() => {
      document.classification.method = "ranked_into_mandate";
    }, TypeError);
    return document.object_type === "meeting" ? 2 : 1;
  });

  assert.equal(calls, 2);
  assert.deepEqual(ranked.map((document) => document.object_type), ["meeting", "procurement"]);
  assert.equal(ranked[1].classification.method, "canonical_object_projection");
  assert.ok(Object.isFrozen(ranked));
  assert.throws(
    () => rankSearchDocuments([candidate({ object_type: "unknown" })], () => 1),
    /validated SearchDocument/,
  );
});
