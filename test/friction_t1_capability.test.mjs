/**
 * Sourced deadlines survive digest, detail, preview, and email preparation.
 *
 *   node --test test/friction_t1_capability.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  compactRowFromDigest,
  procurementDigestRow,
} from "../site/procurement_digest_compile.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import {
  DEADLINE_ATOM_STATUS,
  DEADLINE_TRANSPORT_STATUS,
  digestDeadlineMetaLabel,
  projectDeadlineKind,
  projectDeadlinesFromNoticeRow,
  projectDeadlinesFromSnapshots,
} from "../site/procurement_deadline_projection.mjs";
import {
  buildProcurementAlertAtom,
  procurementAlertSubject,
  procurementAlertSubjectSegment,
} from "../site/procurement_alert_atom.mjs";
import { renderEdgeNotice } from "../site/pages_edge.mjs";
import {
  DEADLINE_RESOLUTION_STATUS,
  resolveTypedSourceDeadlines,
} from "../warehouse/lib/typed_source_deadline.mjs";
import {
  recordsFromMtaOpportunityFixtures,
} from "../warehouse/lib/mta_opportunities.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { testClockISOString } from "./helpers/test_clock.mjs";

function esc(value) {
  return String(value ?? "").replace(/[<>&"]/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;",
  }[char]));
}

/**
 * Site-family mail preparation sink. Mirrors worker digest meta labeling without
 * importing worker/src/alerts.mjs (that module needs packages the site-node
 * family does not install).
 */
function prepareDigestEmailHtml(label, rows) {
  const items = rows.map((row) => {
    const title = row.short_title || row.title || "Notice";
    const href = row.procurement_id
      ? `https://cityscroll.org/procurements/${encodeURIComponent(row.procurement_id)}`
      : (row.request_id
        ? `https://cityscroll.org/notices/${encodeURIComponent(row.request_id)}`
        : "#");
    const meta = [
      row.agency_name,
      row.primary_stage ? String(row.primary_stage).replaceAll("_", " ") : "",
      digestDeadlineMetaLabel(row),
    ].filter(Boolean).map(esc).join(" · ");
    return `<li data-digest-item="1"><b><a href="${esc(href)}">${esc(title)}</a></b><br><span>${meta}</span></li>`;
  }).join("");
  return `<div data-digest-label="${esc(label)}"><ul>${items}</ul></div>`;
}

