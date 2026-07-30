#!/usr/bin/env node
// Named post-flip operational checks. Each check descends from a field incident
// observed under GitHub Pages + Worker-mirror serving; the post-flip matrix must
// catch the same classes after a static-hosting cutover.
//
// Dormant until selected with live_url_smoke --set post-flip (or this module's CLI).
// Does not change production routing.

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** API Worker health body. */
export const API_HEALTH_MARKER = /crol-worker ok/;

/**
 * Catalog of named checks. `incident` is the field case each check is designed to
 * catch — keep these annotations stable so the matrix stays audit-linked.
 */
export const POST_FLIP_NAMED_CHECKS = Object.freeze([
  Object.freeze({
    id: "email-health",
    name: "EMAIL HEALTH",
    incident: Object.freeze({
      class: "silent-five-day-alert",
      field_case:
        "2026-07-30 digest silent miss: sent_today=0 with no durable last_run receipt "
        + "(observer reads at 13:06Z/13:10Z after 13:00 UTC cron; dual-write / send-path class)",
      detection_was: "manual stats read",
    }),
    description:
      "Digest send-path receipt exists and send counters show motion (not an unexplained zero).",
  }),
  Object.freeze({
    id: "stats-sanity",
    name: "STATS SANITY",
    incident: Object.freeze({
      class: "sent_today-zero-and-frozen-gauge",
      field_case:
        "2026-07-30 stats optics: sent_today stuck at 0 without last_run explanation; "
        + "usage/digest gauges that look frozen after domain or analytics continuity incidents",
      detection_was: "manual /stats and stats.html inspection",
    }),
    description:
      "Usage and digest counters are live (not frozen empty) and unexplained zeros are rejected.",
  }),
  Object.freeze({
    id: "worker-access",
    name: "WORKER ACCESS",
    incident: Object.freeze({
      class: "could-not-reach",
      field_case:
        "API/Worker unreachable from the site origin (CORS drop or dead /stats and /events) — "
        + "browser features fail while static HTML still 200s",
      detection_was: "console / feature failure with green static smoke",
    }),
    description:
      "API health, /stats JSON, and /events CORS from the public site origin all succeed.",
  }),
  Object.freeze({
    id: "human-path-journey",
    name: "HUMAN-PATH JOURNEY",
    incident: Object.freeze({
      class: "owner-manually-found-the-site-down",
      field_case:
        "2026-07-30 redirect-loop outage: deploy pipelines stayed green while a human "
        + "browse of cityscroll.org hit ERR_TOO_MANY_REDIRECTS — no scripted journey gate",
      detection_was: "manual browser visit by the site owner",
    }),
    description:
      "Headless journey: home → search rows → notice detail → deep link → subscribe surface.",
  }),
]);

export const POST_FLIP_NAMED_CHECK_IDS = Object.freeze(
  POST_FLIP_NAMED_CHECKS.map((c) => c.id),
);

/**
 * EMAIL HEALTH classifier (pure).
 * Requires digests.last_run receipt; rejects unexplained sent_today=0; requires
 * multi-day send counter motion (sent_last7d or history non-zeros).
 */
