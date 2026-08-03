// Digest email time-awareness + action-awareness (render content).
// Characterizes open / closing-soon / closed from EVENT time and specific next
// actions extracted via the shared site action_registry handoffs.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deadlineState,
  daysUntilEvent,
  digestItemAwareness,
  digestMatterKind,
  isRollingDeadline,
  itemAwarenessHtml,
  matterFromDigestRow,
} from "../src/lib/digest_item_awareness.mjs";
import { subDigestHtml } from "../src/alerts.mjs";
import { reconcileTemporalCandidates, ruleActionKey } from "../src/lib/alert_temporal.mjs";

const TODAY = "2026-08-02";
const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

// ---- pure deadline state (event clock) -----------------------------------

test("deadlineState: open when more than 14 days remain", () => {
  const d = deadlineState("2026-09-15", TODAY);
  assert.equal(d.state, "open");
  assert.equal(d.event_at, "2026-09-15");
  assert.equal(d.days_left, 44);
});

test("deadlineState: closing-soon within 14 days (site soon band)", () => {
  const d = deadlineState("2026-08-10", TODAY);
  assert.equal(d.state, "closing-soon");
  assert.equal(d.days_left, 8);
});

test("deadlineState: closed when event day is before today", () => {
  const d = deadlineState("2026-07-01", TODAY);
  assert.equal(d.state, "closed");
  assert.ok(d.days_left < 0);
});

test("deadlineState: rolling placeholders are never a countdown", () => {
  assert.equal(isRollingDeadline("2090-01-01"), true);
  assert.equal(deadlineState("2099-12-31", TODAY).state, "rolling");
  assert.equal(deadlineState("2026-08-10", TODAY, { rolling: true }).state, "rolling");
});

test("daysUntilEvent is pure date arithmetic (no clock skew from TZ)", () => {
  assert.equal(daysUntilEvent("2026-08-02", "2026-08-02"), 0);
  assert.equal(daysUntilEvent("2026-08-03", "2026-08-02"), 1);
  assert.equal(daysUntilEvent("2026-08-01", "2026-08-02"), -1);
});

// ---- solicitation: package + contact + closing-soon ----------------------

// Synthetic fixtures only (RFC 2606 / 555 numbers) — not live City Record rows.
const solicitation = {
  request_id: "FIX-SOL-0001",
  short_title: "Street resurfacing materials",
  agency_name: "Department of Transportation",
  type_of_notice_description: "Solicitation",
  due_date: "2026-08-10",
  email: "procure@example.com",
  contact_name: "Testy McTestface",
  contact_phone: "555-0100",
  // Non-PASSPort-shaped pin so handoff stays notice-extracted / package URL.
  pin: "DOT-RFQ-2026-01",
  address_to_request: "1 Example Street, NY",
  selection_method_description: "Competitive Sealed Bid",
  additional_description_1:
    "Vendors must download the solicitation documents at https://example.com/rfps before submitting.",
};

test("solicitation awareness: closing-soon + package URL + contact steps", () => {
  const a = digestItemAwareness(solicitation, { kind: "rfp", today: TODAY });
  assert.equal(a.matter_kind, "solicitation");
  assert.equal(a.phase, "Solicitation");
  assert.equal(a.deadline.state, "closing-soon");
  assert.equal(a.pointer_only, false);
  assert.ok(a.action, "must extract a concrete next action");
  assert.notEqual(a.action.label_key, "read_official_notice");
  const packageStep = a.steps.find((s) => /package/i.test(s.label));
  assert.ok(packageStep, "package URL from notice body");
  assert.match(packageStep.value, /example\.com\/rfps/);
  assert.ok(a.steps.some((s) => s.label === "Email" && s.value.includes("procure@example.com")));
});

test("solicitation email HTML includes time state and next-step CTA", () => {
  const html = itemAwarenessHtml(solicitation, esc, "en", { kind: "rfp", today: TODAY });
  assert.match(html, /Solicitation/);
  assert.match(html, /Closing soon|due Aug 10/i);
  assert.match(html, /Next step:/);
  assert.match(html, /example\.com\/rfps/);
  assert.doesNotMatch(html, /use the response instructions in the official notice/i);
});

// ---- award: vendor/amount, never a bid CTA --------------------------------

