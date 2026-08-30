import { test } from "node:test";
import assert from "node:assert/strict";
import { handleFeedback } from "../src/feedback.mjs";
import {
  FEEDBACK_DESK_ITEM_SCHEMA,
  deskItemLeaksPrivateFields,
  projectFeedbackDeskItem,
} from "../src/lib/feedback_desk.mjs";
import {
  buildContractReportTarget,
  buildProjectParcelRelationshipReportTarget,
} from "../../site/report_issue.mjs";

function kv(map = {}) {
  return {
    get: async (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    put: async (k, v) => { map[k] = v; },
  };
}

function deskItemsFromStore(store) {
  return Object.keys(store)
    .filter((name) => name.startsWith("fb:"))
    .map((id) => projectFeedbackDeskItem(id, JSON.parse(store[id])))
    .sort((a, b) => (String(a.at) < String(b.at) ? 1 : -1));
}

function contractTarget() {
  return buildContractReportTarget({
    procurement_id: "procurement:contract:CT123",
    canonical_href: "/procurements/procurement%3Acontract%3ACT123",
    short_title: "Street repair contract",
    vendor_name: "Acme Works",
    source_observation_refs: ["passport_public_contracts:row-1"],
  });
}

function parcelTarget() {
  return buildProjectParcelRelationshipReportTarget({
    project_id: "2026M0258",
    project_name: "Avenue project",
  }, {
    ref: "bbl:1006440001",
    label: "Manhattan — Block 644, Lot 1",
    relation: "sited_on_parcel",
    provenance: {
      source_system: "zap-bbl",
      source_record_id: "zap-bbl:2026M0258:1006440001",
      source_url: "https://zap.planning.nyc.gov/projects/2026M0258",
    },
  });
}

const PRIVATE_EXTRAS = [
  "reporter@example.com",
  "203.0.113.88",
  "CityScrollTest/1.0",
  "keep this adjudication private",
  "operator-only note",
];

function privateFields(over = {}) {
  return {
    email: "reporter@example.com",
    ip: "203.0.113.88",
    ua: "CityScrollTest/1.0",
    adjudication: { verdict: "confirmed", notes: "keep this adjudication private" },
    operator_notes: "operator-only note",
    ...over,
  };
}

function assertPrivateFieldsOmitted(item) {
  assert.equal(deskItemLeaksPrivateFields(item, PRIVATE_EXTRAS), false);
  const serialized = JSON.stringify(item);
  for (const extra of PRIVATE_EXTRAS) {
    assert.equal(serialized.includes(extra), false, `leaked ${extra}`);
  }
}

test("desk projection round-trips a stored contextual report without inferring extra claims", () => {
  const target = contractTarget();
  const item = projectFeedbackDeskItem("fb:1:aabbcc", {
    category: "report",
    message: "The published vendor name does not match the source record.",
    evidence: "See the attached public contract row.",
    report_target: target,
    report: {
      category: "information_wrong",
      explanation: "The published vendor name does not match the source record.",
      evidence: "See the attached public contract row.",
    },
    at: "2026-08-29T12:00:00.000Z",
    ...privateFields(),
  });

  assert.equal(item.schema, FEEDBACK_DESK_ITEM_SCHEMA);
  assert.equal(item.id, "fb:1:aabbcc");
  assert.equal(item.category, "report");
  assert.equal(item.target_status, "present");
  assert.equal(item.target_id, target.target_id);
  assert.equal(item.canonical_url, target.canonical_url);
  assert.equal(item.report_target.object_id, "procurement:contract:CT123");
  assert.equal(item.report_target.claim_anchor.claim_type, "field");
  assert.deepEqual(item.provenance, {
    source_record_ids: ["passport_public_contracts:row-1"],
    source_urls: [],
    systems: [],
  });
  assert.equal(item.evidence, "See the attached public contract row.");
  assert.equal(item.report.category, "information_wrong");
  assert.equal(item.at, "2026-08-29T12:00:00.000Z");
  assertPrivateFieldsOmitted(item);
});

test("desk projection preserves a relationship target and source provenance", () => {
  const target = parcelTarget();
  const item = projectFeedbackDeskItem("fb:2:parcel", {
    category: "report",
    message: "This project is adjacent to that parcel, but the application does not include it.",
    evidence: "See the filed project map.",
    report_target: target,
    report: {
      category: "connection_wrong",
      explanation: "This project is adjacent to that parcel, but the application does not include it.",
      evidence: "See the filed project map.",
    },
    at: "2026-08-29T13:00:00.000Z",
  });
  assert.equal(item.target_id, target.target_id);
  assert.equal(item.canonical_url, target.canonical_url);
  assert.equal(item.report_target.claim_anchor.claim_type, "relationship");
  assert.equal(item.report_target.claim_anchor.relation_type, "sited_on_parcel");
  assert.deepEqual(item.provenance, target.provenance);
});

test("legacy generic rows keep explicit null context instead of inventing a target from the message", () => {
  const item = projectFeedbackDeskItem("fb:legacy:1", {
    category: "bug",
    message: "The Street repair contract vendor is wrong on /procurements/procurement%3Acontract%3ACT123.",
    email: "reporter@example.com",
    ip: "203.0.113.88",
    ua: "CityScrollTest/1.0",
    at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(item.id, "fb:legacy:1");
  assert.equal(item.category, "bug");
  assert.equal(item.target_status, "missing");
  assert.equal(item.report_target, null);
  assert.equal(item.target_id, null);
  assert.equal(item.canonical_url, null);
  assert.equal(item.provenance, null);
  assert.equal(item.evidence, null);
  assert.equal(item.report, null);
  assertPrivateFieldsOmitted(item);
});

test("a stored null report_target is missing, not reconstructed", () => {
  const item = projectFeedbackDeskItem("fb:null-target", {
    category: "report",
    message: "Something is missing from this procurement record.",
    report_target: null,
    evidence: "",
    at: "2026-08-29T14:00:00.000Z",
  });
  assert.equal(item.target_status, "missing");
  assert.equal(item.report_target, null);
  assert.equal(item.target_id, null);
  assert.equal(item.canonical_url, null);
  assert.equal(item.evidence, null);
});

test("malformed stored targets fail closed and keep any durable identity strings", () => {
  const item = projectFeedbackDeskItem("fb:bad:1", {
    category: "report",
    message: "Please treat this as a vendor identity claim.",
    report_target: {
      schema: "not-a-report-target",
      target_id: "cityscroll.report_target.v1|procurement|kept-id|object",
      canonical_url: "/procurements/procurement%3Acontract%3ACT999",
      object_type: "",
    },
    at: "2026-08-29T15:00:00.000Z",
    adjudication: { verdict: "confirmed" },
  });
  assert.equal(item.target_status, "malformed");
  assert.equal(item.report_target, null);
  assert.equal(item.target_id, "cityscroll.report_target.v1|procurement|kept-id|object");
  assert.equal(item.canonical_url, "/procurements/procurement%3Acontract%3ACT999");
  assert.equal(item.provenance, null);
  assert.equal(item.report_target?.claim_anchor, undefined);
  assertPrivateFieldsOmitted(item);
});

test("a stored target whose identity drifts on resolve is not rewritten", () => {
  const target = contractTarget();
  const item = projectFeedbackDeskItem("fb:drift:1", {
    category: "report",
    message: "The published vendor name does not match the source record.",
    report_target: { ...target, target_id: "forged-identity" },
    at: "2026-08-29T16:00:00.000Z",
  });
  assert.equal(item.target_status, "malformed");
  assert.equal(item.report_target, null);
  assert.equal(item.target_id, "forged-identity");
  assert.equal(item.canonical_url, target.canonical_url);
});

test("two reports about one object stay independently addressable by row id and target id", () => {
  const target = contractTarget();
  const first = projectFeedbackDeskItem("fb:a:1", {
    category: "report",
    message: "The amount on this contract is wrong.",
    report_target: target,
    report: { category: "information_wrong", explanation: "The amount on this contract is wrong.", evidence: "" },
    at: "2026-08-29T17:00:00.000Z",
  });
  const second = projectFeedbackDeskItem("fb:b:2", {
    category: "report",
    message: "The vendor connection is wrong.",
    report_target: target,
    report: { category: "connection_wrong", explanation: "The vendor connection is wrong.", evidence: "source row" },
    evidence: "source row",
    at: "2026-08-29T17:05:00.000Z",
  });
  assert.notEqual(first.id, second.id);
  assert.equal(first.target_id, second.target_id);
  assert.equal(first.canonical_url, second.canonical_url);
  assert.equal(first.report.category, "information_wrong");
  assert.equal(second.report.category, "connection_wrong");
});

test("a mixed stored inbox projects contextual and generic rows independently", () => {
  const target = contractTarget();
  const store = {
    "fb:100:one": JSON.stringify({
      category: "report",
      message: "The published vendor name does not match the source record.",
      evidence: "Public contract source row",
      report_target: target,
      report: {
        category: "information_wrong",
        explanation: "The published vendor name does not match the source record.",
        evidence: "Public contract source row",
      },
      at: "2026-08-29T18:00:00.000Z",
      ...privateFields(),
    }),
    "fb:90:generic": JSON.stringify({
      category: "general",
      message: "The about page feedback form is hard to find.",
      at: "2026-08-29T17:00:00.000Z",
      ...privateFields(),
    }),
    "rl:ip:ignored": JSON.stringify({ n: 3 }),
  };
  const items = deskItemsFromStore(store);
  assert.deepEqual(items.map((item) => item.id), ["fb:100:one", "fb:90:generic"]);
  assert.equal(items[0].target_id, target.target_id);
  assert.equal(items[0].canonical_url, target.canonical_url);
  assert.equal(items[1].target_status, "missing");
  assert.equal(items[1].report_target, null);
  for (const item of items) assertPrivateFieldsOmitted(item);
});

test("stored contextual reports round-trip from POST /feedback through the desk", async () => {
  const store = {};
  const target = contractTarget();
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.resend.com")) {
      return new Response(JSON.stringify({ id: "mock" }), { status: 200 });
    }
    return previous ? previous(url) : new Response("unexpected", { status: 500 });
  };
  try {
    const posted = await handleFeedback(new Request("https://w/feedback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://cityscroll.org",
        "CF-Connecting-IP": "203.0.113.11",
        "user-agent": "CityScrollTest/1.0",
      },
      body: JSON.stringify({
        category: "information_wrong",
        message: "The vendor should be checked against the source record.",
        evidence: "Public contract source row",
        email: "reporter@example.com",
        report_target: target,
      }),
    }), { RESEND_API_KEY: "rk", FEEDBACK: kv(store) });
    assert.equal(posted.status, 200);

    const items = deskItemsFromStore(store);
    assert.equal(items.length, 1);
    const item = items[0];
    assert.match(item.id, /^fb:\d+:[0-9a-f]+$/);
    assert.equal(item.target_id, target.target_id);
    assert.equal(item.canonical_url, target.canonical_url);
    assert.equal(item.report_target.canonical_url, target.canonical_url);
    assert.equal(item.evidence, "Public contract source row");
    assert.equal(item.report.category, "information_wrong");
    assertPrivateFieldsOmitted(item);
  } finally {
    globalThis.fetch = previous;
  }
});
