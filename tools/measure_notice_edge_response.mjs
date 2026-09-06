#!/usr/bin/env node
/**
 * Measure how the Notice document response is produced at the edge.
 *
 * The Notice route is listed in `site/_routes.json`, so every request for it
 * invokes the Pages function in `site/pages_edge.mjs`. Nothing in that module
 * writes to or reads from the Cache API, so the document itself has no edge
 * cache entry the serving path can hit: it is produced per request. What the
 * response costs is therefore the shape of the subrequest graph the handler
 * walks, and that is what this tool measures.
 *
 * The graph is read by running the real handler against an instrumented
 * environment that records when each subrequest starts and settles. The
 * handler stays the single owner of what a Notice response fetches; changing
 * it changes this measurement without anyone editing the tool.
 *
 *   node tools/measure_notice_edge_response.mjs          # report every terminal
 *   node tools/measure_notice_edge_response.mjs --json   # machine-readable report
 *   node tools/measure_notice_edge_response.mjs --check  # fail when a ceiling drifts
 *
 * This is a structural measurement of the response path, in subrequests and
 * dependent stages. It is not a latency claim and reports no milliseconds from
 * production.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import edgeWorker from "../site/pages_edge.mjs";
import {
  NOTICE_EDGE_RECORD_ORIGIN,
  noticeEdgeSubrequestKind,
} from "../site/notice_edge_response.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CEILING_PATH = join(ROOT, "architecture", "notice-edge-response-budget.json");

/** Simulated settle delay for one subrequest, in milliseconds. */
const SUBREQUEST_DELAY_MS = 20;

const NOTICE_ID = "20260901001";

const RECORD_ROW = Object.freeze({
  request_id: NOTICE_ID,
  type_of_notice_description: "Public Hearings",
  section_name: "Public Hearings",
  short_title: "Public hearing on a proposed action",
  agency_name: "Example Agency",
});

const SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8">`
  + `<title>CityScroll</title><link rel="canonical" href="https://cityscroll.org/">`
  + `<meta property="og:title" content="CityScroll"><meta property="og:url" content="https://cityscroll.org/">`
  + `</head><body><button class="tabbtn active" data-tab="money">Contracts</button>`
  + `<section class="tabpane active" id="tab-money">Contracts</section>`
  + `<section class="tabpane" id="tab-notice"><div id="noticeview"></div></section></body></html>`;

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Records one subrequest's start and settle against a monotonic clock, so the
 * dependent stages of the graph can be recovered from the ordering alone.
 */
function createRecorder() {
  const origin = performance.now();
  const entries = [];
  return {
    entries,
    async run(target, produce) {
      const entry = {
        target,
        kind: noticeEdgeSubrequestKind(target),
        startedAt: performance.now() - origin,
        settledAt: null,
      };
      entries.push(entry);
      await delay(SUBREQUEST_DELAY_MS);
      entry.settledAt = performance.now() - origin;
      return produce();
    },
  };
}

/**
 * A subrequest sits one stage deeper than the deepest subrequest that had
 * already settled when it started. Subrequests issued together share a stage.
 */
export function dependentStages(entries) {
  const ordered = [...entries].sort((left, right) => left.startedAt - right.startedAt);
  const stages = new Map();
  for (const entry of ordered) {
    let deepest = 0;
    for (const earlier of ordered) {
      if (earlier === entry) continue;
      if (earlier.settledAt === null || earlier.settledAt > entry.startedAt) continue;
      deepest = Math.max(deepest, stages.get(earlier) || 0);
    }
    stages.set(entry, deepest + 1);
  }
  return ordered.map((entry) => ({ ...entry, stage: stages.get(entry) }));
}

function summarize(staged) {
  const stageCount = staged.reduce((max, entry) => Math.max(max, entry.stage), 0);
  const byStage = new Map();
  for (const entry of staged) {
    if (!byStage.has(entry.stage)) byStage.set(entry.stage, []);
    byStage.get(entry.stage).push(entry.kind);
  }
  return {
    subrequests: staged.length,
    dependentStages: stageCount,
    maxConcurrentSubrequests: Math.max(0, ...[...byStage.values()].map((kinds) => kinds.length)),
    stages: [...byStage.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([stage, kinds]) => ({ stage, subrequests: kinds.sort() })),
  };
}