const award = {
  request_id: "FIX-AWD-0002",
  short_title: "Snow removal equipment maintenance",
  agency_name: "Department of Sanitation",
  type_of_notice_description: "Award",
  vendor_name: "Acme Snow & Ice LLC",
  contract_amount: 250000,
  pin: "PIN-FIXTURE-0001",
};

test("award awareness: phase Award + awarded-to action (no bid CTA)", () => {
  const a = digestItemAwareness(award, { kind: "award", today: TODAY });
  assert.equal(a.phase, "Award");
  assert.equal(a.deadline.state, "none");
  assert.equal(a.pointer_only, false);
  assert.match(a.action.label, /Awarded to Acme/i);
  assert.doesNotMatch(a.action.label || "", /\bbid\b/i);
  assert.ok(a.steps.some((s) => s.label === "Vendor"));
});

// ---- rules: comment-open temporal + event clock ---------------------------

const rulesRow = {
  request_id: "FIX-RULE-0001",
  start_date: "2026-07-15T00:00:00.000",
  agency_name: "Department of Transportation",
  short_title: "Commercial curb-use rule",
  section_name: "Agency Rules",
  additional_description_1: "Proposed curb-use requirements.",
  temporal_action: {
    kind: "rules-comment-open",
    event_at: "2026-09-15",
    url: "https://example.com/rules/fixture-curb-use/",
  },
};

test("rules awareness: open through comment-close event time + NYC Rules CTA", () => {
  const a = digestItemAwareness(rulesRow, { kind: "rules", today: TODAY });
  assert.equal(a.matter_kind, "rule");
  assert.equal(a.deadline.state, "open");
  assert.equal(a.deadline.event_at, "2026-09-15");
  const html = itemAwarenessHtml(rulesRow, esc, "en", { kind: "rules", today: TODAY });
  assert.match(html, /Comments open through Sep 15/);
  assert.match(html, /Comment on NYC Rules/);
  assert.match(html, /example\.com\/rules\/fixture-curb-use/);
});

test("rules Spanish copy stays localized for the classic comment-open line", () => {
  const html = itemAwarenessHtml(rulesRow, esc, "es", { kind: "rules", today: TODAY });
  assert.match(html, /Comentarios abiertos hasta Sep 15/);
  assert.match(html, /Comentar en NYC Rules/);
  assert.doesNotMatch(html, /Comments open through/);
});

// ---- hearing: event date status + participation fields --------------------

const hearing = {
  request_id: "FIX-MTG-0001",
  short_title: "Franchise and Concession Review Committee public hearing",
  agency_name: "Mayor's Office of Contract Services",
  section_name: "Public Hearings and Meetings",
  type_of_notice_description: "Public Hearing",
  event_date: "2026-08-05",
  email: "hearing@example.com",
  street_address_1: "1 Example Plaza",
  building_name: "Fixture Hall",
  additional_description_1:
    "Written testimony may be submitted electronically to hearing@example.com until the close of the public hearing. Join via Zoom at https://example.com/join/fixture-hearing.",
};

test("hearing awareness: closing-soon event + join / testimony steps", () => {
  const a = digestItemAwareness(hearing, { kind: "meetings", today: TODAY });
  assert.equal(a.matter_kind, "hearing");
  assert.equal(a.deadline.state, "closing-soon");
  assert.equal(a.deadline.event_at, "2026-08-05");
  assert.equal(a.pointer_only, false);
  assert.ok(a.action);
  const html = itemAwarenessHtml(hearing, esc, "en", { kind: "meetings", today: TODAY });
  assert.match(html, /Hearing|meeting/i);
  assert.match(html, /Next step:|Join|testimony|hearing@example\.com/i);
});

// ---- land / rezone: ZAP public status + project handoff -------------------

const rezone = {
  project_id: "FIX-ZAP-0001",
  project_name: "Harbor rezoning",
  public_status: "In Public Review",
  borough: "Manhattan",
  community_district: "1",
  primary_applicant: "DCP",
  project_brief: "Zoning map amendment for waterfront parcels.",
};

test("rezone awareness: phase from public_status + ZAP comment destination", () => {
  const a = digestItemAwareness(rezone, { kind: "rezone", today: TODAY });
  assert.equal(a.matter_kind, "zoning");
  assert.match(a.phase || "", /In Public Review|Land use/i);
  assert.equal(a.pointer_only, false);
  assert.ok(a.action?.destination);
  assert.match(a.action.destination, /zap\.planning\.nyc\.gov\/projects\/FIX-ZAP-0001/);
  // project_brief must not invent a hearing CTA — label is View/comment on ZAP.
  assert.match(a.action.label || "", /ZAP|comment/i);
  assert.doesNotMatch(a.action.label || "", /hearing notice/i);
});

