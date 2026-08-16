import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  DIGEST_SHADOW_ATTENTION,
  DIGEST_SHADOW_READY,
  buildDigestShadowSummary,
  runDigestShadow,
} from "../src/digest_shadow.mjs";
import { handleAdminDigestShadow } from "../src/admin.mjs";
import { ONTOLOGY_DELTA_EVENT_SCHEMA } from "../src/lib/ontology_delta_alert.mjs";

const NOW = new Date("2026-08-04T10:00:00.000Z");
const HOLD_NOW = new Date("2026-08-04T13:00:00.000Z");

function itemHtml(count, { unsubscribe = true, context = true, badHref = null } = {}) {
  const items = Array.from({ length: count }, (_, index) =>
    `<li data-digest-item="1">item ${index + 1}</li>`).join("");
  const links = [
    context ? '<a href="https://cityscroll.org/#notice/1">View</a>' : "",
    unsubscribe ? '<a href="https://api.cityscroll.org/unsubscribe?example=1">Unsubscribe</a>' : "",
    badHref != null ? `<a href="${badHref}">Broken</a>` : "",
  ].join("");
  return `<ul>${items}</ul>${links}`;
}

function result({ id = "sub:ab***", previewId = null, count = 1, html = itemHtml(count), sections = null } = {}) {
  return {
    sub: id,
    ...(previewId ? { previewId } : {}),
    lens: "money",
    emailRedacted: "ab***@example.com",
    new: count,
    forecasts: 0,
    action: count ? "match" : "heartbeat",
    dryRun: true,
    ...(sections ? { sections } : {}),
    preview: { subject: "CityScroll preview", html, listUnsubscribe: "<https://api.cityscroll.org/unsubscribe?example=1>" },
  };
}

function summary(results, history = []) {
  return buildDigestShadowSummary({ run: { results }, history, now: NOW });
}

test("render errors are structured redlines with digest id, reason, and evidence", () => {
  const out = summary([{ sub: "sub:er***", error: "template exploded" }]);
  assert.equal(out.status, DIGEST_SHADOW_ATTENTION);
  assert.deepEqual(out.redlines[0], {
    code: "render_error",
    digest_id: "sub:er***",
    watch_id: null,
    reason: "The digest build path returned an error.",
    evidence: { error: "template exploded" },
  });
});

test("a zero-item watch with trailing item history redlines", () => {
  const sections = [{ sub: "sub:wa***", previewId: "watch:opaque", lens: "rules", new: 0, forecasts: 0 }];
  const history = [{
    day: "2026-08-03",
    totalNotices: 3,
    sentCount: 1,
    entries: [{ id: "acct:ab***", sections: [{ sub: "sub:wa***", new: 3, forecasts: 0 }] }],
  }];
  const out = summary([result({ id: "acct:ab***", count: 0, html: itemHtml(0), sections })], history);
  const warning = out.redlines.find((item) => item.code === "historical_watch_zero");
  assert.equal(warning.digest_id, "acct:ab***");
  assert.equal(warning.watch_id, "watch:opaque");
  assert.equal(warning.evidence.trailing_max_item_count, 3);
});

test("a schedule-skipped weekly watch does not masquerade as a recall drop", () => {
  const sections = [{
    sub: "sub:we***",
    previewId: "watch:weekly",
    lens: "money",
    new: 0,
    forecasts: 0,
    skipped: "weekly",
  }];
  const history = [{
    day: "2026-08-07",
    totalNotices: 25,
    sentCount: 1,
    entries: [{ id: "acct:we***", sections: [{ sub: "sub:we***", new: 1, forecasts: 0 }] }],
  }];
  const out = summary([result({ id: "acct:we***", count: 0, html: itemHtml(0), sections })], history);

  assert.equal(out.redlines.find((item) => item.code === "historical_watch_zero"), undefined);
  assert.deepEqual(out.per_watch_item_counts[0], {
    digest_id: "acct:we***",
    watch_id: "watch:weekly",
    lens: "money",
    item_count: 0,
    evaluation_state: "skipped",
    skip_reason: "weekly",
  });
  assert.equal(out.previews[0].watch_counts[0].skip_reason, "weekly");
});

