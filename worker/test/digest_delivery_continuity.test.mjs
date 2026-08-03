// Delivery-continuity regressions for digest/alert upgrades (owner priority).
//
// Standing failure class: after deploy, alerts silently stop (or flood), forcing a
// manual watermark backfill of seen-state. These tests lock delivery-identity key
// derivation and prove pre-existing subscriber state still works with the upgraded
// render path — no flood of already-delivered items, no silent skip of new ones.
//
// Contract: docs/digest-time-ontology.md + worker/src/lib/alert_temporal.mjs
// Render path under test: reconcileTemporalCandidates → subDigestHtml / itemAwarenessHtml

import assert from "node:assert/strict";
import { test } from "node:test";

import { processOneSub, subDigestHtml } from "../src/alerts.mjs";
import { RULES_KV_KEY } from "../src/rules.mjs";
import {
  reconcileTemporalCandidates,
  ruleActionKey,
  commentCloseValidAt,
} from "../src/lib/alert_temporal.mjs";
import { itemAwarenessHtml } from "../src/lib/digest_item_awareness.mjs";

// ---------------------------------------------------------------------------
// Fixture set — one row per digest kind this render upgrade touches.
// Synthetic FIX-* ids only (not live City Record / ZAP rows).
// ---------------------------------------------------------------------------

const TODAY = "2026-08-02";
const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;",
}[c]));

/** Solicitation / money RFP (request_id delivery key). */
const SOLICITATION = {
  request_id: "FIX-CONT-SOL-1",
  short_title: "Fixture street materials solicitation",
  agency_name: "Department of Transportation",
  type_of_notice_description: "Solicitation",
  due_date: "2026-08-10",
  pin: "DOT-RFQ-CONT-01",
  additional_description_1:
    "Vendors must download the solicitation documents at https://example.com/rfps before submitting.",
};

/** Award (request_id delivery key; no temporal semantic key). */
const AWARD = {
  request_id: "FIX-CONT-AWD-1",
  short_title: "Fixture snow maintenance award",
  agency_name: "Department of Sanitation",
  type_of_notice_description: "Award",
  vendor_name: "Acme Snow & Ice LLC",
  contract_amount: 250000,
  pin: "PIN-CONT-AWD-1",
};

/** Meetings / hearing (request_id). */
const MEETING = {
  request_id: "FIX-CONT-MTG-1",
  short_title: "Fixture public hearing",
  agency_name: "Mayor's Office of Contract Services",
  section_name: "Public Hearings and Meetings",
  type_of_notice_description: "Public Hearing",
  event_date: "2026-08-05",
  street_address_1: "1 Example Plaza",
  building_name: "Fixture Hall",
};

/** Property disposition (request_id). */
const PROPERTY = {
  request_id: "FIX-CONT-PROP-1",
  short_title: "Fixture parcel disposition hearing",
  agency_name: "Department of Citywide Administrative Services",
  section_name: "Property Disposition",
  type_of_notice_description: "Public Hearing",
  event_date: "2026-08-12",
};

/** Land / ZAP (project_id delivery key). */
const REZONE = {
  project_id: "FIX-CONT-ZAP-1",
  project_name: "Fixture harbor rezoning",
  public_status: "In Public Review",
  borough: "Manhattan",
  community_district: "1",
};

/** Agency Rules notice + open comment enrichment (notice id + temporal semantic key). */
const RULES_NOTICE_ID = "FIX-CONT-RULE-1";
const RULES_DEADLINE = "2026-09-15";
const RULES_NOTICE = {
  request_id: RULES_NOTICE_ID,
  start_date: "2026-07-15T00:00:00.000",
  agency_name: "Department of Transportation",
  short_title: "Fixture commercial curb-use rule",
  section_name: "Agency Rules",
  additional_description_1: "Proposed curb-use requirements.",
};

