// 06:00 ET digest shadow run: execute the real account builders inline with delivery and
// state advancement disabled, persist rendered previews in D1, and publish structured redlines.

import { runAlerts } from "./alerts.mjs";
import { recordDigestShadowHoldState } from "./digest_shadow_hold.mjs";

export const DIGEST_SHADOW_CONTRACT = "digest-shadow.v1";
export const DIGEST_SHADOW_READY = "READY";
export const DIGEST_SHADOW_ATTENTION = "NEEDS_ATTENTION";
const HISTORY_DAYS = 30;
const TRAILING_DAYS = 7;
const COLLAPSE_RATIO = 0.25;
const EXPLOSION_RATIO = 4;
const MIN_TRAILING_AVERAGE = 4;

function dayOffset(day, delta) {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function finiteCount(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function markerCount(html) {
  return (String(html || "").match(/\bdata-digest-item=(?:"1"|'1')/g) || []).length;
}

export function extractHrefValues(html) {
  const values = [];
  const re = /\bhref\s*=\s*(["'])(.*?)\1/gi;
  let match;
  while ((match = re.exec(String(html || "")))) values.push(match[2].replaceAll("&amp;", "&"));
  return values;
}

function linkProblems(preview) {
  const hrefs = extractHrefValues(preview.html);
  const invalid = [];
  for (const href of hrefs) {
    if (!href || href === "#") {
      invalid.push(href || "(empty)");
      continue;
    }
    if (/^(mailto:|tel:)/i.test(href) || href.startsWith("/")) continue;
    try {
      const url = new URL(href);
      if (!new Set(["http:", "https:"]).has(url.protocol)) invalid.push(href);
    } catch {
      invalid.push(href);
    }
  }
  const unsubscribe = hrefs.some((href) => /\/unsubscribe\?|^mailto:alerts@/i.test(href));
  const context = finiteCount(preview.item_count) === 0 || hrefs.some((href) =>
    /^https?:\/\//i.test(href) && !/\/unsubscribe\?|\/prefs\?/i.test(href));
  return { hrefs, invalid, unsubscribe, context };
}

function currentWatchCounts(results) {
  const counts = [];
  for (const result of results || []) {
    if (!result?.preview) continue;
    if (Array.isArray(result.sections) && result.sections.length) {
      for (const section of result.sections) {
        counts.push({
          digest_id: result.previewId || result.sub || result.watch || "unknown",
          watch_id: section.previewId || section.sub || section.watch || section.queryLabel || "unknown",
          historical_id: section.sub || section.watch || section.queryLabel || "unknown",
          lens: section.lens || null,
          item_count: finiteCount(section.new) + finiteCount(section.forecasts),
        });
      }
    } else {
      counts.push({
        digest_id: result.previewId || result.sub || result.watch || "unknown",
        watch_id: result.previewId || result.sub || result.watch || "unknown",
        historical_id: result.sub || result.watch || "unknown",
        lens: result.lens || null,
        item_count: finiteCount(result.new) + finiteCount(result.forecasts),
      });
    }
  }
  return counts;
}

function historicalWatchMaximum(logs) {
  const maxima = new Map();
  for (const log of logs || []) {
    for (const entry of log?.entries || []) {
      maxima.set(entry.id, Math.max(maxima.get(entry.id) || 0, finiteCount(entry.noticeCount)));
      for (const section of entry.sections || []) {
        const id = section.sub || section.watch || section.queryLabel;
        if (id) maxima.set(id, Math.max(maxima.get(id) || 0, finiteCount(section.new) + finiteCount(section.forecasts)));
      }
    }
  }
  return maxima;
}

function redline(code, digestId, reason, evidence, watchId = null) {
  return {
    code,
    digest_id: digestId || "run",
    watch_id: watchId,
    reason,
    evidence,
  };
}

/** Pure detector + contract builder. */
export function buildDigestShadowSummary({ run, history = [], now = new Date() } = {}) {
  const ranAt = new Date(now).toISOString();
  const day = ranAt.slice(0, 10);
  const results = Array.isArray(run?.results) ? run.results : [];
  const previews = results.filter((result) => result?.preview).map((result) => ({
    digest_id: result.previewId || result.sub || result.watch || "unknown",
    recipient_redacted: result.emailRedacted || null,
    subject: result.preview.subject || "",
    html: result.preview.html || "",
    list_unsubscribe: result.preview.listUnsubscribe || null,
    item_count: finiteCount(result.new) + finiteCount(result.forecasts),
    watch_counts: Array.isArray(result.sections)
      ? result.sections.map((section) => ({
        watch_id: section.previewId || section.sub || section.watch || section.queryLabel || "unknown",
        lens: section.lens || null,
        item_count: finiteCount(section.new) + finiteCount(section.forecasts),
      }))
      : [{
        watch_id: result.previewId || result.sub || result.watch || "unknown",
        lens: result.lens || null,
        item_count: finiteCount(result.new) + finiteCount(result.forecasts),
      }],
  }));
  const totalItems = previews.reduce((sum, preview) => sum + preview.item_count, 0);
  const redlines = [];

  for (const result of results) {
    if (result?.error) {
      redlines.push(redline(
        "render_error",
        result.previewId || result.sub || result.watch,
        "The digest build path returned an error.",
        { error: String(result.error) },
      ));
    }
  }

  for (const preview of previews) {
    const rendered = markerCount(preview.html);
    if (rendered !== preview.item_count) {
      redlines.push(redline(
        "count_list_mismatch",
        preview.digest_id,
        "The declared item count does not equal the rendered item list.",
        { declared_item_count: preview.item_count, rendered_item_count: rendered },
      ));
    }
    const links = linkProblems(preview);
    if (links.invalid.length || !links.unsubscribe || !links.context) {
      redlines.push(redline(
        "broken_digest_link",
        preview.digest_id,
        "The rendered digest has a missing or malformed unsubscribe/context link.",
        {
          invalid_hrefs: links.invalid.slice(0, 10),
          unsubscribe_present: links.unsubscribe,
          context_present: links.context,
        },
      ));
    }
  }

  const watchCounts = currentWatchCounts(results);
  const historicMax = historicalWatchMaximum(history);
  for (const watch of watchCounts) {
    const previousMax = historicMax.get(watch.historical_id) || 0;
    if (watch.item_count === 0 && previousMax > 0) {
      redlines.push(redline(
        "historical_watch_zero",
        watch.digest_id,
        "A watch with prior items is receiving a zero-item digest.",
        { current_item_count: 0, trailing_max_item_count: previousMax, history_days: HISTORY_DAYS },
        watch.watch_id,
      ));
    }
  }

  const historicalTotals = history.slice(0, TRAILING_DAYS)
    .map((log) => Number(log?.totalNotices))
    .filter(Number.isFinite);
  const trailingAverage = historicalTotals.length
    ? historicalTotals.reduce((sum, count) => sum + count, 0) / historicalTotals.length
    : null;
  if (trailingAverage != null && trailingAverage >= MIN_TRAILING_AVERAGE) {
    const ratio = totalItems / trailingAverage;
    if (ratio < COLLAPSE_RATIO) {
      redlines.push(redline(
        "aggregate_count_collapse",
        "run",
        "Aggregate digest items collapsed against the trailing average.",
        { current_item_count: totalItems, trailing_average: trailingAverage, ratio, history_days: historicalTotals.length },
      ));
    } else if (ratio > EXPLOSION_RATIO) {
      redlines.push(redline(
        "aggregate_count_explosion",
        "run",
        "Aggregate digest items exploded against the trailing average.",
        { current_item_count: totalItems, trailing_average: trailingAverage, ratio, history_days: historicalTotals.length },
      ));
    }
  }

  const yesterday = history.find((log) => log?.day === dayOffset(day, -1)) || null;
  const metadata = previews.map((preview) => ({
    digest_id: preview.digest_id,
    recipient_redacted: preview.recipient_redacted,
    subject: preview.subject,
    item_count: preview.item_count,
    watch_counts: preview.watch_counts,
  }));
  const affectedDigestIds = [...new Set(redlines
    .map((item) => item.digest_id)
    .filter((id) => id && id !== "run"))];
  const status = redlines.length ? DIGEST_SHADOW_ATTENTION : DIGEST_SHADOW_READY;
  return {
    contract: DIGEST_SHADOW_CONTRACT,
    run_day: day,
    ran_at: ranAt,
    ok: redlines.length === 0,
    status,
    digest_count: previews.length,
    total_items: totalItems,
    per_watch_item_counts: watchCounts.map(({ historical_id: _historicalId, ...watch }) => watch),
    delta_vs_yesterday_send: {
      digest_count: previews.length - finiteCount(yesterday?.sentCount),
      item_count: totalItems - finiteCount(yesterday?.totalNotices),
      yesterday_present: !!yesterday,
    },
    trailing_average: trailingAverage,
    redlines,
    affected_digest_ids: affectedDigestIds,
    repair: {
      state: redlines.length ? "dispatch_required" : "none",
      affected_digest_ids: affectedDigestIds,
      rerun_method: "POST /admin/digest-shadow",
      rerun_scope: "full_build_path",
    },
    previews: metadata,
    _rendered_previews: previews,
  };
}

async function readHistory(env, day, count = HISTORY_DAYS) {
  const logs = [];
  if (!env.ALERT_STATE) return logs;
  for (let i = 1; i <= count; i++) {
    const historyDay = dayOffset(day, -i);
    try {
      const raw = await env.ALERT_STATE.get(`digest:daylog:${historyDay}`);
      if (raw) logs.push(JSON.parse(raw));
    } catch {
      // Missing history reduces detector confidence but must not abort the shadow run.
    }
  }
  return logs;
}

export async function persistDigestShadow(db, summary) {
  if (!db) throw new Error("digest shadow requires DB");
  const publicSummary = { ...summary };
  delete publicSummary._rendered_previews;
  const statements = [
    db.prepare("DELETE FROM digest_shadow_previews WHERE run_day = ?").bind(summary.run_day),
    db.prepare(`INSERT INTO digest_shadow_runs
      (run_day, ran_at, status, digest_count, total_items, summary_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_day) DO UPDATE SET
        ran_at = excluded.ran_at,
        status = excluded.status,
        digest_count = excluded.digest_count,
        total_items = excluded.total_items,
        summary_json = excluded.summary_json`)
      .bind(
        summary.run_day,
        summary.ran_at,
        summary.status,
        summary.digest_count,
        summary.total_items,
        JSON.stringify(publicSummary),
      ),
  ];
  for (const preview of summary._rendered_previews || []) {
    statements.push(db.prepare(`INSERT INTO digest_shadow_previews
      (run_day, digest_id, recipient_redacted, subject, html, item_count, watch_counts_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        summary.run_day,
        preview.digest_id,
        preview.recipient_redacted,
        preview.subject,
        preview.html,
        preview.item_count,
        JSON.stringify(preview.watch_counts),
      ));
  }
  await db.batch(statements);
}

/** Run the real digest builders with delivery, queue fan-out, and state advancement disabled. */
export async function runDigestShadow(env, { now = new Date(), runAlertsFn = runAlerts } = {}) {
  if (!env.DB) throw new Error("digest shadow requires DB");
  const at = new Date(now);
  const shadowEnv = { ...env, ALERTS_LIVE: "false", QUEUE_DIGESTS: "false" };
  const run = await runAlertsFn(shadowEnv, undefined, {
    now: at,
    live: false,
    forceInline: true,
    queueCapSemantics: env.QUEUE_DIGESTS === "true" && !!env.DIGEST_QUEUE,
    capturePreviews: true,
    advanceState: false,
    persist: false,
    simulateDryRunCounters: true,
  });
  const history = await readHistory(env, at.toISOString().slice(0, 10));
  const summary = buildDigestShadowSummary({ run, history, now: at });
  await persistDigestShadow(env.DB, summary);
  summary.hold = await recordDigestShadowHoldState(env.DB, summary, { now: at });
  await persistDigestShadow(env.DB, summary);
  const out = { ...summary };
  delete out._rendered_previews;
  return out;
}

export async function readDigestShadow(db, { day = null, digestId = null } = {}) {
  if (!db) return null;
  const runRow = day
    ? await db.prepare("SELECT summary_json FROM digest_shadow_runs WHERE run_day = ?").bind(day).first()
    : await db.prepare("SELECT summary_json FROM digest_shadow_runs ORDER BY run_day DESC LIMIT 1").first();
  if (!runRow?.summary_json) return null;
  const summary = JSON.parse(runRow.summary_json);
  if (!digestId) return { summary };
  const preview = await db.prepare(`SELECT run_day, digest_id, recipient_redacted, subject, html,
      item_count, watch_counts_json
      FROM digest_shadow_previews WHERE run_day = ? AND digest_id = ?`)
    .bind(summary.run_day, digestId).first();
  if (!preview) return { summary, preview: null };
  return {
    summary,
    preview: {
      run_day: preview.run_day,
      digest_id: preview.digest_id,
      recipient_redacted: preview.recipient_redacted,
      subject: preview.subject,
      html: preview.html,
      item_count: preview.item_count,
      watch_counts: JSON.parse(preview.watch_counts_json || "[]"),
    },
  };
}