test("aggregate item-count collapse versus trailing average redlines", () => {
  const history = [20, 24, 16].map((total, index) => ({ day: `2026-08-0${3 - index}`, totalNotices: total, entries: [] }));
  const out = summary([result({ count: 1 })], history);
  const warning = out.redlines.find((item) => item.code === "aggregate_count_collapse");
  assert.ok(warning);
  assert.equal(warning.digest_id, "run");
  assert.equal(warning.evidence.current_item_count, 1);
});

test("aggregate item-count explosion versus trailing average redlines", () => {
  const history = [10, 10, 10].map((total, index) => ({ day: `2026-08-0${3 - index}`, totalNotices: total, entries: [] }));
  const out = summary([result({ count: 50, html: itemHtml(50) })], history);
  assert.ok(out.redlines.some((item) => item.code === "aggregate_count_explosion"));
});

test("declared count must equal the rendered digest item list", () => {
  const out = summary([result({ count: 2, html: itemHtml(1) })]);
  const warning = out.redlines.find((item) => item.code === "count_list_mismatch");
  assert.deepEqual(warning.evidence, { declared_item_count: 2, rendered_item_count: 1 });
});

test("missing or malformed unsubscribe/context links redline", () => {
  const out = summary([result({ count: 1, html: itemHtml(1, { unsubscribe: false, context: false, badHref: "#" }) })]);
  const warning = out.redlines.find((item) => item.code === "broken_digest_link");
  assert.ok(warning);
  assert.deepEqual(warning.evidence.invalid_hrefs, ["#"]);
  assert.equal(warning.evidence.unsubscribe_present, false);
  assert.equal(warning.evidence.context_present, false);
});

test("clean summary exposes counts, prior-send deltas, and repair contract", () => {
  const history = [{ day: "2026-08-03", totalNotices: 1, sentCount: 1, entries: [] }];
  const out = summary([result()], history);
  assert.equal(out.status, DIGEST_SHADOW_READY);
  assert.equal(out.ok, true);
  assert.equal(out.digest_count, 1);
  assert.equal(out.total_items, 1);
  assert.deepEqual(out.delta_vs_yesterday_send, { digest_count: 0, item_count: 0, yesterday_present: true });
  assert.deepEqual(out.redlines, []);
  assert.equal(out.repair.rerun_method, "POST /admin/digest-shadow");
});

test("opaque preview ids keep masked-recipient collisions independently addressable", () => {
  const out = summary([
    result({ id: "account:ab***", previewId: "digest:111", count: 1 }),
    result({ id: "account:ab***", previewId: "digest:222", count: 1 }),
  ]);
  assert.equal(out.digest_count, 2);
  assert.deepEqual(out.previews.map((preview) => preview.digest_id), ["digest:111", "digest:222"]);
});

function writeOnlyDb() {
  const batches = [];
  const runs = [];
  const transitionKeys = new Set();
  return {
    batches,
    runs,
    transitionKeys,
    prepare(sql) {
      return {
        bind: (...args) => ({
          sql,
          args,
          all: async () => ({ results: [] }),
          run: async () => {
            runs.push({ sql, args });
            if (sql.includes("INSERT OR IGNORE INTO ontology_delta_shadow_events")) {
              if (transitionKeys.has(args[0])) return { success: true, meta: { changes: 0 } };
              transitionKeys.add(args[0]);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 1 } };
          },
        }),
      };
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };
}

test("shadow invocation uses the shared runAlerts path inline and cannot deliver or advance state", async () => {
  const DB = writeOnlyDb();
  const calls = [];
  let notified = false;
  const out = await runDigestShadow({
    DB,
    ALERT_STATE: { get: async () => null },
    ALERTS_LIVE: "true",
    QUEUE_DIGESTS: "true",
    DIGEST_QUEUE: { send: async () => { throw new Error("queue must not be used"); } },
  }, {
    now: NOW,
    runAlertsFn: async (...args) => {
      calls.push(args);
      return { results: [result()] };
    },
    ontologyDeltaCandidates: [],
    notifyFn: async () => { notified = true; },
  });
  assert.equal(out.status, DIGEST_SHADOW_READY);
  assert.equal(notified, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].ALERTS_LIVE, "false");
  assert.equal(calls[0][0].QUEUE_DIGESTS, "false");
  assert.deepEqual(calls[0][2], {
    now: NOW,
    live: false,
    forceInline: true,
    queueCapSemantics: true,
    capturePreviews: true,
    advanceState: false,
    persist: false,
    simulateDryRunCounters: true,
  });
  assert.equal(DB.batches.length, 2);
  assert.equal(DB.runs.length, 2);
});