function rulesRecord({
  requestId = RULES_NOTICE_ID,
  deadline = RULES_DEADLINE,
  publicationAt = "2026-08-01T12:30:00.000Z",
  stage = "comment-open",
  url = "https://example.com/rules/fixture-curb-use/",
} = {}) {
  return {
    request_id: requestId,
    agency: RULES_NOTICE.agency_name,
    title: RULES_NOTICE.short_title,
    notice_date: RULES_NOTICE.start_date,
    stage,
    city_record: { request_id: requestId },
    nyc_rules: {
      url,
      guid: "https://example.com/rules/?p=fixture",
      pub_date: publicationAt,
      comment_by_date: deadline,
      hearing_date: "2026-09-10",
    },
    events: [{
      event_type: "comment_close",
      valid_at: deadline,
      valid_at_precision: "day",
      status: "scheduled",
    }],
    join: { matched: true, confidence: "high" },
  };
}

function rulesView({ generatedAt = "2026-08-01T12:55:00.000Z", rules = [rulesRecord()] } = {}) {
  return {
    schema_version: 1,
    generated_at: generatedAt,
    source: { enrichment: { status: "ok" } },
    rules,
  };
}

/**
 * Golden delivery-identity keys for this fixture set.
 * BYTE-STABLE: any silent change here is a deploy continuity break.
 * Source of derivation: worker/src/lib/alert_temporal.mjs
 *   - non-rules lenses: idField value only
 *   - rules comment-open: request_id + temporal:rules:{id}:comment-open:{deadline}
 */
const GOLDEN_KEYS = Object.freeze({
  solicitation: Object.freeze([SOLICITATION.request_id]),
  award: Object.freeze([AWARD.request_id]),
  meetings: Object.freeze([MEETING.request_id]),
  property: Object.freeze([PROPERTY.request_id]),
  land: Object.freeze([REZONE.project_id]),
  rules: Object.freeze([
    RULES_NOTICE_ID,
    `temporal:rules:${RULES_NOTICE_ID}:comment-open:${RULES_DEADLINE}`,
  ]),
});

// ---------------------------------------------------------------------------
// 1. Delivery-identity key stability (golden)
// ---------------------------------------------------------------------------

test("golden: solicitation delivery keys are request_id only (byte-stable)", () => {
  const { markSeenIds, fresh } = reconcileTemporalCandidates({
    lens: "money",
    rows: [SOLICITATION],
    seen: new Set(),
    idField: "request_id",
  });
  assert.deepEqual(markSeenIds, [...GOLDEN_KEYS.solicitation]);
  assert.equal(fresh.length, 1);
  // Render path must not invent a second delivery key.
  const html = itemAwarenessHtml(SOLICITATION, esc, "en", { kind: "rfp", today: TODAY });
  assert.match(html, /Solicitation|Closing soon|Next step/i);
});

test("golden: award delivery keys are request_id only (byte-stable)", () => {
  const { markSeenIds } = reconcileTemporalCandidates({
    lens: "money",
    rows: [AWARD],
    seen: new Set(),
    idField: "request_id",
  });
  assert.deepEqual(markSeenIds, [...GOLDEN_KEYS.award]);
});

test("golden: meetings delivery keys are request_id only (byte-stable)", () => {
  const { markSeenIds } = reconcileTemporalCandidates({
    lens: "meetings",
    rows: [MEETING],
    seen: new Set(),
    idField: "request_id",
  });
  assert.deepEqual(markSeenIds, [...GOLDEN_KEYS.meetings]);
});

test("golden: property delivery keys are request_id only (byte-stable)", () => {
  const { markSeenIds } = reconcileTemporalCandidates({
    lens: "property",
    rows: [PROPERTY],
    seen: new Set(),
    idField: "request_id",
  });
  assert.deepEqual(markSeenIds, [...GOLDEN_KEYS.property]);
});

