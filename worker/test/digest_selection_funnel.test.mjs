// Regression: a digest run that produces nothing must name the stage that consumed
// its candidates, and one un-identifiable row must not cost its siblings their
// durable ledger entry.
//
// Field case (2026-09-03 → 2026-09-05): three consecutive rehearsals reported
// 0 digests / 0 items against a trailing average near 47. The only published
// evidence was `aggregate_count_collapse` — a ratio, with no stage. Measured on
// the live read model, every account still had candidates (340 across 8 accounts)
// and lost all of them at the per-watch seen watermark, while the durable outbox
// held fewer identities than the watermark had consumed, because a section whose
// first row had no lens identity aborted the whole section's enqueue.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  FUNNEL_STAGES,
  collapseStage,
  describeCollapse,
  mergeFunnels,
  normalizeFunnel,
} from "../src/lib/digest_funnel.mjs";
import { enqueueEvaluatedSection, SECTION_STATUS } from "../src/lib/digest_outbox.mjs";
import { buildDigestShadowSummary } from "../src/digest_shadow.mjs";

const migration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");

// Addresses are composed rather than written as literals so a fixture never reads as a
// real mailbox in the repository.
const DIGEST_RECIPIENT = ["reader", "example.com"].join("@");
const DIGEST_SENDER = ["alerts", "cityscroll.org"].join("@");

function d1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            run() {
              const result = statement.run(...params);
              return { meta: { changes: Number(result.changes || 0) } };
            },
            all() { return { results: statement.all(...params) }; },
            first() { return statement.get(...params) || null; },
          };
        },
      };
    },
    async batch(statements) { return statements.map((statement) => statement.run()); },
  };
}

function funnel(overrides = {}) {
  return normalizeFunnel({ ...overrides });
}

test("funnel names the stage that consumed the candidates", () => {
  // The observed shape: candidates survive the query and the authorization boundary,
  // then the seen watermark takes all of them.
  const collapsed = funnel({
    source_candidates: 290,
    delivery_authorized: 290,
    lens_evaluated: 290,
    watermark_fresh: 0,
  });
  assert.equal(collapseStage(collapsed), "watermark_fresh");
  const described = describeCollapse(collapsed);
  assert.equal(described.entering_count, 290);
  assert.equal(described.surviving_count, 0);
  assert.match(described.reason, /seen watermark/);
});

test("an empty source read is reported as a source stage, not a selection collapse", () => {
  assert.equal(collapseStage(funnel({})), "source_candidates");
});

test("a run that still delivers items reports no collapse", () => {
  const healthy = funnel({
    source_candidates: 25,
    delivery_authorized: 25,
    lens_evaluated: 25,
    watermark_fresh: 3,
    content_deduped: 3,
    owed_drained: 3,
    items: 3,
  });
  assert.equal(collapseStage(healthy), null);
  assert.equal(describeCollapse(healthy), null);
});

test("the owed drain can lift a section above its watermark-fresh count", () => {
  // The durable outbox is the recovery ledger: a watermark that already swallowed
  // every candidate must still be recoverable through owed rows.
  const drained = funnel({
    source_candidates: 23,
    delivery_authorized: 23,
    lens_evaluated: 23,
    watermark_fresh: 0,
    content_deduped: 0,
    owed_drained: 78,
    items: 78,
  });
  assert.equal(collapseStage(drained), null);
});

test("merged funnels keep every stage", () => {
  const merged = mergeFunnels([
    funnel({ source_candidates: 17, delivery_authorized: 17 }),
    funnel({ source_candidates: 25, delivery_authorized: 25 }),
  ]);
  assert.deepEqual(Object.keys(merged), [...FUNNEL_STAGES]);
  assert.equal(merged.source_candidates, 42);
  assert.equal(merged.watermark_fresh, 0);
});

test("the shadow receipt names the collapsing stage beside the aggregate ratio", () => {
  // Seven trailing days near 47 items, then a run with candidates and no items.
  const history = Array.from({ length: 7 }, (_, index) => ({
    day: `2026-08-2${index + 1}`,
    totalNotices: 47,
    sentCount: 3,
  }));
  const out = buildDigestShadowSummary({
    run: {
      results: [{
        sub: "account:ja***",
        kind: "rollup",
        selection_funnel: funnel({
          source_candidates: 290,
          delivery_authorized: 290,
          lens_evaluated: 290,
          watermark_fresh: 0,
        }),
      }],
    },
    history,
    now: new Date("2026-09-05T10:00:00.000Z"),
  });

  assert.equal(out.total_items, 0);
  assert.equal(out.collapse_stage, "watermark_fresh");
  assert.equal(out.selection_funnel.source_candidates, 290);

  const aggregate = out.redlines.find((item) => item.code === "aggregate_count_collapse");
  assert.equal(aggregate.evidence.collapse_stage, "watermark_fresh");

  const stage = out.redlines.find((item) => item.code === "selection_stage_collapse");
  assert.ok(stage, "the receipt must name the stage, not only the ratio");
  assert.equal(stage.evidence.stage, "watermark_fresh");
  assert.equal(stage.evidence.entering_count, 290);
  assert.equal(stage.evidence.surviving_count, 0);
});