export function classifyEmailHealth(stats, { now = new Date() } = {}) {
  if (!stats || typeof stats !== "object") {
    return { ok: false, reason: "stats body missing or not an object" };
  }
  const digests = stats.digests;
  if (!digests || typeof digests !== "object") {
    return { ok: false, reason: "digests block missing on /stats" };
  }

  const lastRun = digests.last_run;
  if (lastRun == null) {
    return {
      ok: false,
      reason:
        "digests.last_run is null — silent-five-day-alert class "
        + "(no durable send-path receipt; sent_today alone cannot prove the cron ran)",
    };
  }
  if (typeof lastRun !== "object") {
    return { ok: false, reason: "digests.last_run is not an object receipt" };
  }
  // Receipt must be inspectable: ranAt/day/at + explicit skipped_reason key (null = sent).
  const when = lastRun.ranAt || lastRun.at || lastRun.day || lastRun.finished_at;
  if (!when) {
    return { ok: false, reason: "digests.last_run missing ranAt/day timestamp" };
  }
  if (!("skipped_reason" in lastRun) && !("sent" in lastRun)) {
    return {
      ok: false,
      reason: "digests.last_run missing skipped_reason and sent fields",
    };
  }

  const sentToday = Number(digests.sent_today) || 0;
  const sent7 = Number(digests.sent_last7d) || 0;
  const sentAll = Number(digests.sent_all_time) || 0;
  const historyDays = stats.history?.digests?.by_day || {};
  const historyMotion = Object.values(historyDays).some((n) => Number(n) > 0);

  if (sentToday === 0) {
    // Explained quiet day is OK only when receipt says so.
    const reason = lastRun.skipped_reason;
    const receiptSent = Number(lastRun.sent) || 0;
    if (receiptSent === 0 && (reason == null || reason === "")) {
      return {
        ok: false,
        reason:
          "sent_today=0 with last_run.skipped_reason empty — unexplained zero "
          + "(sent_today-zero class)",
      };
    }
  }

  if (sent7 === 0 && sentAll === 0 && !historyMotion) {
    return {
      ok: false,
      reason: "digest send counters show no motion in 7d, all-time, or history",
    };
  }

  // Optional freshness: if cron is long past and receipt day is stale multi-day, warn as fail.
  const receiptDay = String(lastRun.day || "").slice(0, 10);
  const today = dayStrUtc(now);
  if (receiptDay && receiptDay < prevUtcDay(today, 2)) {
    return {
      ok: false,
      reason: `digests.last_run.day ${receiptDay} is older than 2 days (stale receipt)`,
    };
  }

  return { ok: true };
}

/**
 * STATS SANITY classifier (pure).
 * Rejects frozen empty usage gauges and unexplained digest zeros.
 */
export function classifyStatsSanity(stats) {
  if (!stats || typeof stats !== "object") {
    return { ok: false, reason: "stats body missing or not an object" };
  }

  const usage = stats.usage;
  if (!usage || typeof usage !== "object") {
    return { ok: false, reason: "usage block missing on /stats (frozen-gauge class)" };
  }
  if (usage.available === false) {
    return {
      ok: false,
      reason: `usage.available=false (${usage.unavailable_reason || "no reason"})`,
    };
  }

  const pageViews7 = Number(usage.page_views?.last7d) || 0;
  const searches7 = Number(usage.searches?.last7d) || 0;
  const nl7 = Number(stats.nl_search?.calls_last7d) || 0;
  const clicks7 = Number(stats.digest_clicks?.last7d) || 0;
  const motion = pageViews7 + searches7 + nl7 + clicks7;
  if (motion === 0) {
    return {
      ok: false,
      reason:
        "usage/search/click gauges all zero over 7d — frozen-gauge class "
        + "(site looks idle or dual-write path is dead)",
    };
  }

  // sent_today-zero with no receipt is also a stats-sanity failure.
  const digests = stats.digests || {};
  if ((Number(digests.sent_today) || 0) === 0 && digests.last_run == null) {
    return {
      ok: false,
      reason: "sent_today=0 and digests.last_run null — sent_today-zero class",
    };
  }

  return { ok: true };
}

/**
 * WORKER ACCESS classifier (pure).
 * @param {{
 *   healthBody?: string,
 *   healthStatus?: number,
 *   statsStatus?: number,
 *   statsOkJson?: boolean,
 *   eventsCorsOrigin?: string|null,
 *   expectedSiteOrigin?: string,
 * }} probe
 */
export function classifyWorkerAccess(probe = {}) {
  const siteOrigin = probe.expectedSiteOrigin || "https://cityscroll.org";
  if (probe.healthStatus !== 200) {
    return {
      ok: false,
      reason: `GET /health status ${probe.healthStatus}, expected 200 (could-not-reach)`,
    };
  }
  if (!API_HEALTH_MARKER.test(String(probe.healthBody || ""))) {
    return { ok: false, reason: "GET /health body missing crol-worker ok marker" };
  }
  if (probe.statsStatus !== 200) {
    return {
      ok: false,
      reason: `GET /stats status ${probe.statsStatus}, expected 200 (could-not-reach)`,
    };
  }
  if (!probe.statsOkJson) {
    return { ok: false, reason: "GET /stats did not return parseable digests JSON" };
  }
  const acao = probe.eventsCorsOrigin;
  if (!acao) {
    return {
      ok: false,
      reason:
        "OPTIONS /events missing Access-Control-Allow-Origin for site origin "
        + `(expected ${siteOrigin})`,
    };
  }
  if (acao !== siteOrigin && acao !== "*") {
    return {
      ok: false,
      reason: `OPTIONS /events ACAO=${acao}, expected ${siteOrigin}`,
    };
  }
  return { ok: true };
}

