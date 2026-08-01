import assert from "node:assert/strict";
import { test } from "node:test";

import { processOneSub, subDigestHtml } from "../src/alerts.mjs";
import { RULES_KV_KEY } from "../src/rules.mjs";
import {
  commentCloseValidAt,
  reconcileTemporalCandidates,
  ruleActionKey,
} from "../src/lib/alert_temporal.mjs";

class MockKV {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(seed));
  }
  async get(key) { return this.store.get(key) ?? null; }
  async put(key, value) { this.store.set(key, String(value)); }
}

const TEST_EMAIL = ["user", "example.test"].join("@");
const SUB_KEY = "sub:temporal-rules-01";
const NOTICE_ID = "20260715001";
const notice = {
  request_id: NOTICE_ID,
  start_date: "2026-07-15T00:00:00.000",
  agency_name: "Department of Transportation",
  short_title: "Commercial curb-use rule",
  section_name: "Agency Rules",
  additional_description_1: "Proposed curb-use requirements.",
};

function rulesView({ generatedAt, publicationAt }) {
  return {
    schema_version: 1,
    generated_at: generatedAt,
    source: { enrichment: { status: "ok" } },
    rules: [{
      request_id: NOTICE_ID,
      agency: notice.agency_name,
      title: notice.short_title,
      notice_date: notice.start_date,
      stage: "comment-open",
      city_record: { request_id: NOTICE_ID },
      nyc_rules: {
        url: "https://rules.cityofnewyork.us/rule/commercial-curb-use/",
        guid: "https://rules.cityofnewyork.us/?p=1234",
        pub_date: publicationAt,
        comment_by_date: "2026-09-15",
        hearing_date: "2026-09-10",
      },
      join: { matched: true, confidence: "high" },
    }],
  };
}

function context(today = "2026-08-01") {
  return {
    FROM: "CityScroll",
    LIVE: true,
    heartbeatDays: 14,
    today,
    isMonday: false,
    counts: () => ({ "per-run": 0, daily: 0 }),
    caps: { "per-run": 25, daily: 50 },
    onSent: async () => {},
  };
}

function subscription() {
  return {
    key: SUB_KEY,
    email: TEST_EMAIL,
    lens: "rules",
    filter: { agency: notice.agency_name },
    freq: "daily",
    channel: "email",
    createdAt: "2026-07-01T00:00:00.000Z",
    lang: "en",
  };
}