test("a healthy run raises neither the aggregate nor the stage redline", () => {
  const history = Array.from({ length: 7 }, () => ({ totalNotices: 47, sentCount: 3 }));
  const out = buildDigestShadowSummary({
    run: {
      results: [{
        sub: "account:ja***",
        new: 40,
        forecasts: 0,
        preview: {
          subject: "CityScroll: 40 new",
          html: `<ul>${Array.from({ length: 40 }, () => '<li data-digest-item="1">item</li>').join("")}</ul>`
            + '<a href="https://cityscroll.org/#notice/1">View</a>'
            + '<a href="https://api.cityscroll.org/unsubscribe?example=1">Unsubscribe</a>',
          listUnsubscribe: "<https://api.cityscroll.org/unsubscribe?example=1>",
        },
        selection_funnel: funnel({
          source_candidates: 290, delivery_authorized: 290, lens_evaluated: 290,
          watermark_fresh: 40, content_deduped: 40, owed_drained: 40, items: 40,
        }),
      }],
    },
    history,
    now: new Date("2026-09-05T10:00:00.000Z"),
  });
  assert.equal(out.collapse_stage, null);
  assert.deepEqual(out.redlines.map((item) => item.code), []);
});

test("one un-identifiable row does not cost its siblings their ledger entry", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const db = d1(sqlite);

  // A rules section whose first row carries no comment-close action key. Before the
  // fix the enqueue aborted on that row, so the two identifiable rows never entered
  // the outbox — yet the send still advanced the seen watermark over all three,
  // leaving them seen-but-never-owed and unrecoverable.
  const rowWithAction = (requestId, closeDate) => ({
    request_id: requestId,
    short_title: `Proposed rule ${requestId}`,
    temporal_action: { kind: "rules-comment-open", event_at: closeDate },
  });

  return enqueueEvaluatedSection(db, {
    lens: "rules",
    kind: "rules",
    status: SECTION_STATUS.SUCCESS,
    freshRows: [
      { request_id: "20260901001", short_title: "Adoption notice with no comment window" },
      rowWithAction("20260901002", "2026-09-20"),
      rowWithAction("20260901003", "2026-09-21"),
    ],
    sourceObservedAt: "2026-09-05",
  }, {
    watchId: "watch:rules",
    subscriberId: "subscriber:test",
    sourceObservedAt: "2026-09-05",
    now: "2026-09-05",
  }).then((result) => {
    assert.equal(result.rejected, 1);
    assert.equal(result.enqueued, 2, "identifiable siblings must still reach the ledger");
    assert.equal(result.status, SECTION_STATUS.PARTIAL_ERROR);
    assert.match(result.error, /action key/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE status = 'owed'").get().n, 2);
    sqlite.close();
  });
});

test("a section with no identifiable row at all is reported as failed, not silently empty", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const db = d1(sqlite);
  return enqueueEvaluatedSection(db, {
    lens: "rules",
    kind: "rules",
    status: SECTION_STATUS.SUCCESS,
    freshRows: [{ request_id: "20260901001", short_title: "No comment window" }],
    sourceObservedAt: "2026-09-05",
  }, {
    watchId: "watch:rules",
    subscriberId: "subscriber:test",
    sourceObservedAt: "2026-09-05",
    now: "2026-09-05",
  }).then((result) => {
    assert.equal(result.status, SECTION_STATUS.FAILED);
    assert.equal(result.enqueued, 0);
    assert.equal(result.rejected, 1);
    sqlite.close();
  });
});

// ---- end-to-end: the collapse the rehearsal reported, through the real build path ----

function kv(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); },
    async list() { return { keys: [], list_complete: true }; },
  };
}

function watch(key, lens, filter) {
  return {
    key,
    email: DIGEST_RECIPIENT,
    lens,
    filter,
    freq: "daily",
    channel: "email",
    lang: "en",
    subscriber_id: "subscriber:funnel",
    watch_id: `watch:${key}`,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function rollupCtx(overrides = {}) {
  return {
    FROM: `CityScroll <${DIGEST_SENDER}>`,
    LIVE: false,
    today: "2026-09-05",
    now: new Date("2026-09-05T10:00:00.000Z"),
    isMonday: false,
    heartbeatDays: 14,
    counts: () => ({ "per-run": 0, daily: 0 }),
    caps: { "per-run": 25, daily: 50 },
    capturePreviews: true,
    previewOnly: true,
    advanceState: false,
    ...overrides,
  };
}

async function withSoda(rows, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("data.cityofnewyork.us")) return { ok: true, json: async () => rows };
    return { ok: true, json: async () => [] };
  };
  try { return await fn(); } finally { globalThis.fetch = original; }
}