/**
 * HUMAN-PATH JOURNEY classifier (pure) over step results.
 * @param {{ steps?: Array<{ ok: boolean, name?: string, detail?: string }> }} report
 */
export function classifyHumanPathJourney(report) {
  if (!report || !Array.isArray(report.steps) || report.steps.length === 0) {
    return { ok: false, reason: "human-path journey produced no steps" };
  }
  const failed = report.steps.filter((s) => !s.ok);
  if (failed.length) {
    const first = failed[0];
    return {
      ok: false,
      reason: `journey step failed: ${first.name || "unknown"} (${first.detail || "no detail"})`,
    };
  }
  const required = ["home", "search", "notice", "deeplink", "subscribe"];
  const names = new Set(report.steps.map((s) => String(s.name || "").toLowerCase()));
  for (const req of required) {
    if (![...names].some((n) => n.includes(req))) {
      return { ok: false, reason: `journey missing required step class: ${req}` };
    }
  }
  return { ok: true };
}

export function dayStrUtc(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function prevUtcDay(yyyyMmDd, n = 1) {
  const [y, m, day] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

async function fetchText(url, { fetchImpl = globalThis.fetch, method = "GET", headers = {} } = {}) {
  const res = await fetchImpl(url, { method, headers, redirect: "follow" });
  const body = await res.text().catch(() => "");
  return { status: res.status, body, headers: res.headers };
}

/**
 * Run the four named post-flip checks against live (or injected) endpoints.
 *
 * @param {{
 *   apiBase?: string,
 *   siteOrigin?: string,
 *   siteBase?: string,
 *   fetchImpl?: typeof fetch,
 *   now?: Date,
 *   runJourney?: boolean,
 *   journeyRunner?: () => Promise|{ steps: object[] },
 *   skip?: string[],
 * }} [opts]
 */
export async function runPostFlipNamedChecks(opts = {}) {
  const apiBase = String(opts.apiBase || "https://api.cityscroll.org").replace(/\/+$/, "");
  const siteOrigin = opts.siteOrigin || "https://cityscroll.org";
  const siteBase = opts.siteBase || `${siteOrigin}/`;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const now = opts.now || new Date();
  const skip = new Set(opts.skip || []);
  // Explicit opt-out omits the journey check (not a failure).
  if (opts.runJourney === false) skip.add("human-path-journey");
  const results = [];

  // Shared stats fetch for EMAIL HEALTH + STATS SANITY + WORKER ACCESS.
  let statsStatus = 0;
  let statsJson = null;
  let statsOkJson = false;
  let healthStatus = 0;
  let healthBody = "";
  let eventsCorsOrigin = null;

  if (!skip.has("email-health") || !skip.has("stats-sanity") || !skip.has("worker-access")) {
    try {
      const health = await fetchText(`${apiBase}/health`, { fetchImpl });
      healthStatus = health.status;
      healthBody = health.body;
    } catch (err) {
      healthStatus = 0;
      healthBody = String(err?.message || err);
    }
    try {
      const stats = await fetchText(`${apiBase}/stats`, { fetchImpl });
      statsStatus = stats.status;
      try {
        statsJson = JSON.parse(stats.body);
        statsOkJson = Boolean(statsJson?.digests);
      } catch {
        statsJson = null;
        statsOkJson = false;
      }
    } catch (err) {
      statsStatus = 0;
      statsJson = null;
      statsOkJson = false;
    }
    try {
      const cors = await fetchImpl(`${apiBase}/events`, {
        method: "OPTIONS",
        headers: {
          Origin: siteOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      eventsCorsOrigin =
        cors.headers?.get?.("access-control-allow-origin")
        || cors.headers?.get?.("Access-Control-Allow-Origin")
        || null;
    } catch {
      eventsCorsOrigin = null;
    }
  }

  const catalog = Object.fromEntries(POST_FLIP_NAMED_CHECKS.map((c) => [c.id, c]));

  function pushResult(id, classification) {
    const meta = catalog[id];
    results.push({
      id,
      name: meta.name,
      incident: meta.incident,
      ok: classification.ok,
      reason: classification.ok ? null : classification.reason,
    });
  }

  if (!skip.has("email-health")) {
    pushResult("email-health", classifyEmailHealth(statsJson, { now }));
  }
  if (!skip.has("stats-sanity")) {
    pushResult("stats-sanity", classifyStatsSanity(statsJson));
  }
  if (!skip.has("worker-access")) {
    pushResult(
      "worker-access",
      classifyWorkerAccess({
        healthStatus,
        healthBody,
        statsStatus,
        statsOkJson,
        eventsCorsOrigin,
        expectedSiteOrigin: siteOrigin,
      }),
    );
  }

  if (!skip.has("human-path-journey")) {
    let journeyReport;
    try {
      if (opts.journeyRunner) {
        journeyReport = await opts.journeyRunner();
      } else {
        journeyReport = runDefaultHumanPathJourney(siteBase);
      }
    } catch (err) {
      journeyReport = {
        steps: [{ ok: false, name: "journey-runner", detail: String(err?.message || err) }],
      };
    }
    pushResult("human-path-journey", classifyHumanPathJourney(journeyReport));
  }

  const failures = results.filter((r) => !r.ok);
  return {
    ok: failures.length === 0,
    results,
    failures: failures.map(
      (f) =>
        `POST-FLIP CHECK FAIL: ${f.name} [${f.id}] incident=${f.incident.class}\n`
        + `  reason: ${f.reason}\n`
        + `  field case: ${f.incident.field_case}`,
    ),
  };
}

/**
 * Invoke tools/human_path_journey.py (Playwright) and parse JSON report from stdout.
 */
export function runDefaultHumanPathJourney(siteBase) {
  const script = path.join(HERE, "human_path_journey.py");
  const env = { ...process.env, CROL_BASE: siteBase };
  const proc = spawnSync("python3", [script, "--json"], {
    env,
    encoding: "utf8",
    timeout: 180_000,
  });
  if (proc.error) {
    return {
      steps: [{ ok: false, name: "journey-spawn", detail: String(proc.error.message || proc.error) }],
    };
  }
  const out = String(proc.stdout || "");
  const line = out.trim().split("\n").filter(Boolean).at(-1) || "";
  try {
    return JSON.parse(line);
  } catch {
    return {
      steps: [{
        ok: false,
        name: "journey-parse",
        detail: `exit=${proc.status} stderr=${String(proc.stderr || "").slice(0, 400)} out=${line.slice(0, 200)}`,
      }],
    };
  }
}

function parseArgs(argv) {
  const opts = {
    apiBase: "https://api.cityscroll.org",
    siteOrigin: "https://cityscroll.org",
    siteBase: "https://cityscroll.org/",
    withJourney: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-base") opts.apiBase = argv[++i];
    else if (a === "--site-origin") opts.siteOrigin = argv[++i];
    else if (a === "--site-base") opts.siteBase = argv[++i];
    else if (a === "--skip-journey") opts.withJourney = false;
    else if (a === "--with-journey") opts.withJourney = true;
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(`Usage: node tools/post_flip_checks.mjs [options]

Named post-flip operational checks (EMAIL HEALTH, STATS SANITY, WORKER ACCESS,
HUMAN-PATH JOURNEY). Each is annotated with the incident class it descends from.

Options:
  --api-base URL
  --site-origin URL
  --site-base URL
  --with-journey / --skip-journey
`);
    return 0;
  }

  const result = await runPostFlipNamedChecks({
    apiBase: opts.apiBase,
    siteOrigin: opts.siteOrigin,
    siteBase: opts.siteBase,
    runJourney: opts.withJourney,
  });

  for (const r of result.results) {
    const tag = r.ok ? "OK" : "FAIL";
    console.log(`${tag} ${r.name} [${r.id}] incident=${r.incident.class}${r.reason ? ` — ${r.reason}` : ""}`);
  }
  if (!result.ok) {
    for (const line of result.failures) console.error(line);
    return 1;
  }
  console.log("post-flip named checks green");
  return 0;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