test("shadow failures produce no outbound email", async () => {
  const DB = writeOnlyDb();
  const originalFetch = globalThis.fetch;
  let outboundRequests = 0;
  globalThis.fetch = async () => {
    outboundRequests++;
    return new Response(null, { status: 202 });
  };
  try {
    const out = await runDigestShadow({
      DB,
      ALERT_STATE: { get: async () => null },
      RESEND_API_KEY: "test-resend-key",
      FEEDBACK_TO: "configured-recipient",
      ALERTS_FROM: "configured-sender",
    }, {
      now: NOW,
      runAlertsFn: async () => ({ results: [{ sub: "sub:er***", previewId: "digest:error", error: "render failed" }] }),
      ontologyDeltaCandidates: [],
    });
    assert.equal(out.status, DIGEST_SHADOW_ATTENTION);
    assert.equal(out.redlines.length, 1);
    assert.equal(out.redlines[0].code, "render_error");
    assert.equal(outboundRequests, 0);
    assert.equal("notification" in out, false);
    assert.equal(DB.batches.length, 2);
    assert.equal(DB.runs.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ontology-delta candidates enter the private shadow receipt once", async () => {
  const DB = writeOnlyDb();
  const candidate = {
    schema: ONTOLOGY_DELTA_EVENT_SCHEMA,
    event_type: "ontology_delta",
    dimension: "edge_type",
    value: "paid_to_vendor",
    scope: "civic_graph",
    transition_key: "ontology-delta:civic_graph:edge_type:paid_to_vendor:absent-to-present",
    old_state: { present: false, as_of: "2026-08-01T00:00:00.000Z" },
    new_state: { present: true, observed_at: NOW.toISOString() },
    shadow_only: true,
    promotion_state: "shadow",
  };
  const env = { DB, ALERT_STATE: { get: async () => null } };
  const options = {
    now: NOW,
    runAlertsFn: async () => ({ results: [result()] }),
    ontologyDeltaCandidates: [candidate],
  };

  const first = await runDigestShadow(env, options);
  const second = await runDigestShadow(env, options);

  assert.equal(first.ontology_delta.emitted_count, 1);
  assert.equal(first.ontology_delta.events[0].transition_key, candidate.transition_key);
  assert.equal(first.ontology_delta.receipts[0].action, "shadow_candidate");
  assert.equal(first.ontology_delta.receipts[0].sent, false);
  assert.equal(second.ontology_delta.emitted_count, 0);
  assert.equal(second.ontology_delta.events.length, 0);
  assert.equal(second.ontology_delta.receipts[0].action, "deduplicated");
  assert.equal(DB.transitionKeys.size, 1);
});

function readDb(summaryJson, preview = null) {
  return {
    prepare(sql) {
      const query = { sql, args: [] };
      query.bind = (...args) => { query.args = args; return query; };
      query.first = async () => {
        if (sql.includes("status = 'READY'")) return { run_day: summaryJson.run_day };
        if (sql.includes("digest_shadow_runs")) return { summary_json: JSON.stringify(summaryJson) };
        return preview;
      };
      query.all = async () => ({ results: [] });
      return query;
    },
  };
}

function receiptKv(receipt) {
  return {
    async get(key) {
      if (key === `digest:shadow:degraded:${receipt.run_day}`) return JSON.stringify(receipt);
      return null;
    },
  };
}

function holdDb(summaryJson) {
  const overrides = new Set();
  const persistedStates = [];
  return {
    overrides,
    persistedStates,
    prepare(sql) {
      return {
        bind: (...args) => ({
          sql,
          args,
          first: async () => (sql.includes("digest_shadow_runs")
            ? { summary_json: JSON.stringify(summaryJson) }
            : null),
          all: async () => ({ results: [...overrides].sort().map((digest_id) => ({ digest_id })) }),
          run: async () => {
            if (sql.includes("DELETE FROM digest_shadow_hold_overrides")) overrides.clear();
            if (sql.includes("digest_shadow_hold_states")) persistedStates.push(JSON.parse(args.at(-1)));
            return { success: true };
          },
        }),
      };
    },
    async batch(statements) {
      for (const statement of statements) {
        if (statement.sql.includes("digest_shadow_hold_overrides")) overrides.add(statement.args[1]);
      }
      return statements.map(() => ({ success: true }));
    },
  };
}

test("admin shadow endpoint fails closed and returns non-ok HTTP for machine pollers", async () => {
  assert.equal((await handleAdminDigestShadow(new Request("https://w/admin/digest-shadow"), {})).status, 404);
  const redlined = summary([{ sub: "sub:er***", error: "boom" }]);
  const response = await handleAdminDigestShadow(
    new Request("https://w/admin/digest-shadow", { headers: { authorization: "Bearer secret" } }),
    { ADMIN_KEY: "secret", DB: readDb(redlined) },
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.summary.status, DIGEST_SHADOW_ATTENTION);
  assert.equal(body.summary.redlines[0].digest_id, "sub:er***");
});

test("shadow status exposes an open degraded-path receipt and wakes machine pollers", async () => {
  const clean = summary([result()]);
  const receipt = {
    contract: "digest-shadow-degraded-decision.v1",
    run_day: clean.run_day,
    decision: "SEND_FAIL_OPEN",
    attention_status: "open",
  };
  const response = await handleAdminDigestShadow(
    new Request("https://w/admin/digest-shadow", { headers: { authorization: "Bearer secret" } }),
    { ADMIN_KEY: "secret", DB: readDb(clean), ALERT_STATE: receiptKv(receipt) },
    { now: NOW },
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).degraded_receipt.decision, "SEND_FAIL_OPEN");
});

test("GET /admin/digest-shadow accepts the read-only SHADOW_STATUS_KEY; POST rejects it", async () => {
  const clean = summary([result()]);
  const env = (extra = {}) => ({ ADMIN_KEY: "admin-key", SHADOW_STATUS_KEY: "shadow-key", DB: readDb(clean), ...extra });

  const getWithShadow = await handleAdminDigestShadow(
    new Request("https://w/admin/digest-shadow", { headers: { authorization: "Bearer shadow-key" } }),
    env(),
    { now: NOW },
  );
  assert.equal(getWithShadow.status, 200);

  // ADMIN_KEY GET still works through the same scoped gate.
  const getWithAdmin = await handleAdminDigestShadow(
    new Request("https://w/admin/digest-shadow", { headers: { authorization: "Bearer admin-key" } }),
    env(),
    { now: NOW },
  );
  assert.equal(getWithAdmin.status, 200);

  // SHADOW_STATUS_KEY via ?key= query param also authenticates GET.
  const getWithShadowQuery = await handleAdminDigestShadow(
    new Request("https://w/admin/digest-shadow?key=shadow-key"),
    env(),
    { now: NOW },
  );
  assert.equal(getWithShadowQuery.status, 200);

  // POST is a write path: SHADOW_STATUS_KEY must NOT authenticate it (401, not 200/503).
  const postWithShadow = await handleAdminDigestShadow(
    new Request("https://w/admin/digest-shadow", { method: "POST", headers: { authorization: "Bearer shadow-key" } }),
    env(),
  );
  assert.equal(postWithShadow.status, 401);

  // POST still authenticates for ADMIN_KEY. Send an invalid body so the handler returns 400
  // AFTER the auth gate (proving the key was accepted) without invoking the full run pipeline.
  const postWithAdmin = await handleAdminDigestShadow(
    new Request("https://w/admin/digest-shadow", { method: "POST", headers: { authorization: "Bearer admin-key", "content-type": "application/json" }, body: "{not-json" }),
    env(),
  );
  assert.equal(postWithAdmin.status, 400);
});

test("SHADOW_STATUS_KEY cannot substitute for ADMIN_KEY when ADMIN_KEY is the configured secret", async () => {
  const clean = summary([result()]);
  const env = { ADMIN_KEY: "admin-key", DB: readDb(clean) };
  const wrongKey = await handleAdminDigestShadow(
    new Request("https://w/admin/digest-shadow", { headers: { authorization: "Bearer not-the-key" } }),
    env,
  );
  assert.equal(wrongKey.status, 401);
  // No SHADOW_STATUS_KEY configured and a wrong key -> 401 (route is revealed by ADMIN_KEY being set).
  const noShadow = await handleAdminDigestShadow(
    new Request("https://w/admin/digest-shadow", { headers: { authorization: "Bearer shadow-key" } }),
    env,
  );
  assert.equal(noShadow.status, 401);
});

test("GET /admin/digest-shadow fails closed (404) when neither secret is configured", async () => {
  const closed = await handleAdminDigestShadow(
    new Request("https://w/admin/digest-shadow", { headers: { authorization: "Bearer anything" } }),
    { DB: readDb(summary([result()])) },
  );
  assert.equal(closed.status, 404);
});

test("authenticated operator override releases only a digest named by the redlined run", async () => {
  const redlined = summary([{ sub: "sub:er***", error: "boom" }]);
  const DB = holdDb(redlined);
  const response = await handleAdminDigestShadow(new Request("https://w/admin/digest-shadow", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({
      action: "override-hold",
      day: redlined.run_day,
      digest_ids: ["sub:er***"],
      reason: "Reviewed source output and approved delivery",
    }),
  }), { ADMIN_KEY: "secret", DB }, { now: HOLD_NOW });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.hold.overridden_digest_ids, ["sub:er***"]);
  assert.deepEqual(body.hold.active_digest_ids, []);
  assert.equal(body.hold.source_status, "REDLINES_AT_CUTOFF");
  assert.deepEqual([...DB.overrides], ["sub:er***"]);

  const invalid = await handleAdminDigestShadow(new Request("https://w/admin/digest-shadow", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({
      action: "override-hold",
      day: redlined.run_day,
      digest_ids: ["digest:unrelated"],
      reason: "Not actually affected",
    }),
  }), { ADMIN_KEY: "secret", DB }, { now: HOLD_NOW });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, "hold-override-failed");
});