test("golden: land/ZAP delivery keys are project_id only (byte-stable)", () => {
  const { markSeenIds } = reconcileTemporalCandidates({
    lens: "land",
    rows: [REZONE],
    seen: new Set(),
    idField: "project_id",
  });
  assert.deepEqual(markSeenIds, [...GOLDEN_KEYS.land]);
});

test("golden: rules open-comment keys are notice id + temporal:rules:…:comment-open:{deadline}", () => {
  const record = rulesRecord();
  // Pure key helper (same string production markSeen persists).
  assert.equal(
    ruleActionKey(record),
    `temporal:rules:${RULES_NOTICE_ID}:comment-open:${RULES_DEADLINE}`,
  );
  assert.equal(commentCloseValidAt(record), RULES_DEADLINE);

  const { markSeenIds, fresh } = reconcileTemporalCandidates({
    lens: "rules",
    rows: [RULES_NOTICE],
    seen: new Set(),
    rulesView: rulesView({ rules: [record] }),
    idField: "request_id",
  });
  assert.deepEqual(markSeenIds, [...GOLDEN_KEYS.rules]);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].temporal_action?.kind, "rules-comment-open");
  assert.equal(fresh[0].temporal_action?.event_at, RULES_DEADLINE);
});

test("golden: full multi-type markSeen set is byte-identical to the frozen inventory", () => {
  // One reconcile per kind, then union — same set a subscriber could hold after a mixed week.
  const inventory = [];
  inventory.push(...reconcileTemporalCandidates({
    lens: "money", rows: [SOLICITATION, AWARD], seen: new Set(), idField: "request_id",
  }).markSeenIds);
  inventory.push(...reconcileTemporalCandidates({
    lens: "meetings", rows: [MEETING], seen: new Set(), idField: "request_id",
  }).markSeenIds);
  inventory.push(...reconcileTemporalCandidates({
    lens: "property", rows: [PROPERTY], seen: new Set(), idField: "request_id",
  }).markSeenIds);
  inventory.push(...reconcileTemporalCandidates({
    lens: "land", rows: [REZONE], seen: new Set(), idField: "project_id",
  }).markSeenIds);
  inventory.push(...reconcileTemporalCandidates({
    lens: "rules",
    rows: [RULES_NOTICE],
    seen: new Set(),
    rulesView: rulesView(),
    idField: "request_id",
  }).markSeenIds);

  const expected = [
    ...GOLDEN_KEYS.solicitation,
    ...GOLDEN_KEYS.award,
    ...GOLDEN_KEYS.meetings,
    ...GOLDEN_KEYS.property,
    ...GOLDEN_KEYS.land,
    ...GOLDEN_KEYS.rules,
  ];
  assert.deepEqual(inventory, expected, "key inventory drift — would force a seen-state migration");
});

// ---------------------------------------------------------------------------
// 2. Deploy-continuity: pre-existing main seen-state + upgraded digest
// ---------------------------------------------------------------------------

test("deploy continuity: pre-existing seen state does not flood already-delivered items", () => {
  // Simulate keys produced by CURRENT main (same derivation — golden above).
  const preExistingSeen = new Set([
    ...GOLDEN_KEYS.solicitation,
    ...GOLDEN_KEYS.award,
    ...GOLDEN_KEYS.meetings,
    ...GOLDEN_KEYS.property,
    ...GOLDEN_KEYS.land,
    ...GOLDEN_KEYS.rules,
  ]);

  // Same sources again after the render upgrade.
  const money = reconcileTemporalCandidates({
    lens: "money",
    rows: [SOLICITATION, AWARD],
    seen: preExistingSeen,
    idField: "request_id",
  });
  assert.equal(money.fresh.length, 0, "already-delivered money items must not resend");

  const meetings = reconcileTemporalCandidates({
    lens: "meetings", rows: [MEETING], seen: preExistingSeen, idField: "request_id",
  });
  assert.equal(meetings.fresh.length, 0);

  const property = reconcileTemporalCandidates({
    lens: "property", rows: [PROPERTY], seen: preExistingSeen, idField: "request_id",
  });
  assert.equal(property.fresh.length, 0);

  const land = reconcileTemporalCandidates({
    lens: "land", rows: [REZONE], seen: preExistingSeen, idField: "project_id",
  });
  assert.equal(land.fresh.length, 0);

  const rules = reconcileTemporalCandidates({
    lens: "rules",
    rows: [RULES_NOTICE],
    seen: preExistingSeen,
    rulesView: rulesView({
      generatedAt: "2026-08-03T12:00:00.000Z", // later recorded time — still same keys
      rules: [rulesRecord({ publicationAt: "2026-08-03T11:00:00.000Z" })],
    }),
    idField: "request_id",
  });
  assert.equal(rules.fresh.length, 0, "already-delivered rules action must not resend");
});

