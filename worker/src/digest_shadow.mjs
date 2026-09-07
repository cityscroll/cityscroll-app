// 06:00 ET digest shadow run: execute the real account builders inline with delivery and
// state advancement disabled, persist rendered previews in D1, and publish structured redlines.

import { runAlerts } from "./alerts.mjs";
import { recordDigestShadowHoldState } from "./digest_shadow_hold.mjs";
import {
  ONTOLOGY_DELTA_SHADOW_CONTRACT,
  buildDefaultOntologyDeltaCandidates,
  reconcileOntologyDeltaCandidates,
} from "./lib/ontology_delta_alert.mjs";
import { describeCollapse, mergeFunnels } from "./lib/digest_funnel.mjs";
import { dayLogBuiltItemTotal } from "./lib/digest_ops.mjs";
import {
  DIGEST_SHADOW_DEGRADED_UPSTREAM,
  UPSTREAM_UNAVAILABLE,
  classifyDigestResultError,
} from "./lib/upstream_failure.mjs";

export const DIGEST_SHADOW_CONTRACT = "digest-shadow.v1";
export const DIGEST_SHADOW_READY = "READY";
export const DIGEST_SHADOW_ATTENTION = "NEEDS_ATTENTION";
// A third outcome, between the other two. The rehearsal ran and found nothing wrong with what we
// build; a source it reads did not answer. That is a real degradation and it is reported as one,
// but it is not a redline against our digest and it never holds a subscriber's mail.
export { DIGEST_SHADOW_DEGRADED_UPSTREAM };
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