test("Worker cron, D1 migration, and independent scheduled wake monitor are wired", () => {
  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../migrations/0014_digest_shadow.sql", import.meta.url), "utf8");
  const holdMigration = readFileSync(new URL("../migrations/0015_digest_shadow_hold.sql", import.meta.url), "utf8");
  const ontologyMigration = readFileSync(new URL("../migrations/0020_ontology_delta_shadow.sql", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../../.github/workflows/digest-shadow-monitor.yml", import.meta.url), "utf8");
  const runner = readFileSync(new URL("../../tools/external_schedule_runner.mjs", import.meta.url), "utf8");
  assert.match(wrangler, /crons\s*=\s*\[\s*"0 10 \* \* \*",\s*"0 13 \* \* \*",?\s*\]/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS digest_shadow_runs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS digest_shadow_previews/);
  assert.match(holdMigration, /CREATE TABLE IF NOT EXISTS digest_shadow_hold_states/);
  assert.match(ontologyMigration, /CREATE TABLE IF NOT EXISTS ontology_delta_shadow_events/);
  assert.match(ontologyMigration, /transition_key TEXT PRIMARY KEY/);
  const schedules = readFileSync(new URL("../../tools/external_schedule_jobs.json", import.meta.url), "utf8");
  assert.match(schedules, /"id": "digest-shadow-monitor"/);
  assert.match(schedules, /"10 13 \* \* \*"/);
  assert.match(runner, /degraded_receipt/);
  assert.match(holdMigration, /CREATE TABLE IF NOT EXISTS digest_shadow_hold_overrides/);
  assert.match(schedules, /"10 10 \* \* \*"/);
  assert.doesNotMatch(workflow, /schedule:|issues:\s*write|issues\.create/);
  assert.match(schedules, /"runner": "digest-shadow"/);
});