test("deploy continuity: genuinely new items still send under pre-existing seen state", () => {
  const preExistingSeen = new Set([...GOLDEN_KEYS.solicitation, ...GOLDEN_KEYS.rules]);

  const newSolicitation = {
    ...SOLICITATION,
    request_id: "FIX-CONT-SOL-2",
    short_title: "Fixture new solicitation after deploy",
  };
  const money = reconcileTemporalCandidates({
    lens: "money",
    rows: [SOLICITATION, newSolicitation],
    seen: preExistingSeen,
    idField: "request_id",
  });
  assert.equal(money.fresh.length, 1, "only the new solicitation is fresh");
  assert.equal(money.fresh[0].request_id, "FIX-CONT-SOL-2");
  assert.ok(money.markSeenIds.includes("FIX-CONT-SOL-2"));
  assert.ok(money.markSeenIds.includes(SOLICITATION.request_id));

  // New rules notice (never delivered) fires even when a sibling action is already seen.
  const newRulesId = "FIX-CONT-RULE-2";
  const newRulesNotice = { ...RULES_NOTICE, request_id: newRulesId, short_title: "Fixture new rule" };
  const rules = reconcileTemporalCandidates({
    lens: "rules",
    rows: [RULES_NOTICE, newRulesNotice],
    seen: preExistingSeen,
    rulesView: rulesView({
      rules: [
        rulesRecord(),
        rulesRecord({ requestId: newRulesId, deadline: "2026-10-01" }),
      ],
    }),
    idField: "request_id",
  });
  assert.equal(rules.fresh.length, 1);
  assert.equal(rules.fresh[0].request_id, newRulesId);
  assert.equal(
    rules.fresh[0].temporal_action?.event_at,
    "2026-10-01",
  );
});

// ---------------------------------------------------------------------------
// 3. Timestamp-republish suppression (publication / recorded clocks)
// ---------------------------------------------------------------------------

test("republish: publication + recorded timestamp churn does not resend rules action", () => {
  const key = ruleActionKey(rulesRecord());
  assert.equal(key, GOLDEN_KEYS.rules[1]);

  const seen = new Set([RULES_NOTICE_ID, key]);
  const first = reconcileTemporalCandidates({
    lens: "rules",
    rows: [RULES_NOTICE],
    seen,
    rulesView: rulesView({
      generatedAt: "2026-08-01T12:55:00.000Z",
      rules: [rulesRecord({ publicationAt: "2026-08-01T12:30:00.000Z" })],
    }),
  });
  assert.equal(first.fresh.length, 0);

  // Publisher republishes; materializer re-records later. Delivery identity unchanged.
  const second = reconcileTemporalCandidates({
    lens: "rules",
    rows: [RULES_NOTICE],
    seen,
    rulesView: rulesView({
      generatedAt: "2026-08-04T09:00:00.000Z",
      rules: [rulesRecord({ publicationAt: "2026-08-04T08:45:00.000Z" })],
    }),
  });
  assert.equal(second.fresh.length, 0);
  assert.equal(
    ruleActionKey(rulesRecord({ publicationAt: "2026-08-04T08:45:00.000Z" })),
    key,
    "publication churn must not mint a new delivery key",
  );
});