/**
 * Run the real Notice handler once against an instrumented environment.
 *
 * `record` chooses the terminal: an available record, an absent one, or an
 * unavailable upstream. The document, its status, and its cache directive all
 * come from the handler itself.
 */
export async function measureNoticeEdgeResponse({ record = "available" } = {}) {
  const recorder = createRecorder();
  const env = {
    ASSETS: {
      fetch: (request) => {
        const pathname = new URL(request.url).pathname;
        return recorder.run(pathname, () => {
          if (pathname === "/") {
            return new Response(SHELL, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
          }
          return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        });
      },
    },
  };

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const href = typeof input === "string" ? input : input?.url || String(input);
    return recorder.run(href, () => {
      if (href.startsWith(NOTICE_EDGE_RECORD_ORIGIN)) {
        if (record === "unavailable") throw new Error("record endpoint unavailable");
        if (record === "absent") return new Response("{}", { status: 404 });
        return new Response(JSON.stringify({ row: RECORD_ROW, civic_time: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (record === "unavailable") throw new Error("public source unavailable");
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
  };

  let response;
  try {
    response = await edgeWorker.fetch(new Request(`https://cityscroll.org/notices/${NOTICE_ID}/`), env);
    await response.text();
  } finally {
    globalThis.fetch = previousFetch;
  }

  // The identity the response actually asked the record endpoint for, so a
  // change to the response path can be checked against the record requested
  // rather than against the document it happened to produce.
  const requested = recorder.entries.find((entry) => entry.kind === "record");
  return {
    record,
    requestedRecordId: requested ? new URL(requested.target).searchParams.get("id") : null,
    status: response.status,
    cacheControl: response.headers.get("Cache-Control"),
    serverTiming: response.headers.get("Server-Timing"),
    ...summarize(dependentStages(recorder.entries)),
  };
}

export const NOTICE_EDGE_MEASUREMENT_ID = NOTICE_ID;

export async function measureNoticeEdgeTerminals() {
  return {
    available: await measureNoticeEdgeResponse({ record: "available" }),
    absent: await measureNoticeEdgeResponse({ record: "absent" }),
    unavailable: await measureNoticeEdgeResponse({ record: "unavailable" }),
  };
}

function readCeilings() {
  return JSON.parse(readFileSync(CEILING_PATH, "utf8"));
}

function formatReport(label, measurement) {
  return `${label}: status ${measurement.status}, ${measurement.subrequests} subrequests, `
    + `${measurement.dependentStages} dependent stages, `
    + `${measurement.maxConcurrentSubrequests} at the widest stage`;
}

export async function main(argv = process.argv.slice(2)) {
  const report = await measureNoticeEdgeTerminals();
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  if (argv.includes("--check")) {
    const ceilings = readCeilings();
    const failures = [];
    for (const [terminal, ceiling] of Object.entries(ceilings.terminals)) {
      const measured = report[terminal];
      if (!measured) {
        failures.push(`no measurement for the ${terminal} terminal`);
        continue;
      }
      if (measured.status !== ceiling.status) {
        failures.push(`the ${terminal} terminal answered ${measured.status}, expected ${ceiling.status}`);
      }
      if (measured.subrequests > ceiling.maxSubrequests) {
        failures.push(`the ${terminal} terminal makes ${measured.subrequests} subrequests, ceiling is ${ceiling.maxSubrequests}`);
      }
      if (measured.dependentStages > ceiling.maxDependentStages) {
        failures.push(`the ${terminal} terminal walks ${measured.dependentStages} dependent stages, ceiling is ${ceiling.maxDependentStages}`);
      }
    }
    for (const failure of failures) process.stderr.write(`notice-edge-response: ${failure}\n`);
    if (!failures.length) {
      process.stdout.write(`notice-edge-response: ${formatReport("available", report.available)}\n`);
    }
    return failures.length ? 1 : 0;
  }
  for (const [terminal, measurement] of Object.entries(report)) {
    process.stdout.write(`${formatReport(terminal, measurement)}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
