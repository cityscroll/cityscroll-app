#!/usr/bin/env node
/**
 * Build the Notice edge-response evidence read-back.
 *
 * Two things are recorded here, and they are measured differently. The
 * response-path shape is measured by running the real handler
 * (`tools/measure_notice_edge_response.mjs`). The field figures are read out of
 * the committed production read-backs rather than restated, so a refreshed
 * read-back moves this document without anyone retyping a percentile.
 *
 *   node tools/build_notice_edge_response_evidence.mjs
 *   node tools/build_notice_edge_response_evidence.mjs --check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  NOTICE_EDGE_CACHE_OUTCOMES,
  NOTICE_EDGE_DOCUMENT_CACHE_OUTCOME,
} from "../site/notice_edge_response.mjs";
import { measureNoticeEdgeTerminals } from "./measure_notice_edge_response.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LATTICE = join(ROOT, "docs/evidence/field-coverage-lattice-read-back/read-back.json");
const READINESS = join(ROOT, "docs/evidence/notice-context-readiness/read-back.json");
const ROUTES = join(ROOT, "site/_routes.json");
const OUTPUT = join(ROOT, "docs/evidence/notice-edge-response/read-back.json");

const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const round = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

/**
 * One surface's first-byte figures, with the sample that supports them.
 *
 * A percentile is reported with the retained rows behind it and, separately,
 * with the far smaller number of rows that actually sit in its tail. The sample
 * floor is a floor on the distribution, not on the tail: a window can clear the
 * floor and still rest its 95th percentile on a handful of observations.
 */
function firstByteCell(lattice, surfaceId) {
  const cell = (lattice.coverage_lattice?.phases?.cells || []).find(
    (entry) => entry.surface_id === surfaceId && entry.metric_id === "ttfb_ms",
  );
  if (!cell) return { surface_id: surfaceId, metric_id: "ttfb_ms", state: "no_data" };
  const sampled = cell.sampled_count ?? null;
  const estimated = cell.estimated_count ?? null;
  const unweighted = sampled !== null && sampled === estimated;
  return {
    surface_id: surfaceId,
    metric_id: "ttfb_ms",
    state: cell.state,
    sampled_count: sampled,
    estimated_count: estimated,
    p50_ms: round(cell.percentiles?.p50),
    p75_ms: round(cell.percentiles?.p75),
    p95_ms: round(cell.percentiles?.p95),
    p95_tail_support: {
      retained_rows_at_or_above_p95: sampled === null ? null : Math.ceil(sampled * 0.05),
      exact: unweighted,
      basis: unweighted
        ? "Every retained row carries weight 1 in this window, so the count of rows at or above"
          + " the 95th percentile follows from the retained row count."
        : "Retained rows carry different sampling weights in this window, so the count is the"
          + " unweighted approximation and the weighted tail may rest on fewer rows still.",
      note:
        "The sample floor applies to the distribution, not to the tail. A tail resting on this"
        + " few observations moves materially when any one of them moves.",
    },
  };
}

/**
 * What the retained read-back can say about who contributed one metric's
 * observations on one surface — which, for the first-byte metric, is nothing.
 *
 * Two separate limits stack. The observation contract carries a coarse device
 * class and no device, session, or reader identifier, so distinct devices are
 * never retained for any metric. And the read-back's device dimension is built
 * only for the readiness metrics, so the first-byte figures have no breakdown
 * even by class.
 */
function deviceComposition(lattice, surfaceId, metricId) {
  const cells = (lattice.coverage_lattice?.devices?.cells || [])
    .filter((entry) => entry.surface_id === surfaceId && entry.metric_id === metricId);
  const covered = cells.filter((entry) => entry.state !== "no_data");
  return {
    surface_id: surfaceId,
    metric_id: metricId,
    device_classes_with_data: covered.map((entry) => ({
      device_class: entry.device_class,
      state: entry.state,
      sampled_count: entry.sampled_count ?? null,
    })),
    device_class_breakdown_state: cells.length ? "retained" : "not_retained",
    device_class_breakdown_reason: cells.length
      ? "The read-back builds a device dimension for this metric."
      : "The read-back's device dimension is built only for the readiness metrics, so this"
        + " metric has no breakdown by device class in the retained read-back.",
    distinct_devices: null,
    distinct_devices_state: "unmeasured",
    distinct_devices_reason:
      "The observation contract carries a coarse device class and no device, session, or reader"
      + " identifier, so the number of distinct devices behind a percentile is not retained for"
      + " any metric and cannot be recovered from the retained rows.",
  };
}

