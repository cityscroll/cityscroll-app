#!/usr/bin/env node

/**
 * Derive what this repository configures the product to collect, and what it
 * configures the product to publish, then check the owned reference document and
 * the architecture summaries against those facts.
 *
 * Every fact here is read from committed code: the browser loader source, the
 * documents that include it, and the exported constants of the analytics,
 * receipt, account-history and public-projection contracts. Nothing is read from
 * prose, and nothing is inferred about a provider account. A setting that lives
 * only in a third-party dashboard, an actual retention period at a provider, and
 * whether live collection ever succeeded are reported as not established here,
 * never as observed.
 *
 * Usage:
 *   node tools/collection_boundary_facts.mjs          # print the derived facts
 *   node tools/collection_boundary_facts.mjs --check  # also verify the documents
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ANALYTICS_RETENTION_DAYS } from "../worker/src/lib/analytics.mjs";
import { SEARCH_ACTIVITY_RETENTION_DAYS } from "../capabilities/search_activity.mjs";
import {
  SEARCH_HISTORY_MAX_ENTRIES,
  SEARCH_HISTORY_RETENTION_DAYS,
} from "../capabilities/search_history.mjs";
import { SEARCH_USAGE_WINDOW_DAYS } from "../worker/src/lib/search_usage.mjs";
import {
  PUBLIC_SEARCH_USAGE_METRICS,
  PUBLIC_SEARCH_USAGE_SCHEMA,
} from "../worker/src/lib/public_search_usage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const CLARITY_LOADER = "site/clarity.js";
export const SITE_DOCUMENT_DIR = "site";
export const SEARCH_DOCUMENT = "site/search/index.html";
export const BOUNDARY_REFERENCE = "docs/collection-and-publication-boundary.md";
export const EVENT_TAXONOMY = "docs/analytics-event-taxonomy.md";

/** Documents that must route their collection summary to the owned reference. */
export const ROUTED_SUMMARIES = ["ARCHITECTURE.md", "docs/architecture.md"];

/**
 * Absolute statements this reconciliation retired because committed code
 * contradicts them. A document that reintroduces one fails the check, so the
 * correction cannot be undone by an edit that never reads the code.
 */
export const RETIRED_CLAIMS = Object.freeze([
  { pattern: /no third-party trackers?/i, why: `${CLARITY_LOADER} is configured with a project id and is included by every top-level site document` },
  { pattern: /never reads or returns product-use telemetry/i, why: "public /stats publishes two period-bounded search counts" },
  { pattern: /no product-use telemetry is published/i, why: "public /stats publishes two period-bounded search counts" },
]);

/** Every checked document, so a retired claim cannot survive in one of them. */
export const CHECKED_DOCUMENTS = Object.freeze([...ROUTED_SUMMARIES, BOUNDARY_REFERENCE, EVENT_TAXONOMY]);

function readText(rootDir, path) {
  return readFileSync(resolve(rootDir, path), "utf8");
}

function firstCapture(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) throw new Error(`${CLARITY_LOADER} no longer declares ${label}`);
  return match[1];
}

/**
 * The browser-side third-party loader, read from its own source.
 *
 * "configured" means a project id is compiled into the file, which is the only
 * thing this repository decides. Whether the provider then accepts the tag, what
 * it retains, and how its dashboard is set are all outside the tree.
 */