test("a Rules RSS enrichment observed after its City Record notice still sends once, while a republish does not send twice", async () => {
  const ALERT_STATE = new MockKV({
    [`seen:${SUB_KEY}`]: JSON.stringify([NOTICE_ID]),
    [RULES_KV_KEY]: JSON.stringify(rulesView({
      generatedAt: "2026-08-01T12:55:00.000Z",
      publicationAt: "2026-08-01T12:30:00.000Z",
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
    if (value.includes("data.cityofnewyork.us")) return Response.json([notice]);
    if (value.includes("api.resend.com/emails")) {
      sent.push(JSON.parse(options.body));
      return Response.json({ id: `email-${sent.length}` });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  try {
    const first = await processOneSub(env, subscription(), context());
    assert.equal(first.error, undefined, JSON.stringify(first));
    assert.equal(first.sent, true, "late enrichment should create a fresh delivery event");
    assert.equal(first.new, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].html, /Comments open through Sep 15/i);
    assert.match(sent[0].html, /rules\.cityofnewyork\.us\/rule\/commercial-curb-use/i);

    // The publisher may republish the same item with a new publication timestamp and the
    // materializer necessarily records it at a later processing time. Neither timestamp is
    // the delivery identity: the source record + actionable state remains the same.
    await ALERT_STATE.put(RULES_KV_KEY, JSON.stringify(rulesView({
      generatedAt: "2026-08-02T12:55:00.000Z",
      publicationAt: "2026-08-02T12:30:00.000Z",
    })));
    const second = await processOneSub(env, subscription(), context("2026-08-02"));
    assert.equal(second.error, undefined, JSON.stringify(second));
    assert.equal(second.sent, false, "republishing the same actionable state must be idempotent");
    assert.equal(second.new, 0);
    assert.equal(sent.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("temporal reconciliation preserves source-specific identifiers for other digest lenses", () => {
  const rows = [{ project_id: "P2026M001", project_name: "Harbor rezoning" }];
  const current = reconcileTemporalCandidates({
    lens: "land",
    rows,
    seen: new Set(),
    idField: "project_id",
  });
  assert.deepEqual(current.fresh, rows);
  assert.deepEqual(current.markSeenIds, ["P2026M001"]);

  const seen = reconcileTemporalCandidates({
    lens: "land",
    rows,
    seen: new Set(["P2026M001"]),
    idField: "project_id",
  });
  assert.deepEqual(seen.fresh, []);
});

test("the actionable late-arrival line follows the digest language", () => {
  const html = subDigestHtml(
    "reglas",
    "rules",
    [{
      ...notice,
      temporal_action: {
        kind: "rules-comment-open",
        event_at: "2026-09-15",
        url: "https://rules.cityofnewyork.us/rule/commercial-curb-use/",
      },
    }],
    "https://api.cityscroll.org/unsubscribe?token=test",
    "2026-08-01",
    "https://api.cityscroll.org",
    [],
    "es",
  );
  assert.match(html, /Comentarios abiertos hasta Sep 15/);
  assert.match(html, /Comentar en NYC Rules/);
  assert.doesNotMatch(html, /Comments open through/);
});

test("comment-close valid_at from the event spine wins over a stale flattened field", () => {
  const record = {
    request_id: NOTICE_ID,
    stage: "comment-open",
    nyc_rules: {
      url: "https://rules.cityofnewyork.us/rule/commercial-curb-use/",
      comment_by_date: "2026-09-01",
      pub_date: "2026-07-15T12:00:00.000Z",
    },
    events: [{
      event_type: "comment_close",
      valid_at: "2026-09-20",
      valid_at_precision: "day",
      status: "scheduled",
      alert: { eligible: true, trigger_field: "valid_at", lead_days: [14, 3, 1, 0] },
    }],
  };
  assert.equal(commentCloseValidAt(record), "2026-09-20");
  assert.equal(ruleActionKey(record), `temporal:rules:${NOTICE_ID}:comment-open:2026-09-20`);

  const reconciled = reconcileTemporalCandidates({
    lens: "rules",
    rows: [notice],
    seen: new Set([NOTICE_ID]),
    rulesView: { generated_at: "2026-08-01T12:00:00.000Z", rules: [record] },
  });
  assert.equal(reconciled.fresh.length, 1);
  assert.deepEqual(reconciled.fresh[0].temporal_action, {
    kind: "rules-comment-open",
    event_at: "2026-09-20",
    trigger_field: "valid_at",
    event_type: "comment_close",
    publication_at: "2026-07-15T12:00:00.000Z",
    recorded_at: "2026-08-01T12:00:00.000Z",
    url: "https://rules.cityofnewyork.us/rule/commercial-curb-use/",
  });
});

test("without a spine event, digests still cite the flattened comment_by_date as valid time", () => {
  const record = {
    request_id: NOTICE_ID,
    stage: "comment-open",
    nyc_rules: {
      url: "https://rules.cityofnewyork.us/rule/commercial-curb-use/",
      comment_by_date: "2026-09-15",
      pub_date: "2026-07-15T12:00:00.000Z",
    },
    events: [],
  };
  assert.equal(commentCloseValidAt(record), "2026-09-15");
  const reconciled = reconcileTemporalCandidates({
    lens: "rules",
    rows: [notice],
    seen: new Set(),
    rulesView: { generated_at: "2026-08-01T12:00:00.000Z", rules: [record] },
  });
  assert.equal(reconciled.fresh[0].temporal_action.event_at, "2026-09-15");
  assert.equal(reconciled.fresh[0].temporal_action.trigger_field, "valid_at");
  assert.equal(reconciled.fresh[0].temporal_action.event_type, "comment_close");
});