function serializeDigestRowForWorker(row) {
  const out = {
    request_id: row.request_id ?? null,
    agency_name: row.agency_name ?? null,
    short_title: row.short_title ?? null,
    due_date: row.due_date ?? null,
    type_of_notice_description: row.type_of_notice_description ?? null,
  };
  if (row.response_deadline) out.response_deadline = row.response_deadline;
  if (row.bid_opening) out.bid_opening = row.bid_opening;
  return out;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const MTA_FIXTURES = read("warehouse/fixtures/authority-native-procurement/mta-opportunities.v1.json");
const DEADLINE_FIXTURES = read("warehouse/fixtures/authority-native-procurement/typed-source-deadlines.v1.json");
const CLOCK = testClockISOString();

function withoutClock(example) {
  const { clock: _clock, ...rest } = example;
  return rest;
}

/**
 * Build the inspectable evidence payload in memory. Committed docs/evidence
 * files stay read-only fixtures; compare stable fields instead of rewriting
 * the ambient clock under time-travel.
 */
function assertEvidenceExample(name, payload) {
  assert.equal(payload.schema, "cityscroll.deadlines_through_digest_example.v1");
  assert.match(payload.clock, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(payload.source?.source_url);
  assert.ok(payload.digest?.response_deadline?.date || payload.digest?.due_date);
  assert.ok(payload.preview?.label || payload.preview?.value);
  assert.ok(payload.email?.subject || payload.email?.meta_label);
  const committed = read(`docs/evidence/deadlines-through-digest/${name}`);
  assert.deepEqual(withoutClock(payload), withoutClock(committed));
}

const NATIVE_MODEL = buildSharedProcurementReadModel({
  sourceRecords: recordsFromMtaOpportunityFixtures(MTA_FIXTURES),
  generatedAt: MTA_FIXTURES.retrieved_at,
});

const OBJ_2138505 = NATIVE_MODEL.rows.find((row) => (
  row.procurement_id === "procurement:contract_reporter_number:2138505"
));
const OBJ_S48020 = NATIVE_MODEL.rows.find((row) => (
  row.procurement_id === "procurement:solicitation:S48020"
));

const DOB_FIXTURE = DEADLINE_FIXTURES.fixtures.find((row) => row.id === "dob-20260707026-current");
const CONFLICT_FIXTURE = DEADLINE_FIXTURES.fixtures.find((row) => (
  row.id === "synthetic-competing-current-assertions"
));

/** Controlled mail sink — production serialization into inspectable payloads. */
function controlledMailSink() {
  const messages = [];
  return {
    messages,
    prepare(label, kind, rows) {
      const atoms = rows.map((row) => buildProcurementAlertAtom(row));
      const subject = procurementAlertSubject({ atoms });
      const html = prepareDigestEmailHtml(label, rows);
      const payload = Object.freeze({
        label,
        kind,
        subject,
        html,
        rows: rows.map((row) => ({
          procurement_id: row.procurement_id || null,
          request_id: row.request_id || null,
          due_date: row.due_date || null,
          response_deadline: row.response_deadline || null,
          bid_opening: row.bid_opening || null,
          meta_label: digestDeadlineMetaLabel(row),
        })),
      });
      messages.push(payload);
      return payload;
    },
  };
}

function observationsFor(object) {
  const refs = new Set(object?.source_observation_refs || []);
  return (NATIVE_MODEL.observations || []).filter((entry) => refs.has(entry.source_observation_ref));
}

function dueOnlyObservations(object) {
  return observationsFor(object).map((entry) => {
    const snapshot = { ...(entry.snapshot || {}) };
    delete snapshot.release_date;
    delete snapshot.start_date;
    delete snapshot.issue_date;
    delete snapshot.document_availability_date;
    if (snapshot.source_values && typeof snapshot.source_values === "object") {
      snapshot.source_values = { ...snapshot.source_values };
      delete snapshot.source_values.release_date;
      delete snapshot.source_values.start_date;
      delete snapshot.source_values.issue_date;
      delete snapshot.source_values.document_availability_date;
    }
    return { ...entry, snapshot };
  });
}

function dobNoticeRow({ stripPublication = false } = {}) {
  const projected = projectDeadlinesFromNoticeRow({
    request_id: "20260707026",
    agency_name: "Buildings",
    short_title: DOB_FIXTURE.short_title,
    type_of_notice_description: "Solicitation",
    due_date: "8/25/2026 1:00 PM",
    start_date: stripPublication ? null : "2026-07-28",
    pin: "81026B0003",
  }, {
    resolution: resolveTypedSourceDeadlines(DOB_FIXTURE.assertions),
    source_url: DOB_FIXTURE.official_url,
  });
  return {
    request_id: "20260707026",
    agency_name: "Buildings",
    short_title: DOB_FIXTURE.short_title,
    type_of_notice_description: "Solicitation",
    section_name: "Procurement",
    pin: "81026B0003",
    due_date: stripPublication ? projected.due_date : "8/25/2026 1:00 PM",
    start_date: stripPublication ? null : "2026-07-28",
    response_deadline: projected.response_deadline,
    bid_opening: projected.bid_opening,
  };
}

function governorsIslandNoticeRow({ stripPublication = false } = {}) {
  const projected = projectDeadlinesFromNoticeRow({
    request_id: "20260727019",
    agency_name: "Trust for Governors Island",
    short_title: "Governors Island Building 324 construction services",
    type_of_notice_description: "Solicitation",
    due_date: "8/28/2026 5:00 PM",
    start_date: stripPublication ? null : "2026-07-31",
  });
  return {
    request_id: "20260727019",
    agency_name: "Trust for Governors Island",
    short_title: "Governors Island Building 324 construction services",
    type_of_notice_description: "Solicitation",
    section_name: "Procurement",
    due_date: stripPublication ? projected.due_date : "8/28/2026 5:00 PM",
    start_date: stripPublication ? null : "2026-07-31",
    response_deadline: projected.response_deadline,
    bid_opening: projected.bid_opening,
  };
}

test("A1 2138505, DOB 20260707026, and Governors Island 20260727019 keep precision and source links", () => {
  assert.match(CLOCK, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(OBJ_2138505);
  assert.ok(DOB_FIXTURE);

  const sink = controlledMailSink();

  // --- Native 2138505 (date-only response deadline) ---
  const digest2138505 = procurementDigestRow(OBJ_2138505, NATIVE_MODEL);
  assert.equal(digest2138505.due_date, "2026-10-02");
  assert.equal(digest2138505.response_deadline.status, DEADLINE_TRANSPORT_STATUS.RESOLVED);
  assert.equal(digest2138505.response_deadline.precision, "date_only");
  assert.equal(digest2138505.response_deadline.date, "2026-10-02");
  assert.match(digest2138505.response_deadline.source_url, /nyscr\.ny\.gov/);
  assert.equal(compactRowFromDigest(digest2138505).due_date, "2026-10-02");
  assert.equal(compactRowFromDigest(digest2138505).response_deadline.date, "2026-10-02");

  const detail2138505 = renderProcurementDocument(OBJ_2138505, observationsFor(OBJ_2138505));
  assert.match(detail2138505, /Oct 2/);
  assert.match(detail2138505, /Due date/);
  assert.doesNotMatch(detail2138505, /Bid opening Oct 2/);

  const preview2138505 = buildProcurementAlertAtom(digest2138505);
  assert.equal(preview2138505.deadline.status, DEADLINE_ATOM_STATUS.OBSERVED);
  assert.equal(preview2138505.deadline.value, "2026-10-02");
  assert.match(preview2138505.deadline.label, /Oct 2/);
  assert.match(preview2138505.deadline.source_url || "", /nyscr\.ny\.gov/);

  const email2138505 = sink.prepare("native-2138505", "rfp", [digest2138505]);
  assert.match(email2138505.html, /due Oct 2/);
  assert.equal(email2138505.rows[0].meta_label, "due Oct 2");
  assert.match(
    procurementAlertSubjectSegment(preview2138505),
    /closes Oct 2/,
  );
  assert.match(email2138505.html, /cityscroll\.org\/procurements/);

  // --- DOB City Record (exact-time response deadline) ---
  const dob = dobNoticeRow();
  assert.equal(dob.response_deadline.precision, "exact_time");
  assert.equal(dob.response_deadline.wall_time, "13:00:00");
  assert.equal(dob.response_deadline.timezone, "America/New_York");
  assert.match(dob.response_deadline.label, /1:00 PM/);
  assert.match(dob.response_deadline.source_url, /RequestDetail\/20260707026/);

  const dobDetail = renderEdgeNotice(dob, dob.request_id);
  assert.match(dobDetail, /8\/25\/2026 1:00 PM|Responses due/);
  assert.match(dobDetail, /20260707026/);

  const dobPreview = buildProcurementAlertAtom(dob);
  assert.equal(dobPreview.deadline.status, DEADLINE_ATOM_STATUS.OBSERVED);
  assert.equal(dobPreview.deadline.value, "2026-08-25");
  assert.match(dobPreview.deadline.label, /1:00 PM/);
  assert.equal(dobPreview.deadline.timezone, "America/New_York");

  const emailDob = sink.prepare("city-record-dob", "rfp", [dob]);
  assert.match(emailDob.html, /due August 25, 2026 at 1:00 PM/);
  assert.match(emailDob.rows[0].meta_label, /due August 25, 2026 at 1:00 PM/);
  assert.match(
    procurementAlertSubjectSegment(dobPreview),
    /closes August 25, 2026 at 1:00 PM/,
  );
  assert.doesNotMatch(emailDob.html + emailDob.subject, /assertion_id|competing_current|evidence_class/);

  // --- Governors Island City Record (exact-time, date-only publication) ---
  const gi = governorsIslandNoticeRow();
  assert.equal(gi.response_deadline.precision, "exact_time");
  assert.equal(gi.response_deadline.date, "2026-08-28");
  assert.equal(gi.response_deadline.wall_time, "17:00:00");
  assert.match(gi.response_deadline.source_url, /RequestDetail\/20260727019/);

  const giDetail = renderEdgeNotice(gi, gi.request_id);
  assert.match(giDetail, /8\/28\/2026 5:00 PM|Responses due/);
  assert.match(giDetail, /20260727019/);

  const giPreview = buildProcurementAlertAtom(gi);
  assert.match(giPreview.deadline.label, /5:00 PM/);
  const emailGi = sink.prepare("city-record-governors-island", "rfp", [gi]);
  assert.match(emailGi.html, /due August 28, 2026 at 5:00 PM/);
  assert.match(emailGi.rows[0].meta_label, /due August 28, 2026 at 5:00 PM/);
  assert.match(
    procurementAlertSubjectSegment(giPreview),
    /closes August 28, 2026 at 5:00 PM/,
  );

  // Worker-shaped serialization preserves additive deadline fields.
  const serialized = serializeDigestRowForWorker(gi);
  assert.equal(serialized.response_deadline.date, "2026-08-28");
  assert.equal(serialized.bid_opening || null, gi.bid_opening || null);

  assertEvidenceExample("example-2138505-source-detail-email.json", {
    schema: "cityscroll.deadlines_through_digest_example.v1",
    record: "procurement:contract_reporter_number:2138505",
    clock: CLOCK,
    precision: "date_only",
    source: {
      due_date: "10/2/2026",
      source_url: digest2138505.response_deadline.source_url,
    },
    digest: {
      due_date: digest2138505.due_date,
      response_deadline: digest2138505.response_deadline,
    },
    detail_excerpt: detail2138505.match(/Due date[\s\S]{0,160}/)?.[0] || null,
    preview: preview2138505.deadline,
    email: {
      subject: email2138505.subject,
      meta_label: email2138505.rows[0].meta_label,
    },
  });
  assertEvidenceExample("example-dob-20260707026-source-detail-email.json", {
    schema: "cityscroll.deadlines_through_digest_example.v1",
    record: "20260707026",
    clock: CLOCK,
    precision: "exact_time",
    source: {
      due_date: "8/25/2026 1:00 PM",
      source_url: dob.response_deadline.source_url,
    },
    digest: {
      due_date: dob.due_date,
      response_deadline: dob.response_deadline,
    },
    detail_excerpt: "Responses due · 8/25/2026 1:00 PM",
    preview: dobPreview.deadline,
    email: {
      subject: emailDob.subject,
      meta_label: emailDob.rows[0].meta_label,
    },
  });
  assertEvidenceExample("example-governors-island-20260727019-source-detail-email.json", {
    schema: "cityscroll.deadlines_through_digest_example.v1",
    record: "20260727019",
    clock: CLOCK,
    precision: "exact_time",
    source: {
      due_date: "8/28/2026 5:00 PM",
      source_url: gi.response_deadline.source_url,
    },
    digest: {
      due_date: gi.response_deadline.date,
      response_deadline: gi.response_deadline,
    },
    detail_excerpt: "Responses due · 8/28/2026 5:00 PM",
    preview: giPreview.deadline,
    email: {
      subject: emailGi.subject,
      meta_label: emailGi.rows[0].meta_label,
    },
  });

  assert.equal(sink.messages.length, 3);
});

test("A2 due-only mutations still show the deadline when release/publication is removed", () => {
  const dueOnlyObs = dueOnlyObservations(OBJ_2138505);
  const dueOnlyObject = {
    ...OBJ_2138505,
    // Keep identity; snapshots lose release/publication support for a window.
  };
  const detail = renderProcurementDocument(dueOnlyObject, dueOnlyObs);
  assert.match(detail, /Oct 2/);

  const projection = projectDeadlinesFromSnapshots(dueOnlyObs.map((entry) => entry.snapshot));
  assert.equal(projection.due_date, "2026-10-02");
  assert.equal(projection.response_deadline.status, DEADLINE_TRANSPORT_STATUS.RESOLVED);

  const dob = dobNoticeRow({ stripPublication: true });
  assert.equal(dob.start_date, null);
  assert.equal(dob.response_deadline.date, "2026-08-25");
  const dobAtom = buildProcurementAlertAtom(dob);
  assert.equal(dobAtom.deadline.status, DEADLINE_ATOM_STATUS.OBSERVED);
  assert.match(
    procurementAlertSubjectSegment(dobAtom),
    /closes August 25, 2026 at 1:00 PM/,
  );

  const gi = governorsIslandNoticeRow({ stripPublication: true });
  assert.equal(gi.start_date, null);
  assert.equal(gi.response_deadline.date, "2026-08-28");
  assert.match(digestDeadlineMetaLabel(gi), /due August 28, 2026 at 5:00 PM/);
});

test("A3 S48020 opening stays an opening; older compact rows without deadline metadata still render", () => {
  const digest = procurementDigestRow(OBJ_S48020, NATIVE_MODEL);
  assert.equal(digest.due_date, undefined);
  assert.equal(digest.response_deadline, undefined);
  assert.equal(digest.bid_opening.status, DEADLINE_TRANSPORT_STATUS.RESOLVED);
  assert.equal(digest.bid_opening.date, "2026-10-16");
  assert.match(digest.bid_opening.label, /^Bid opening /);
  assert.doesNotMatch(digest.bid_opening.label, /\bDue\b/i);

  const compact = compactRowFromDigest(digest);
  assert.equal(compact.due_date, undefined);
  assert.match(compact.bid_opening.label, /^Bid opening /);
  assert.equal(digestDeadlineMetaLabel(compact), compact.bid_opening.label);

  const detail = renderProcurementDocument(OBJ_S48020, observationsFor(OBJ_S48020));
  assert.match(detail, /No published due date|Not observed/);
  assert.doesNotMatch(detail, /Due date[\s\S]{0,40}Oct 16/);

  const email = prepareDigestEmailHtml("s48020", [digest]);
  assert.match(email, /Bid opening Oct 16/);
  assert.doesNotMatch(email, /due Oct 16/);

  // Older compact rows without deadline metadata continue to render.
  const legacy = compactRowFromDigest({
    procurement_id: "procurement:contract:LEGACY-1",
    digest_id: "procurement:contract:LEGACY-1",
    short_title: "Legacy compact row",
    agency_name: "Example Agency",
    procurement_stages: ["award"],
    primary_stage: "award",
    source_systems: ["checkbook_contracts"],
  });
  assert.equal(legacy.due_date, undefined);
  assert.equal(legacy.response_deadline, undefined);
  assert.equal(legacy.bid_opening, undefined);
  const legacyHtml = prepareDigestEmailHtml("legacy", [legacy]);
  assert.match(legacyHtml, /Legacy compact row/);
  assert.doesNotMatch(legacyHtml, /due undefined|due null|due 0\b/);
});

test("A4 source-version conflict yields deadline-unconfirmed without adapter diagnostics in email", () => {
  const resolution = resolveTypedSourceDeadlines(CONFLICT_FIXTURE.assertions);
  assert.equal(resolution.response_deadline.status, DEADLINE_RESOLUTION_STATUS.UNRESOLVED_CONFLICT);
  const projected = projectDeadlineKind(resolution, "response");
  assert.equal(projected.status, DEADLINE_TRANSPORT_STATUS.DEADLINE_UNCONFIRMED);
  assert.equal(projected.label, "Deadline unconfirmed");
  assert.equal(projected.date, null);

  const row = {
    request_id: "synthetic-conflict",
    short_title: "Synthetic conflicting deadlines",
    agency_name: "Buildings",
    type_of_notice_description: "Solicitation",
    response_deadline: projected,
  };
  const atom = buildProcurementAlertAtom(row);
  assert.equal(atom.deadline.status, DEADLINE_ATOM_STATUS.DEADLINE_UNCONFIRMED);
  const subject = procurementAlertSubject({ atoms: [atom] });
  assert.match(subject, /deadline unconfirmed/i);
  assert.doesNotMatch(subject, /assertion_id|competing_current|evidence_class|UNRESOLVED|semantic_kind/);

  const sink = controlledMailSink();
  const email = sink.prepare("conflict", "rfp", [row]);
  assert.match(email.html, /deadline unconfirmed/i);
  assert.doesNotMatch(
    email.html + email.subject,
    /assertion_id|competing_current_authoritative|evidence_class|source_revision|UNRESOLVED_CONFLICT/,
  );
});

test("A5 production serialization comparison retains three inspectable source-to-detail-to-email examples", () => {
  const examples = [
    "example-2138505-source-detail-email.json",
    "example-dob-20260707026-source-detail-email.json",
    "example-governors-island-20260727019-source-detail-email.json",
  ].map((name) => read(`docs/evidence/deadlines-through-digest/${name}`));

  assert.equal(examples.length, 3);
  const precisions = examples.map((row) => row.precision).sort();
  assert.deepEqual(precisions, ["date_only", "exact_time", "exact_time"]);

  for (const example of examples) {
    assert.equal(example.schema, "cityscroll.deadlines_through_digest_example.v1");
    assert.ok(example.source?.source_url);
    assert.ok(example.digest?.response_deadline?.date || example.digest?.due_date);
    assert.ok(example.preview?.label || example.preview?.value);
    assert.ok(example.email?.subject);
    assert.ok(example.email?.meta_label);
    assert.match(example.clock, /^\d{4}-\d{2}-\d{2}T/);
  }

  // Native and City Record paths both keep additive deadline transport fields.
  const native = procurementDigestRow(OBJ_2138505, NATIVE_MODEL);
  const city = dobNoticeRow();
  assert.ok(digestDeadlineMetaLabel(native));
  assert.ok(digestDeadlineMetaLabel(city));
  assert.ok(serializeDigestRowForWorker(city).response_deadline);
});