export function build({ terminals }) {
  const lattice = readJson(LATTICE);
  const readiness = readJson(READINESS);
  const routes = readJson(ROUTES);

  const noticeFirstByte = firstByteCell(lattice, "notice");
  const homeFirstByte = firstByteCell(lattice, "home");
  const latticeNoticeContext = (lattice.readiness_by_surface?.notice?.cells || []).find(
    (cell) => cell.metric_id === "component_ready_ms" && cell.component_id === "notice-context",
  );

  return {
    schema: "cityscroll.notice_edge_response_evidence.v1",
    version: 1,
    claims_latency_improvement: false,
    privacy: {
      record_identifiers: false,
      reader_identifiers: false,
      new_rum_identity: false,
      response_header_vocabulary: NOTICE_EDGE_CACHE_OUTCOMES,
    },
    delivery: {
      route_included_in_edge_function: (routes.include || []).includes("/notices/*"),
      cache_api_used_by_serving_path: false,
      document_cache_outcome: NOTICE_EDGE_DOCUMENT_CACHE_OUTCOME,
      document_cache_outcome_basis: "structural",
      note:
        "The Notice route is listed in site/_routes.json, so the function runs on every request,"
        + " and the serving path never reads or writes the Cache API. The document therefore has"
        + " no edge cache entry to hit or miss, and its outcome is dynamic by construction rather"
        + " than a rate that varies between requests. The record subrequest keeps the only edge"
        + " cache on this path.",
    },
    response_path: {
      measurement_class: "structural",
      not_a_latency_claim: true,
      terminals: Object.fromEntries(Object.entries(terminals).map(([name, measured]) => [name, {
        status: measured.status,
        subrequests: measured.subrequests,
        dependent_stages: measured.dependentStages,
        widest_stage_subrequests: measured.maxConcurrentSubrequests,
        cache_control: measured.cacheControl,
        stages: measured.stages,
      }])),
    },
    unmeasured: [
      {
        component: "isolate_render_time",
        reason:
          "The edge clock advances on subrequest boundaries, so the response header's durations"
          + " measure time waiting on subrequests. Time spent rendering inside the isolate is not"
          + " separable from them and is not estimated into the total.",
      },
      {
        component: "document_edge_cache_hit_rate",
        reason:
          "There is no document-level edge cache entry on this path to hit or miss, so there is no"
          + " rate to measure. This is a property of the serving path, not a missing measurement.",
      },
      {
        component: "distinct_devices_behind_a_percentile",
        reason:
          "The observation contract retains a coarse device class and no device or session"
          + " identifier.",
      },
      {
        component: "share_of_the_readiness_tail_owned_by_the_first_byte",
        reason:
          "Percentiles of a phase and of the whole are computed over different rows and do not"
          + " compose. The retained aggregate cannot attribute a share of one tail to the other.",
      },
      {
        component: "record_cache_hit_rate",
        reason:
          "The record subrequest's cache outcome is now carried on the response, but no"
          + " production window has been read back since. The rate is pending, not zero.",
      },
      {
        component: "device_class_composition_of_the_first_byte_tail",
        reason:
          "The read-back's device dimension is built for the readiness metrics only, so the"
          + " first-byte percentiles have no breakdown even by coarse device class.",
      },
    ],
    field_first_byte: {
      source: "docs/evidence/field-coverage-lattice-read-back/read-back.json",
      window: lattice.window,
      traffic_class: lattice.traffic_class,
      sample_floor: lattice.sample_floor,
      notice: noticeFirstByte,
      home: homeFirstByte,
      percentile_composition: {
        separable: false,
        reason:
          "A percentile of one phase cannot be subtracted from a percentile of the whole: the"
          + " rows behind the first-byte 95th percentile and the rows behind the readiness 95th"
          + " percentile are not the same requests, and the retained aggregate never exposes the"
          + " rows. The share of the readiness tail attributable to the first byte is therefore"
          + " not derivable from what production retains.",
        notice_content_ready_p95_ms: round(
          (lattice.readiness_by_surface?.notice?.cells || [])
            .find((cell) => cell.metric_id === "content_ready_ms" && cell.component_id === "none")
            ?.percentiles?.p95,
        ),
      },
      notice_devices: deviceComposition(lattice, "notice", "ttfb_ms"),
      home_devices: deviceComposition(lattice, "home", "ttfb_ms"),
      notice_context_readiness_devices: deviceComposition(lattice, "notice", "component_ready_ms"),
    },
    tail_reconciliation: {
      metric_id: "component_ready_ms",
      surface_id: "notice",
      component_id: "notice-context",
      artifacts: [
        {
          path: "docs/evidence/notice-context-readiness/read-back.json",
          selection_rule: "delivery-anchored",
          selection_rule_detail:
            "The window opens at the delivery merge and closes at the latest retained"
            + " observation, so it admits only post-delivery observations.",
          sampled_count: readiness.primary?.sampled_count ?? null,
          p95_ms: readiness.primary?.p95_ms ?? null,
          carries_budget: true,
          read_by_the_gate: true,
        },
        {
          path: "docs/evidence/field-coverage-lattice-read-back/read-back.json",
          selection_rule: "fixed-rolling-window",
          selection_rule_detail:
            "The window is the fixed 7d bucket ending at query time. It strictly contains the"
            + " delivery-anchored window, so it also admits observations from before the delivery.",
          sampled_count: latticeNoticeContext?.sampled_count ?? null,
          p95_ms: round(latticeNoticeContext?.percentiles?.p95),
          carries_budget: false,
          read_by_the_gate: false,
        },
      ],
      difference_sources: [
        "window composition: the rolling window strictly contains the delivery-anchored one",
        "per-query adaptive sampling: each query retains its own weighted rows, so two queries"
        + " over overlapping windows differ even where the windows agree",
      ],
      separable: false,
      separable_reason:
        "Analytics Engine returns the aggregate, never the retained rows, so the two sources of"
        + " difference cannot be apportioned from what is retained.",
      gate:
        "site/notice_context_readiness.mjs classifies the delivery-anchored artifact against the"
        + " p75 and p95 budget; the lattice read-back carries no budget and states no SLO.",
    },
  };
}

async function main() {
  const evidence = build({ terminals: await measureNoticeEdgeTerminals() });
  const bytes = serialized(evidence);
  if (process.argv.includes("--check")) {
    if (readFileSync(OUTPUT, "utf8") !== bytes) {
      throw new Error(`stale notice edge-response evidence: ${OUTPUT}`);
    }
    process.stdout.write("checked notice edge-response evidence\n");
    return;
  }
  writeFileSync(OUTPUT, bytes);
  process.stdout.write(`wrote ${OUTPUT}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