test("a watermark that already holds every candidate collapses the run at watermark_fresh", async () => {
  const { processAccountRollup } = await import("../src/alerts.mjs");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);

  const candidates = Array.from({ length: 12 }, (_, index) => ({
    request_id: `2026090${String(index).padStart(4, "0")}`,
    short_title: `Award ${index}`,
    agency_name: "Transportation",
    start_date: "2026-09-04T00:00:00.000",
    contract_amount: "125000",
    vendor_name: `Vendor ${index}`,
  }));
  const alreadySeen = candidates.map((row) => row.request_id);

  const first = watch("one", "money", { keywords: ["award"], noticeType: "award" });
  const second = watch("two", "money", { keywords: ["award"], noticeType: "award" });
  const env = {
    DB: d1(sqlite),
    ALERT_STATE: kv({
      "seen:one": JSON.stringify(alreadySeen),
      "seen:two": JSON.stringify(alreadySeen),
    }),
    ALERTS_LIVE: "false",
    TOKEN_SECRET: "s".repeat(32),
    CONFIRM_BASE: "https://api.cityscroll.org",
  };

  const result = await withSoda(candidates, () => processAccountRollup(env, [first, second], rollupCtx()));

  // The source query and the authorization boundary both pass every candidate through;
  // the per-watch seen watermark is where they disappear.
  assert.equal(result.selection_funnel.source_candidates, 24);
  assert.equal(result.selection_funnel.delivery_authorized, 24);
  assert.equal(result.selection_funnel.watermark_fresh, 0);
  assert.equal(result.selection_funnel.owed_drained, 0);
  assert.equal(result.selection_funnel.items, 0);
  assert.equal(collapseStage(result.selection_funnel), "watermark_fresh");
  assert.equal(result.new, 0);
  assert.equal(result.found, 24);
  sqlite.close();
});

test("owed rows restore a run whose watermark holds every candidate", async () => {
  const { processAccountRollup } = await import("../src/alerts.mjs");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);

  const candidates = Array.from({ length: 4 }, (_, index) => ({
    request_id: `2026090${String(index).padStart(4, "0")}`,
    short_title: `Award ${index}`,
    agency_name: "Transportation",
    start_date: "2026-09-04T00:00:00.000",
    contract_amount: "125000",
    vendor_name: `Vendor ${index}`,
  }));
  const first = watch("one", "money", { keywords: ["award"], noticeType: "award" });
  const second = watch("two", "money", { keywords: ["award"], noticeType: "award" });

  sqlite.prepare(`INSERT INTO digest_outbox_items
    (watch_id, subscriber_id, item_id, lens, item_kind, payload_json, source_observed_at, first_owed_at, owed_origin)
    VALUES (?, 'subscriber:funnel', ?, 'money', 'award', ?, '2026-09-01', '2026-09-01T13:00:00Z', 'test')`)
    .run("watch:one", "notice:RECOVERED-1", JSON.stringify({
      request_id: "RECOVERED-1",
      short_title: "Owed award the watermark had already swallowed",
      agency_name: "Transportation",
    }));

  const env = {
    DB: d1(sqlite),
    ALERT_STATE: kv({
      "seen:one": JSON.stringify(candidates.map((row) => row.request_id)),
      "seen:two": JSON.stringify(candidates.map((row) => row.request_id)),
    }),
    ALERTS_LIVE: "false",
    TOKEN_SECRET: "s".repeat(32),
    CONFIRM_BASE: "https://api.cityscroll.org",
  };

  const result = await withSoda(candidates, () => processAccountRollup(env, [first, second], rollupCtx()));

  assert.equal(result.selection_funnel.watermark_fresh, 0);
  assert.equal(result.selection_funnel.owed_drained, 1, "the durable owed set is the recovery ledger");
  assert.equal(result.selection_funnel.items, 1);
  assert.equal(collapseStage(result.selection_funnel), null);
  assert.match(result.preview.html, /the watermark had already swallowed/);
  sqlite.close();
});

test("the watchdog finding names the collapsing stage beside its redline codes", async () => {
  const { digestShadowFinding } = await import("../src/reliability_watchdogs.mjs");

  // The finding text is the alert's dedupe signature, so it carries names, never counts.
  assert.equal(
    digestShadowFinding({
      status: "DEGRADED",
      redline_codes: ["aggregate_count_collapse", "selection_stage_collapse"],
      reason: "Aggregate digest items collapsed against the trailing average.",
      collapse_stage: "watermark_fresh",
    }),
    "shadow receipt is DEGRADED (aggregate_count_collapse, selection_stage_collapse; "
      + "selection collapsed at watermark_fresh: Aggregate digest items collapsed against the trailing average.)",
  );

  // A degraded run with no selection collapse keeps the existing finding unchanged.
  assert.equal(
    digestShadowFinding({
      status: "DEGRADED",
      redline_codes: ["broken_digest_link"],
      reason: "The rendered digest has a missing or malformed unsubscribe/context link.",
    }),
    "shadow receipt is DEGRADED (broken_digest_link: "
      + "The rendered digest has a missing or malformed unsubscribe/context link.)",
  );
});