test("republish: non-rules notice republished under same request_id does not resend", () => {
  const seen = new Set([SOLICITATION.request_id]);
  // Content fields change (title/description) — delivery id is still request_id.
  const republished = {
    ...SOLICITATION,
    short_title: "Fixture street materials solicitation (revised title)",
    additional_description_1: "Updated body text only.",
    start_date: "2026-08-03T00:00:00.000",
  };
  const r = reconcileTemporalCandidates({
    lens: "money",
    rows: [republished],
    seen,
    idField: "request_id",
  });
  assert.equal(r.fresh.length, 0);
});

// ---------------------------------------------------------------------------
// 4. Genuinely new actionable state / deadline still fires
// ---------------------------------------------------------------------------

test("new actionable state: deadline change mints a new temporal key and sends", () => {
  const oldKey = `temporal:rules:${RULES_NOTICE_ID}:comment-open:${RULES_DEADLINE}`;
  const seen = new Set([RULES_NOTICE_ID, oldKey]);

  const newDeadline = "2026-09-30";
  const r = reconcileTemporalCandidates({
    lens: "rules",
    rows: [RULES_NOTICE],
    seen,
    rulesView: rulesView({
      rules: [rulesRecord({ deadline: newDeadline })],
    }),
  });
  assert.equal(r.fresh.length, 1, "deadline change is a new actionable state");
  assert.equal(r.fresh[0].temporal_action.event_at, newDeadline);
  const newKey = `temporal:rules:${RULES_NOTICE_ID}:comment-open:${newDeadline}`;
  assert.ok(r.markSeenIds.includes(newKey));
  assert.notEqual(newKey, oldKey);

  // Upgraded render path still surfaces the new deadline.
  const html = itemAwarenessHtml(r.fresh[0], esc, "en", { kind: "rules", today: TODAY });
  assert.match(html, /Comments open through Sep 30/);
});

test("new actionable state: late RSS enrichment after notice-only delivery still sends once", () => {
  // Main often delivered the City Record notice id first; enrichment arrives later.
  const seen = new Set([RULES_NOTICE_ID]); // notice delivered; temporal action never marked
  const r = reconcileTemporalCandidates({
    lens: "rules",
    rows: [RULES_NOTICE],
    seen,
    rulesView: rulesView(),
  });
  assert.equal(r.fresh.length, 1);
  assert.equal(r.fresh[0].temporal_action?.kind, "rules-comment-open");
  assert.ok(r.markSeenIds.includes(GOLDEN_KEYS.rules[1]));
});

// ---------------------------------------------------------------------------
// End-to-end: processOneSub with pre-seeded seen + upgraded HTML path
// ---------------------------------------------------------------------------

class MockKV {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(seed));
  }
  async get(key) { return this.store.get(key) ?? null; }
  async put(key, value) { this.store.set(key, String(value)); }
}