function isSameDocumentFragmentHref(href) {
  if (typeof href !== "string" || !href.startsWith("#")) return false;
  const id = href.slice(1);
  return id.length > 0 && !/[\s#]/.test(id);
}

function htmlDeclaresElementId(html, id) {
  const source = String(html || "");
  return source.includes(`id="${id}"`) || source.includes(`id='${id}'`);
}

function linkProblems(preview) {
  const hrefs = extractHrefValues(preview.html);
  const invalid = [];
  for (const href of hrefs) {
    if (!href || href === "#") {
      invalid.push(href || "(empty)");
      continue;
    }
    // Rollup TOC jump links are valid in-email anchors (href="#watch-N-slug").
    // new URL("#fragment") throws, which previously false-redlined every
    // multi-watch digest and named-held those accounts at 13:00.
    if (isSameDocumentFragmentHref(href)) {
      const id = href.slice(1);
      if (!htmlDeclaresElementId(preview.html, id)) invalid.push(href);
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

// A zero-item digest has two very different causes, and only one of them is a fault.
// `matched_row_count` (the watch's own `found`: every row the query returned this run, seen or
// not) is what separates them. Rows still matching with none of them new is the quiet inbox the
// digest decision deliberately sends a heartbeat for; no rows matching at all, on a watch that
// used to match, is a recall drop worth stopping for.
function evaluationState(entity) {
  if (entity.skipped) return "skipped";
  if (entity.error) return "errored";
  const matched = Number(entity.found);
  const items = finiteCount(entity.new) + finiteCount(entity.forecasts);
  if (items === 0 && Number.isFinite(matched) && matched > 0) return "quiet";
  return "evaluated";
}

function watchCount(result, entity, { digestId, watchId }) {
  const matched = Number(entity.found);
  return {
    digest_id: digestId,
    watch_id: watchId,
    historical_id: entity.sub || entity.watch || entity.queryLabel || "unknown",
    lens: entity.lens || null,
    item_count: finiteCount(entity.new) + finiteCount(entity.forecasts),
    evaluation_state: evaluationState(entity),
    skip_reason: entity.skipped || null,
    matched_row_count: Number.isFinite(matched) ? matched : null,
    digest_action: entity.action || result.action || null,
  };
}

function currentWatchCounts(results) {
  const counts = [];
  for (const result of results || []) {
    if (!result?.preview) continue;
    const digestId = result.previewId || result.sub || result.watch || "unknown";
    if (Array.isArray(result.sections) && result.sections.length) {
      for (const section of result.sections) {
        counts.push(watchCount(result, section, {
          digestId,
          watchId: section.previewId || section.sub || section.watch || section.queryLabel || "unknown",
        }));
      }
    } else {
      counts.push(watchCount(result, result, { digestId, watchId: digestId }));
    }
  }
  return counts;
}

// The stored day log and the rehearsal must be read in the same unit, or the comparison measures
// the difference between the two records rather than a change in the corpus. A day-log entry
// records new notices and forecasts in separate fields, and its rollup sections spell the count
// `noticeCount` where a live section spells it `new`; both spellings are read here.
function historicalItemCount(entity) {
  const declared = entity?.noticeCount ?? entity?.new;
  return finiteCount(declared) + finiteCount(entity?.forecasts);
}

function historicalWatchMaximum(logs) {
  const maxima = new Map();
  const observe = (id, count, day) => {
    if (!id) return;
    const previous = maxima.get(id);
    if (previous && previous.count >= count) return;
    maxima.set(id, { count, day: day || null });
  };
  for (const log of logs || []) {
    for (const entry of log?.entries || []) {
      observe(entry.id, historicalItemCount(entry), entry.day || log.day);
      for (const section of entry.sections || []) {
        observe(
          section.id || section.sub || section.watch || section.queryLabel,
          historicalItemCount(section),
          entry.day || log.day,
        );
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

function lastGoodPreview(store, digestId) {
  if (!store || !digestId) return null;
  const row = typeof store.get === "function" ? store.get(digestId) : store[digestId];
  if (!row || !row.run_day) return null;
  return { run_day: String(row.run_day), item_count: finiteCount(row.item_count) };
}

/** Pure detector + contract builder. */
export function buildDigestShadowSummary({
  run,
  history = [],
  now = new Date(),
  ontologyDelta = null,
  // digest_id -> the most recent previously rendered preview for that id, used to say what a
  // reader is served while a source is unavailable. Read-only; nothing here is re-rendered.
  lastGoodPreviews = null,
} = {}) {
  const ranAt = new Date(now).toISOString();
  const day = ranAt.slice(0, 10);
  const results = Array.isArray(run?.results) ? run.results : [];
  const previews = results.filter((result) => result?.preview).map((result) => ({
    digest_id: result.previewId || result.sub || result.watch || "unknown",
    recipient: result.email || null,
    recipient_redacted: result.email || result.emailRedacted || null,
    subject: result.preview.subject || "",
    html: result.preview.html || "",
    list_unsubscribe: result.preview.listUnsubscribe || null,
    item_count: finiteCount(result.new) + finiteCount(result.forecasts),
    watch_counts: Array.isArray(result.sections)
      ? result.sections.map((section) => ({
        watch_id: section.previewId || section.sub || section.watch || section.queryLabel || "unknown",
        lens: section.lens || null,
        item_count: finiteCount(section.new) + finiteCount(section.forecasts),
        evaluation_state: evaluationState(section),
        skip_reason: section.skipped || null,
      }))
      : [{
        watch_id: result.previewId || result.sub || result.watch || "unknown",
        lens: result.lens || null,
        item_count: finiteCount(result.new) + finiteCount(result.forecasts),
        evaluation_state: evaluationState(result),
        skip_reason: result.skipped || null,
      }],
  }));
  const totalItems = previews.reduce((sum, preview) => sum + preview.item_count, 0);
  const redlines = [];

  const upstreamIncidents = [];
  for (const result of results) {
    if (!result?.error) continue;
    const digestId = result.previewId || result.sub || result.watch;
    const finding = classifyDigestResultError(result);
    if (finding?.class === UPSTREAM_UNAVAILABLE) {
      // Not a redline. The build path did what it was asked; the source did not answer it.
      const lastGood = lastGoodPreview(lastGoodPreviews, digestId);
      upstreamIncidents.push({
        code: "upstream_source_unavailable",
        digest_id: digestId || "run",
        watch_id: null,
        reason: "A source the digest reads did not answer within its retry budget.",
        evidence: {
          error: String(result.error),
          source: finding.source,
          http_status: finding.http_status,
          attempts: finding.attempts,
        },
        // What a reader of this digest is served while the source is away. Naming the day it was
        // rendered is the whole point: a reused digest that does not say so is a lie about vintage.
        degraded_output: lastGood
          ? { mode: "last_good_digest", served_from_run_day: lastGood.run_day, item_count: lastGood.item_count }
          : { mode: "none", reason: "no previously rendered digest is stored for this id" },
      });
      continue;
    }
    redlines.push(redline(
      "render_error",
      digestId,
      "The digest build path returned an error.",
      { error: String(result.error) },
    ));
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
    const previous = historicMax.get(watch.historical_id) || { count: 0, day: null };
    if (watch.evaluation_state === "evaluated" && watch.item_count === 0 && previous.count > 0) {
      redlines.push(redline(
        "historical_watch_zero",
        watch.digest_id,
        "A watch with prior items is receiving a zero-item digest.",
        {
          current_item_count: 0,
          // The query returned nothing at all: this is the number that makes the finding a
          // recall drop rather than a quiet day, so it travels with it.
          matched_row_count: watch.matched_row_count,
          digest_action: watch.digest_action,
          trailing_max_item_count: previous.count,
          trailing_max_day: previous.day,
          history_days: HISTORY_DAYS,
        },
        watch.watch_id,
      ));
    }
  }

  // Selection funnel: how many candidates survived each narrowing step this run.
  // A bare "0 items" cannot distinguish an empty source read from a watermark that
  // has already absorbed the whole candidate window; these counts can.
  const selectionFunnel = mergeFunnels(results.map((result) => result?.selection_funnel).filter(Boolean));
  const collapse = describeCollapse(selectionFunnel);

  // Like for like. The rehearsal totals every item it built, delivered or not, new notices and
  // forecasts together. `totalNotices` totals new notices on delivered entries only, so a day
  // with holds, caps or a rejecting provider records fewer items than it built — and comparing
  // this run against that number measures the delivery decision, not the corpus. Worse, it is
  // self-amplifying: a redline holds digests, the holds lower the average, and the lowered
  // average manufactures the next explosion. The day log's own entries are read instead, and
  // only a log with no entries to read falls back to the delivered figure.
  const historicalTotals = history.slice(0, TRAILING_DAYS)
    .map((log) => {
      const built = dayLogBuiltItemTotal(log);
      return built == null ? Number(log?.totalNotices) : built;
    })
    .filter(Number.isFinite);
  const trailingAverage = historicalTotals.length
    ? historicalTotals.reduce((sum, count) => sum + count, 0) / historicalTotals.length
    : null;
  // A source that did not answer is already reported, and is a sufficient explanation for a day
  // that built fewer items than usual. Raising a second, differently-worded finding for the same
  // outage would only put a name on it that points at us.
  const aggregateComparable = upstreamIncidents.length === 0;
  if (trailingAverage != null && trailingAverage >= MIN_TRAILING_AVERAGE && aggregateComparable) {
    const ratio = totalItems / trailingAverage;
    if (ratio < COLLAPSE_RATIO) {
      redlines.push(redline(
        "aggregate_count_collapse",
        "run",
        "Aggregate digest items collapsed against the trailing average.",
        // evaluated_count separates a corpus with nothing new for anyone from a
        // run that selected nobody at all. Both land as zero items, and only
        // one of them is a broken selection. collapse_stage goes further and
        // names the narrowing step the candidates did not survive.
        {
          current_item_count: totalItems,
          evaluated_count: results.length,
          trailing_average: trailingAverage,
          ratio,
          history_days: historicalTotals.length,
          collapse_stage: collapse?.stage || null,
        },
      ));
      // Name the narrowing step that consumed the candidates, so the receipt carries
      // its own cause instead of only the aggregate ratio. Raised alongside the
      // aggregate redline, never on an ordinarily quiet day.
      if (collapse) {
        redlines.push(redline(
          "selection_stage_collapse",
          "run",
          `Digest selection collapsed at ${collapse.stage}: ${collapse.reason}.`,
          {
            stage: collapse.stage,
            entering_count: collapse.entering_count,
            surviving_count: collapse.surviving_count,
            funnel: collapse.funnel,
          },
        ));
      }
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
    recipient: preview.recipient || preview.recipient_redacted || null,
    recipient_redacted: preview.recipient_redacted,
    subject: preview.subject,
    item_count: preview.item_count,
    watch_counts: preview.watch_counts,
  }));
  const affectedDigestIds = [...new Set(redlines
    .map((item) => item.digest_id)
    .filter((id) => id && id !== "run"))];
  const status = redlines.length
    ? DIGEST_SHADOW_ATTENTION
    : upstreamIncidents.length
      ? DIGEST_SHADOW_DEGRADED_UPSTREAM
      : DIGEST_SHADOW_READY;
  return {
    contract: DIGEST_SHADOW_CONTRACT,
    run_day: day,
    ran_at: ranAt,
    ok: redlines.length === 0,
    status,
    digest_count: previews.length,
    // Every result that rendered nothing is dropped from previews, so the run
    // count is recorded separately; without it a zero-item day cannot be told
    // apart from a run that evaluated nothing.
    evaluated_count: results.length,
    total_items: totalItems,
    per_watch_item_counts: watchCounts.map(({ historical_id: _historicalId, ...watch }) => watch),
    delta_vs_yesterday_send: {
      digest_count: previews.length - finiteCount(yesterday?.sentCount),
      item_count: totalItems - finiteCount(yesterday?.totalNotices),
      yesterday_present: !!yesterday,
    },
    trailing_average: trailingAverage,
    // The population the average was taken over, so a later reader never has to guess whether
    // this run was compared against items built or items delivered.
    trailing_average_basis: "built_digest_items",
    trailing_average_comparable: aggregateComparable,
    selection_funnel: selectionFunnel,
    collapse_stage: collapse?.stage || null,
    redlines,
    // Kept apart from redlines on purpose. These say a source was away; they never say our
    // digest is wrong, and they never name a digest into the delivery hold.
    upstream_incidents: upstreamIncidents,
    upstream_sources_unavailable: [...new Set(upstreamIncidents
      .map((incident) => incident.evidence.source)
      .filter(Boolean))].sort(),
    affected_digest_ids: affectedDigestIds,
    repair: {
      state: redlines.length ? "dispatch_required" : "none",
      affected_digest_ids: affectedDigestIds,
      rerun_method: "POST /admin/digest-shadow",
      rerun_scope: "full_build_path",
    },
    ontology_delta: ontologyDelta ? {
      contract: ontologyDelta.contract,
      observed_at: ontologyDelta.observed_at,
      candidate_count: ontologyDelta.candidate_count,
      emitted_count: ontologyDelta.emitted_count,
      events: ontologyDelta.emitted,
      receipts: ontologyDelta.receipts,
    } : {
      contract: ONTOLOGY_DELTA_SHADOW_CONTRACT,
      observed_at: ranAt,
      candidate_count: 0,
      emitted_count: 0,
      events: [],
      receipts: [],
    },
    previews: metadata,
    _rendered_previews: previews,
  };
}

/**
 * The most recent previously rendered preview for each named digest id, before `day`.
 * Only read for digests whose build could not reach a source this run: it is what an operator is
 * shown in place of a digest that could not be rebuilt, and it is always dated.
 */
export async function readLastGoodPreviews(db, digestIds, day) {
  const found = new Map();
  const ids = [...new Set((digestIds || []).filter(Boolean).map(String))];
  if (!db || !ids.length || !day) return found;
  for (const digestId of ids) {
    try {
      const row = await db.prepare(`SELECT run_day, item_count FROM digest_shadow_previews
        WHERE digest_id = ? AND run_day < ? ORDER BY run_day DESC LIMIT 1`)
        .bind(digestId, day).first();
      if (row?.run_day) found.set(digestId, { run_day: row.run_day, item_count: row.item_count });
    } catch {
      // A store that cannot answer leaves the incident saying so, which is still honest.
    }
  }
  return found;
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
export async function runDigestShadow(env, {
  now = new Date(),
  runAlertsFn = runAlerts,
  ontologyDeltaCandidates = null,
} = {}) {
  if (!env.DB) throw new Error("digest shadow requires DB");
  const at = new Date(now);
  const shadowEnv = { ...env, ALERTS_LIVE: "false", QUEUE_DIGESTS: "false" };
  const run = await runAlertsFn(shadowEnv, undefined, {
    now: at,
    live: false,
    forceInline: true,
    queueCapSemantics: env.QUEUE_DIGESTS === "true" && !!env.DIGEST_QUEUE,
    capturePreviews: true,
    previewOnly: true,
    advanceState: false,
    persist: false,
    simulateDryRunCounters: true,
  });
  const day = at.toISOString().slice(0, 10);
  const history = await readHistory(env, day);
  const candidates = ontologyDeltaCandidates == null
    ? await buildDefaultOntologyDeltaCandidates(env.DB)
    : ontologyDeltaCandidates;
  const ontologyDelta = await reconcileOntologyDeltaCandidates(env.DB, candidates, {
    observedAt: at,
  });
  const failedDigestIds = (Array.isArray(run?.results) ? run.results : [])
    .filter((result) => result?.error)
    .map((result) => result.previewId || result.sub || result.watch);
  const lastGoodPreviews = await readLastGoodPreviews(env.DB, failedDigestIds, day);
  const summary = buildDigestShadowSummary({ run, history, now: at, ontologyDelta, lastGoodPreviews });
  await persistDigestShadow(env.DB, summary);
  summary.hold = await recordDigestShadowHoldState(env.DB, summary, { now: at, receiptStore: env.ALERT_STATE });
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
  if (preview) return { summary, preview: shapePreview(preview, { runDay: summary.run_day }) };
  // Nothing was rendered for this id today. When the reason is a source that did not answer, the
  // last digest we did render is served instead of an empty response — labelled with the day it
  // was built and the outage that is standing in its place, never presented as today's.
  const incident = (summary.upstream_incidents || []).find((item) => item.digest_id === digestId);
  if (!incident) return { summary, preview: null };
  const stale = await db.prepare(`SELECT run_day, digest_id, recipient_redacted, subject, html,
      item_count, watch_counts_json
      FROM digest_shadow_previews WHERE digest_id = ? AND run_day < ? ORDER BY run_day DESC LIMIT 1`)
    .bind(digestId, summary.run_day).first();
  if (!stale) return { summary, preview: null, upstream_incident: incident };
  return {
    summary,
    upstream_incident: incident,
    preview: {
      ...shapePreview(stale, { runDay: summary.run_day }),
      source_status: "upstream_unavailable",
      served_from_run_day: stale.run_day,
      current_for_run_day: false,
    },
  };
}

function shapePreview(row, { runDay }) {
  return {
    run_day: row.run_day,
    digest_id: row.digest_id,
    recipient: row.recipient_redacted || null,
    recipient_redacted: row.recipient_redacted,
    subject: row.subject,
    html: row.html,
    item_count: row.item_count,
    watch_counts: JSON.parse(row.watch_counts_json || "[]"),
    source_status: "current",
    served_from_run_day: row.run_day,
    current_for_run_day: row.run_day === runDay,
  };
}