export function readClarityLoader(rootDir = ROOT) {
  const text = readText(rootDir, CLARITY_LOADER);
  const projectId = firstCapture(text, /const CONFIGURED_PROJECT_ID = "([^"]*)";/, "CONFIGURED_PROJECT_ID");
  const tagOrigin = firstCapture(text, /const TAG_ORIGIN = "([^"]+)";/, "TAG_ORIGIN");
  const maskSelector = firstCapture(text, /querySelectorAll\("([^"]+)"\)/, "the masking selector");
  const maskAttribute = firstCapture(text, /setAttribute\("(data-[a-z-]+)", "true"\)/, "the masking attribute");
  const namedFieldMatch = text.match(/for \(const id of \[([^\]]+)\]\)/);
  const namedFields = namedFieldMatch
    ? namedFieldMatch[1].split(",").map((part) => part.trim().replace(/^"|"$/g, "")).filter(Boolean)
    : [];

  // Each opt-out signal is named by the property the loader actually reads.
  const skipSignals = [
    { property: "navigator.doNotTrack", present: /nav\.doNotTrack/.test(text) },
    { property: "navigator.msDoNotTrack", present: /nav\.msDoNotTrack/.test(text) },
    { property: "navigator.globalPrivacyControl", present: /nav\.globalPrivacyControl/.test(text) },
  ].filter((signal) => signal.present).map((signal) => signal.property);

  return {
    path: CLARITY_LOADER,
    configured: projectId.length > 0,
    tag_origin: tagOrigin,
    skip_signals: skipSignals,
    mask_selector: maskSelector,
    mask_attribute: maskAttribute,
    named_masked_fields: namedFields,
    // The loader appends the provider script and never inspects the response.
    load_outcome_observed: false,
  };
}

/** The top-level site documents, which are the pages a reader lands on directly. */
export function topLevelSiteDocuments(rootDir = ROOT) {
  return readdirSync(resolve(rootDir, SITE_DOCUMENT_DIR))
    .filter((name) => name.endsWith(".html"))
    .map((name) => `${SITE_DOCUMENT_DIR}/${name}`)
    .sort();
}

/** Which committed documents include the loader, read from their own markup. */
export function documentsLoadingClarity(rootDir = ROOT) {
  const candidates = [...topLevelSiteDocuments(rootDir), SEARCH_DOCUMENT];
  return candidates.filter((path) => /<script defer src="clarity\.js\?v=[^"]+"><\/script>/.test(readText(rootDir, path)));
}

export function buildCollectionBoundaryFacts(rootDir = ROOT) {
  const loader = readClarityLoader(rootDir);
  const topLevel = topLevelSiteDocuments(rootDir);
  const loading = documentsLoadingClarity(rootDir);

  return {
    third_party_loader: {
      ...loader,
      top_level_documents: topLevel,
      documents_loading: loading,
      loads_on_every_top_level_document: topLevel.every((path) => loading.includes(path)),
    },
    first_party_analytics: {
      dataset_contract: EVENT_TAXONOMY,
      retention_days: ANALYTICS_RETENTION_DAYS,
      owner: "worker/src/lib/analytics.mjs",
    },
    search_execution_receipts: {
      contract: "capabilities/search_activity.mjs",
      retention_days: SEARCH_ACTIVITY_RETENTION_DAYS,
      read_route: "/admin/search-activity",
    },
    account_search_history: {
      contract: "capabilities/search_history.mjs",
      retention_days: SEARCH_HISTORY_RETENTION_DAYS,
      max_entries: SEARCH_HISTORY_MAX_ENTRIES,
      read_route: "/search-history",
    },
    public_search_usage: {
      schema: PUBLIC_SEARCH_USAGE_SCHEMA,
      serializer: "worker/src/lib/public_search_usage.mjs",
      metric_ids: PUBLIC_SEARCH_USAGE_METRICS.map((metric) => metric.metric_id),
      period_ids: SEARCH_USAGE_WINDOW_DAYS.map((days) => `last${days}d`),
      route: "worker/src/stats.mjs",
    },
  };
}

/**
 * Facts a committed file cannot establish. Each stays an explicit boundary in
 * the owned reference: it is not evidence-free prose to be tightened later, it is
 * a statement that the evidence lives somewhere this repository cannot read.
 */
export const EVIDENCE_BOUNDARIES = Object.freeze([
  "dashboard masking mode",
  "provider-side retention",
  "live collection success",
]);