test("e2e continuity: processOneSub with main-era seen keys neither floods nor skips", async () => {
  const SUB_KEY = "sub:continuity-rules-01";
  const TEST_EMAIL = ["continuity", "example.test"].join("@");
  // Pre-seed as if main already delivered the notice + open-comment action.
  // lastsent prevents a confidence heartbeat from looking like a "flood" of content.
  const ALERT_STATE = new MockKV({
    [`seen:${SUB_KEY}`]: JSON.stringify([...GOLDEN_KEYS.rules]),
    [`lastsent:${SUB_KEY}`]: "2026-08-02",
    [RULES_KV_KEY]: JSON.stringify(rulesView({
      generatedAt: "2026-08-03T12:00:00.000Z",
      rules: [rulesRecord({ publicationAt: "2026-08-03T11:30:00.000Z" })],
    })),
  });
  const env = {
    ALERT_STATE,
    RESEND_API_KEY: "test-key",
    TOKEN_SECRET: "s".repeat(32),
    CONFIRM_BASE: "https://api.cityscroll.org",
  };
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const value = String(url);
    if (value.includes("data.cityofnewyork.us")) return Response.json([RULES_NOTICE]);
    if (value.includes("api.resend.com/emails")) {
      sent.push(JSON.parse(options.body));
      return Response.json({ id: `email-${sent.length}` });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  try {
    const ctx = {
      FROM: "CityScroll",
      LIVE: true,
      heartbeatDays: 14,
      today: "2026-08-03",
      isMonday: false,
      counts: () => ({ "per-run": 0, daily: 0 }),
      caps: { "per-run": 25, daily: 50 },
      onSent: async () => {},
    };
    const sub = {
      key: SUB_KEY,
      email: TEST_EMAIL,
      lens: "rules",
      filter: { agency: RULES_NOTICE.agency_name },
      freq: "daily",
      channel: "email",
      createdAt: "2026-07-01T00:00:00.000Z",
      lang: "en",
    };

    // Same sources + churned publication: no fresh items (no flood of re-delivered content).
    const quiet = await processOneSub(env, sub, ctx);
    assert.equal(quiet.error, undefined, JSON.stringify(quiet));
    assert.equal(quiet.new, 0, "already-delivered keys must yield zero fresh items");
    assert.notEqual(quiet.action, "match", "must not re-match already-delivered notices");
    assert.equal(quiet.sent, false, "no content email when nothing is fresh (lastsent recent)");
    assert.equal(sent.length, 0);

    // Deadline change → new actionable state → one send (no silent skip).
    await ALERT_STATE.put(RULES_KV_KEY, JSON.stringify(rulesView({
      generatedAt: "2026-08-04T12:00:00.000Z",
      rules: [rulesRecord({ deadline: "2026-09-30", publicationAt: "2026-08-04T11:00:00.000Z" })],
    })));
    const again = await processOneSub(env, sub, { ...ctx, today: "2026-08-04" });
    assert.equal(again.error, undefined, JSON.stringify(again));
    assert.equal(again.sent, true, "new deadline must still fire through upgraded path");
    assert.equal(again.new, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].html, /Comments open through Sep 30/i);
    // Upgraded awareness chrome may also be present; must not break the classic line.
    assert.match(sent[0].html, /Comment on NYC Rules|example\.com\/rules/i);

    // Seen advanced with the NEW temporal key (old key remains; no full wipe).
    const seenAfter = JSON.parse(await ALERT_STATE.get(`seen:${SUB_KEY}`));
    assert.ok(seenAfter.includes(RULES_NOTICE_ID));
    assert.ok(seenAfter.includes(GOLDEN_KEYS.rules[1]), "prior temporal key retained");
    assert.ok(
      seenAfter.includes(`temporal:rules:${RULES_NOTICE_ID}:comment-open:2026-09-30`),
      "new deadline key recorded after send",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("e2e continuity: upgraded subDigestHtml still renders under continuity keys", () => {
  // Prove the HTML path used after reconcile still works for multi-kind fixtures
  // without changing which ids would be markSeen'd.
  const rows = [SOLICITATION, AWARD];
  const { markSeenIds } = reconcileTemporalCandidates({
    lens: "money",
    rows,
    seen: new Set(),
    idField: "request_id",
  });
  assert.deepEqual(markSeenIds, [SOLICITATION.request_id, AWARD.request_id]);

  const html = subDigestHtml(
    "continuity — money",
    "rfp",
    [SOLICITATION],
    "https://api.cityscroll.org/unsubscribe?token=continuity",
    "2026-07-31",
    "https://api.cityscroll.org",
    [],
    "en",
    [],
  );
  assert.match(html, /Solicitation|Closing soon|Next step|example\.com\/rfps/i);
  assert.doesNotMatch(html, /use the response instructions in the official notice/i);
});