// ---- sparse row: honest pointer, no fabricated CTA ------------------------

test("sparse notice without response fields stays pointer-only (no invented CTA)", () => {
  const sparse = {
    request_id: "20260101000",
    short_title: "Routine administrative notice",
    agency_name: "Office of Management and Budget",
    section_name: "Procurement",
  };
  const a = digestItemAwareness(sparse, { kind: "entity", today: TODAY });
  assert.equal(a.pointer_only, true);
  assert.equal(a.action, null);
  assert.equal(a.steps.length, 0);
});

// ---- subDigestHtml wiring -------------------------------------------------

test("subDigestHtml embeds awareness for solicitation and award items", () => {
  const html = subDigestHtml(
    "money — construction",
    "rfp",
    [solicitation],
    "https://api.cityscroll.org/unsubscribe?token=test",
    "2026-07-31",
    "https://api.cityscroll.org",
    [],
    "en",
    [],
  );
  assert.match(html, /Closing soon|Open through|Solicitation/i);
  assert.match(html, /Next step:/);
  assert.match(html, /example\.com\/rfps/);

  const awardHtml = subDigestHtml(
    "big awards",
    "award",
    [award],
    "https://api.cityscroll.org/unsubscribe?token=test",
    "2026-07-31",
  );
  assert.match(awardHtml, /Award/);
  assert.match(awardHtml, /Awarded to Acme|Next step:/i);
});

// ---- idempotent reconciliation contract intact ----------------------------

test("awareness render does not change temporal delivery keys", () => {
  const NOTICE_ID = "FIX-RULE-0001";
  const record = {
    request_id: NOTICE_ID,
    stage: "comment-open",
    nyc_rules: {
      url: "https://example.com/rules/fixture-curb-use/",
      comment_by_date: "2026-09-15",
      pub_date: "2026-07-15T12:00:00.000Z",
    },
    events: [{
      event_type: "comment_close",
      valid_at: "2026-09-15",
    }],
  };
  const key = ruleActionKey(record);
  assert.equal(key, `temporal:rules:${NOTICE_ID}:comment-open:2026-09-15`);

  const notice = {
    request_id: NOTICE_ID,
    short_title: "Commercial curb-use rule",
    agency_name: "Department of Transportation",
    section_name: "Agency Rules",
  };
  const first = reconcileTemporalCandidates({
    lens: "rules",
    rows: [notice],
    seen: new Set([NOTICE_ID]),
    rulesView: { generated_at: "2026-08-01T12:00:00.000Z", rules: [record] },
  });
  assert.equal(first.fresh.length, 1);
  assert.ok(first.markSeenIds.includes(key));

  // Second reconcile with same actionable state + key already seen → no resend.
  const second = reconcileTemporalCandidates({
    lens: "rules",
    rows: [notice],
    seen: new Set([NOTICE_ID, key]),
    rulesView: {
      generated_at: "2026-08-02T12:00:00.000Z",
      rules: [{
        ...record,
        nyc_rules: {
          ...record.nyc_rules,
          pub_date: "2026-08-02T12:30:00.000Z", // publication churn must not mint a new key
        },
      }],
    },
  });
  assert.equal(second.fresh.length, 0);
  assert.equal(ruleActionKey(record), key, "publication churn does not change delivery identity");

  // Enriched email content still uses the same temporal_action event_at.
  const html = itemAwarenessHtml(first.fresh[0], esc, "en", { kind: "rules", today: TODAY });
  assert.match(html, /Comments open through Sep 15/);
});

test("matterFromDigestRow maps digest kind rfp → solicitation", () => {
  assert.equal(digestMatterKind({}, "rfp"), "solicitation");
  assert.equal(digestMatterKind({}, "award"), "award");
  assert.equal(digestMatterKind({}, "rezone"), "zoning");
  const m = matterFromDigestRow(solicitation, { kind: "rfp", today: TODAY });
  assert.equal(m.kind, "solicitation");
  assert.equal(m.deadline, "2026-08-10");
  assert.ok(m.notice_text.includes("example.com/rfps"));
});