export function verifyCollectionBoundaryDocumentation(rootDir = ROOT) {
  const facts = buildCollectionBoundaryFacts(rootDir);
  const findings = [];
  const reference = readText(rootDir, BOUNDARY_REFERENCE);
  const requires = (condition, message) => { if (!condition) findings.push(message); };

  const loader = facts.third_party_loader;
  requires(loader.configured, `${CLARITY_LOADER} has no configured project id, so the reference must be rewritten before this check means anything`);
  requires(reference.includes(CLARITY_LOADER), `${BOUNDARY_REFERENCE} does not name ${CLARITY_LOADER}`);
  requires(reference.includes(loader.tag_origin), `${BOUNDARY_REFERENCE} does not name the tag origin ${loader.tag_origin}`);
  requires(reference.includes(loader.mask_attribute), `${BOUNDARY_REFERENCE} does not name the masking attribute ${loader.mask_attribute}`);
  for (const signal of loader.skip_signals) {
    requires(reference.includes(signal), `${BOUNDARY_REFERENCE} does not name the opt-out signal ${signal}`);
  }
  for (const path of loader.documents_loading) {
    requires(reference.includes(path), `${BOUNDARY_REFERENCE} does not list ${path} among the documents that include the loader`);
  }
  for (const path of facts.third_party_loader.top_level_documents) {
    requires(loader.documents_loading.includes(path), `${path} does not include the loader, so the reference's "every top-level document" statement is no longer true`);
  }
  for (const boundary of EVIDENCE_BOUNDARIES) {
    requires(reference.includes(boundary), `${BOUNDARY_REFERENCE} does not record the evidence boundary for ${boundary}`);
  }

  for (const [family, retention] of [
    ["first-party aggregate analytics", facts.first_party_analytics.retention_days],
    ["search-execution receipts", facts.search_execution_receipts.retention_days],
    ["account search history", facts.account_search_history.retention_days],
  ]) {
    requires(reference.includes(`${retention} days`), `${BOUNDARY_REFERENCE} does not state the ${retention}-day retention configured for ${family}`);
  }

  const published = facts.public_search_usage;
  requires(reference.includes(published.schema), `${BOUNDARY_REFERENCE} does not name the published schema ${published.schema}`);
  for (const metricId of published.metric_ids) {
    requires(reference.includes(metricId), `${BOUNDARY_REFERENCE} does not name the published metric ${metricId}`);
  }
  for (const periodId of published.period_ids) {
    requires(reference.includes(periodId), `${BOUNDARY_REFERENCE} does not name the published period ${periodId}`);
  }
  requires(published.metric_ids.length === 2, `worker/src/lib/public_search_usage.mjs publishes ${published.metric_ids.length} metrics; the reference describes exactly two`);

  // A summary may link the reference by repository path or, from inside `docs/`,
  // by the relative name; both resolve to the same file, so the basename is the
  // link this check requires.
  const referenceLink = BOUNDARY_REFERENCE.split("/").pop();
  for (const path of ROUTED_SUMMARIES) {
    if (!readText(rootDir, path).includes(referenceLink)) {
      findings.push(`${path} does not route its collection and publication summary to ${BOUNDARY_REFERENCE}`);
    }
  }

  for (const path of CHECKED_DOCUMENTS) {
    const text = readText(rootDir, path);
    for (const claim of RETIRED_CLAIMS) {
      if (claim.pattern.test(text)) {
        findings.push(`${path} reasserts a retired claim (${claim.pattern.source}): ${claim.why}`);
      }
    }
  }

  return {
    schema: "cityscroll.collection-boundary-reconciliation.v1",
    status: findings.length ? "FAIL" : "PASS",
    findings,
    facts,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const check = process.argv.includes("--check");
  const report = check
    ? verifyCollectionBoundaryDocumentation()
    : { schema: "cityscroll.collection-boundary-facts.v1", facts: buildCollectionBoundaryFacts() };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (check && report.status !== "PASS") process.exitCode = 1;
}
