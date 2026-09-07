/**
 * Measurement review: a deterministic projection from the tracked measurement contracts onto
 * the observations a weekly review can act on.
 *
 * The public Stats page publishes figures. Figures acquire owners badly: the code that
 * produces them is tested, the definitions beside them are prose, and the two drift apart in
 * silence. This projection is the standing check on that seam. It reads what the product
 * actually registers -- the route map, the surface vocabulary, the source registry, the
 * materialised coverage snapshot, the worked examples the page teaches -- and reports where a
 * published claim no longer matches the thing it claims about.
 *
 * The same three properties the guide review lane holds itself to hold here, for the same
 * reasons.
 *
 * 1. Nothing reads a clock. `checked_at` is a required input, so the same inputs always
 *    produce the same report and a rebuild rewrites nothing.
 * 2. A check is machine evidence, never a verdict. A finding says what was observed and what
 *    it was observed against; it never decides that a figure should be withdrawn, changed or
 *    republished, and the schema carries no field that could.
 * 3. Only public material crosses. Reader activity, receipt contents, store names, queue
 *    state and reviewer identity have no representation here and no key they could arrive
 *    under.
 *
 * A check that could not run is not a failure. An absent observation produces
 * `check_unavailable`, so a monitor that was not reachable never reads as a measurement that
 * went wrong.
 */

import { sha256Hex } from "../entity_resolution/hash.mjs";
import { resolveAnalyticsSurface } from "./analytics_surface_taxonomy.mjs";

export const MEASUREMENT_REVIEW_SCHEMA = "cityscroll.measurement_review.v1";
export const MEASUREMENT_REVIEW_FINDING_SCHEMA = "cityscroll.measurement_review_finding.v1";
export const MEASUREMENT_REVIEW_METHOD = "measurement_review_source_v1";

/** The job identity the existing outbox conventions key deduplication on. */
export const MEASUREMENT_REVIEW_JOB_ID = "measurement-review";

/** The tracked inputs this projection reads. Each already has an owner elsewhere. */
export const MEASUREMENT_REVIEW_SOURCE_INPUTS = Object.freeze([
  Object.freeze({ id: "surface_taxonomy", path: "site/analytics_surface_taxonomy.mjs" }),
  Object.freeze({ id: "route_manifest", path: "site/data/performance-classification-manifest.v1.json" }),
  Object.freeze({ id: "source_contracts", path: "site/data/source_contracts.json" }),
  Object.freeze({ id: "coverage_snapshot", path: "site/data/served_coverage_snapshot.json" }),
  Object.freeze({ id: "public_stats_document", path: "site/stats.html" }),
  Object.freeze({ id: "demo_manifest", path: "site/demo/demo-links.json" }),
]);

/** Sorted, closed vocabulary. A finding outside this set is a validation error. */
export const MEASUREMENT_REVIEW_FINDING_KINDS = Object.freeze([
  "check_unavailable",
  "example_invalid",
  "metric_reconciliation",
  "publication_missing",
  "route_taxonomy_drift",
  "source_participation",
]);

/** The five checks this lane runs, named so a review can see which one produced nothing. */
export const MEASUREMENT_REVIEW_CHECKS = Object.freeze([
  Object.freeze({
    id: "source_participation",
    question: "Does every source the published coverage counts still exist in the registry?",
  }),
  Object.freeze({
    id: "route_taxonomy_compatibility",
    question: "Does the surface vocabulary still answer for the routes the product registers?",
  }),
  Object.freeze({
    id: "metric_reconciliation",
    question: "Do the dated aggregates behind the published figures still match the receipts?",
  }),
  Object.freeze({
    id: "example_validity",
    question: "Do the worked paths the page teaches still resolve to routes that exist?",
  }),
  Object.freeze({
    id: "missing_publication",
    question: "Was the promised daily snapshot published?",
  }),
]);

const FINDING_KIND_SET = new Set(MEASUREMENT_REVIEW_FINDING_KINDS);
const DETAIL_MAXIMUM = 400;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/** Reads as a decision about the figure rather than an observation about the evidence. */
const VERDICT_COPY = /\b(should be (?:removed|withdrawn|republished)|must be (?:removed|withdrawn)|approved|rejected)\b/i;

function fail(message) {
  throw new Error(message);
}

function clean(value, max = DETAIL_MAXIMUM) {
  return String(value ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

/**
 * Stable finding identity. The same observation about the same subject is the same finding
 * across runs, which is what lets a repeated report collapse instead of accumulating.
 */
export function measurementReviewFindingId(kind, subject) {
  return sha256Hex(`${kind}\n${subject ?? ""}`).slice(0, 32);
}

/** Event identity for the shared outbox, derived exactly as the existing jobs derive theirs. */
export function measurementReviewEventId(runKey) {
  return sha256Hex(`${MEASUREMENT_REVIEW_JOB_ID}\n${runKey}`).slice(0, 32);
}

function finding({ kind, subject, detail, evidence = {} }) {
  if (!FINDING_KIND_SET.has(kind)) fail(`unknown measurement review finding kind ${JSON.stringify(kind)}`);
  const subjectText = clean(subject, 200);
  const detailText = clean(detail, DETAIL_MAXIMUM);
  if (!subjectText) fail(`finding ${kind} needs a subject`);
  if (!detailText) fail(`finding ${kind} needs a detail line`);
  if (VERDICT_COPY.test(detailText)) fail(`finding ${kind} detail reads as a verdict rather than an observation`);
  return {
    schema: MEASUREMENT_REVIEW_FINDING_SCHEMA,
    finding_id: measurementReviewFindingId(kind, subjectText),
    kind,
    subject: subjectText,
    detail: detailText,
    evidence: sorted(evidence),
  };
}

/** A same-site path with any query and fragment removed; anything else is not a route. */
export function measurementReviewRoutePath(href) {
  const text = clean(href, 600);
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith("//")) return null;
  const withoutFragment = text.split("#", 1)[0];
  const withoutQuery = withoutFragment.split("?", 1)[0];
  if (!withoutQuery) return null;
  return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

function checkSourceParticipation({ coverageSnapshot, sourceContracts }) {
  const findings = [];
  const registered = new Set(
    (Array.isArray(sourceContracts?.contracts) ? sourceContracts.contracts : [])
      .map((row) => row?.id).filter(Boolean),
  );
  if (!registered.size) {
    return [finding({
      kind: "check_unavailable",
      subject: "source participation",
      detail: "The source-contract registry supplied no contracts, so participation could not be checked.",
    })];
  }
  const domains = Array.isArray(coverageSnapshot?.domains) ? coverageSnapshot.domains : [];
  if (!domains.length) {
    return [finding({
      kind: "check_unavailable",
      subject: "source participation",
      detail: "The coverage snapshot supplied no domains, so participation could not be checked.",
    })];
  }
  for (const domain of domains) {
    for (const unit of Array.isArray(domain?.units) ? domain.units : []) {
      // A unit served by one source names it directly; a unit served by several carries the
      // list. Both spellings are the coverage snapshot's own, and both are read here.
      const cited = [
        unit?.source_id,
        ...(Array.isArray(unit?.sources) ? unit.sources : []).map((row) => row?.source_id),
      ].filter(Boolean);
      for (const sourceId of [...new Set(cited)].sort()) {
        if (registered.has(sourceId)) continue;
        findings.push(finding({
          kind: "source_participation",
          subject: `${unit.unit_id}:${sourceId}`,
          detail: `The published coverage counts records from ${sourceId}, which is not a registered source contract.`,
          evidence: { domain_id: domain.domain_id, unit_id: unit.unit_id, source_id: sourceId },
        }));
      }
      if (unit?.state === "measured" && !cited.length) {
        findings.push(finding({
          kind: "source_participation",
          subject: `${unit.unit_id}:no-source`,
          detail: `The published coverage reports ${unit.unit_id} as measured but names no source contract behind it.`,
          evidence: { domain_id: domain.domain_id, unit_id: unit.unit_id },
        }));
      }
    }
  }
  return findings;
}

function checkRouteTaxonomy({ routeSurfaces, collectorSurfaces, routeManifest, collectorDocuments }) {
  const findings = [];
  const manifestSurfaces = Array.isArray(routeManifest?.surfaces) ? routeManifest.surfaces : [];
  if (!manifestSurfaces.length || !routeSurfaces?.length) {
    return [finding({
      kind: "check_unavailable",
      subject: "route taxonomy",
      detail: "The route map or the surface vocabulary supplied no rows, so compatibility could not be checked.",
    })];
  }
  const answered = new Map(routeSurfaces.filter((row) => row.route_surface_id).map((row) => [row.route_surface_id, row]));

  for (const surface of manifestSurfaces) {
    if (answered.has(surface.surface_id)) continue;
    findings.push(finding({
      kind: "route_taxonomy_drift",
      subject: `route-map:${surface.surface_id}`,
      detail: `The route map registers ${surface.surface_id}, which the analytics surface vocabulary does not answer for.`,
      evidence: { route_surface_id: surface.surface_id, route_family: surface.route_family || null },
    }));
  }
  const manifestIds = new Set(manifestSurfaces.map((row) => row.surface_id));
  for (const row of routeSurfaces) {
    if (row.route_surface_id === null) continue;
    if (manifestIds.has(row.route_surface_id)) continue;
    findings.push(finding({
      kind: "route_taxonomy_drift",
      subject: `taxonomy:${row.surface}`,
      detail: `The surface ${row.surface} names route-map surface ${row.route_surface_id}, which the route map no longer registers.`,
      evidence: { surface: row.surface, route_surface_id: row.route_surface_id },
    }));
  }

  // A document that ships the collector must resolve to a surface the vocabulary declares as
  // one a producer may name. A document resolving to nothing would emit no event at all, which
  // is a measurement gap rather than a wrong number, and is worth raising either way.
  for (const document of Array.isArray(collectorDocuments) ? collectorDocuments : []) {
    const resolved = resolveAnalyticsSurface(document.route);
    if (resolved.surface && collectorSurfaces.includes(resolved.surface)) continue;
    findings.push(finding({
      kind: "route_taxonomy_drift",
      subject: `collector:${document.route}`,
      detail: resolved.surface
        ? `${document.route} ships the collector and resolves to ${resolved.surface}, which is not declared as a surface a producer may name.`
        : `${document.route} ships the collector but resolves to no registered surface, so it reports nothing.`,
      evidence: { route: document.route, resolved_surface: resolved.surface },
    }));
  }
  const producedSurfaces = new Set(
    (Array.isArray(collectorDocuments) ? collectorDocuments : [])
      .map((document) => resolveAnalyticsSurface(document.route).surface).filter(Boolean),
  );
  for (const surface of collectorSurfaces) {
    if (producedSurfaces.has(surface)) continue;
    findings.push(finding({
      kind: "route_taxonomy_drift",
      subject: `unproduced:${surface}`,
      detail: `${surface} is accepted as a producible surface, but no document that ships the collector resolves to it.`,
      evidence: { surface },
    }));
  }
  return findings;
}

function checkMetricReconciliation({ reconciliation }) {
  if (!reconciliation) {
    return [finding({
      kind: "check_unavailable",
      subject: "metric reconciliation",
      detail: "No reconciliation observation was supplied, so the dated aggregates were not compared against the receipts.",
    })];
  }
  const findings = [];
  for (const row of Array.isArray(reconciliation.rows) ? reconciliation.rows : []) {
    if (row?.state !== "divergent") continue;
    findings.push(finding({
      kind: "metric_reconciliation",
      subject: `divergent:${row.day}`,
      detail: `The stored aggregate for ${row.day} no longer matches a fresh read of the receipts behind it.`,
      evidence: { day: row.day, stored: row.stored || null, recomputed: row.recomputed || null },
    }));
  }
  const missing = Array.isArray(reconciliation.missing_days) ? reconciliation.missing_days : [];
  const unrecoverable = new Set(Array.isArray(reconciliation.unrecoverable_days) ? reconciliation.unrecoverable_days : []);
  for (const day of missing.filter((value) => DATE.test(value) && !unrecoverable.has(value))) {
    findings.push(finding({
      kind: "metric_reconciliation",
      subject: `gap:${day}`,
      detail: `No dated aggregate covers ${day}. It is a gap in the series, not a day with nothing in it.`,
      evidence: { day, recoverable: true },
    }));
  }
  return findings;
}

function checkExampleValidity({ workedPaths, demoManifest }) {
  const paths = Array.isArray(workedPaths) ? workedPaths : [];
  if (!paths.length) {
    return [finding({
      kind: "check_unavailable",
      subject: "worked examples",
      detail: "The public Stats document supplied no worked paths, so example validity could not be checked.",
    })];
  }
  const demoIds = new Set((Array.isArray(demoManifest?.entries) ? demoManifest.entries : [])
    .map((entry) => entry?.id).filter(Boolean));
  const findings = [];
  for (const example of paths) {
    const route = measurementReviewRoutePath(example.href);
    if (!route) {
      findings.push(finding({
        kind: "example_invalid",
        subject: `href:${clean(example.href, 120)}`,
        detail: "A worked path on the public Stats page does not name a same-site route.",
        evidence: { href: clean(example.href, 200) },
      }));
      continue;
    }
    const resolved = resolveAnalyticsSurface(route);
    if (resolved.surface) continue;
    findings.push(finding({
      kind: "example_invalid",
      subject: `route:${route}`,
      detail: `A worked path on the public Stats page points at ${route}, which the route map does not register.`,
      evidence: { route },
    }));
  }
  for (const example of paths) {
    if (!example.demo_id || demoIds.has(example.demo_id)) continue;
    findings.push(finding({
      kind: "example_invalid",
      subject: `demo:${example.demo_id}`,
      detail: `A worked path cites demo ${example.demo_id}, which is not in the demo manifest.`,
      evidence: { demo_id: example.demo_id },
    }));
  }
  return findings;
}

function checkMissingPublication({ publication }) {
  if (!publication) {
    return [finding({
      kind: "check_unavailable",
      subject: "daily publication",
      detail: "No publication observation was supplied, so whether the promised daily snapshot exists was not checked.",
    })];
  }
  if (publication.failing_stage === "observation-unavailable") {
    return [finding({
      kind: "check_unavailable",
      subject: "daily publication",
      detail: "The publication monitor could not read its observation, which is not evidence that publication failed.",
      evidence: { failing_stage: publication.failing_stage },
    })];
  }
  if (publication.ok === true) return [];
  return [finding({
    kind: "publication_missing",
    subject: `publication:${publication.failing_stage || "unknown"}`,
    detail: `The daily search-use snapshot for ${publication.promised_day || "the promised day"} is not published; the monitor reports ${publication.failing_stage || "an unnamed stage"}.`,
    evidence: {
      failing_stage: publication.failing_stage || null,
      promised_day: publication.promised_day || null,
      newest_day: publication.evidence?.newest_day || null,
    },
  })];
}

function reviewEvidence(report) {
  return {
    schema: report.schema,
    job_id: report.job_id,
    method: report.method,
    checked_at: report.checked_at,
    observed_commit: report.observed_commit,
    source_inputs: report.source_inputs,
    findings: report.findings,
    finding_ids: report.finding_ids,
    counts: report.counts,
  };
}

export function hashMeasurementReviewEvidence(report) {
  return sha256Hex(JSON.stringify(reviewEvidence(report)));
}

export function serializeMeasurementReviewReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Build one report. Every input is supplied by the caller; this function opens no file, reaches
 * no network and reads no clock.
 */
export function buildMeasurementReviewReport({
  routeSurfaces = [],
  collectorSurfaces = [],
  routeManifest = null,
  collectorDocuments = [],
  sourceContracts = null,
  coverageSnapshot = null,
  workedPaths = [],
  demoManifest = null,
  reconciliation = null,
  publication = null,
  checkedAt,
  observedCommit,
  runKey,
}) {
  if (!DATE.test(String(checkedAt || ""))) fail("checked_at must be a YYYY-MM-DD date supplied by the caller");
  const findings = [
    ...checkSourceParticipation({ coverageSnapshot, sourceContracts }),
    ...checkRouteTaxonomy({ routeSurfaces, collectorSurfaces, routeManifest, collectorDocuments }),
    ...checkMetricReconciliation({ reconciliation }),
    ...checkExampleValidity({ workedPaths, demoManifest }),
    ...checkMissingPublication({ publication }),
  ].sort((left, right) => (
    left.kind === right.kind
      ? (left.subject < right.subject ? -1 : left.subject > right.subject ? 1 : 0)
      : (left.kind < right.kind ? -1 : 1)
  ));

  const counts = Object.fromEntries(MEASUREMENT_REVIEW_FINDING_KINDS.map((kind) => [
    kind,
    findings.filter((item) => item.kind === kind).length,
  ]));

  const report = {
    schema: MEASUREMENT_REVIEW_SCHEMA,
    job_id: MEASUREMENT_REVIEW_JOB_ID,
    method: MEASUREMENT_REVIEW_METHOD,
    checked_at: clean(checkedAt, 10),
    run_key: clean(runKey || checkedAt, 40),
    observed_commit: clean(observedCommit, 40),
    checks: MEASUREMENT_REVIEW_CHECKS,
    source_inputs: MEASUREMENT_REVIEW_SOURCE_INPUTS,
    findings,
    finding_ids: findings.map((item) => item.finding_id),
    counts,
    content_hash: "",
  };
  report.content_hash = hashMeasurementReviewEvidence(report);
  return report;
}

/** What changed between two runs, so a review sees new work rather than the whole list again. */
export function measurementReviewDelta(previous, current) {
  const before = new Set(Array.isArray(previous?.finding_ids) ? previous.finding_ids : []);
  const now = new Map((Array.isArray(current?.findings) ? current.findings : []).map((item) => [item.finding_id, item]));
  return {
    new_ids: [...now.keys()].filter((id) => !before.has(id)),
    persisting_ids: [...now.keys()].filter((id) => before.has(id)),
    resolved_ids: [...before].filter((id) => !now.has(id)),
  };
}

/** The section a review flow includes. Plain text; it names no reviewer and no queue. */
export function renderMeasurementReviewSection(report) {
  const lines = [
    "## Published measurement",
    "",
    `Checked ${report.checked_at} at ${report.observed_commit || "an unrecorded commit"}.`,
    "",
  ];
  if (!report.findings.length) {
    lines.push("All five checks ran and found nothing to look at.");
    return `${lines.join("\n")}\n`;
  }
  for (const kind of MEASUREMENT_REVIEW_FINDING_KINDS) {
    const rows = report.findings.filter((item) => item.kind === kind);
    if (!rows.length) continue;
    lines.push(`### ${kind.replaceAll("_", " ")}`, "");
    for (const row of rows) lines.push(`- ${row.subject} -- ${row.detail}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/** Fields that would make this report private if they ever appeared in it. */
export function measurementReviewLeaks(report) {
  const text = JSON.stringify(report);
  const leaks = [];
  for (const pattern of [
    /assignee|reviewer|queue_position|desk_url/i,
    /ALERT_STATE|NL_METER|stats:public:|search:exec/,
    /\bBearer\b|authorization|admin_key/i,
    /visitor_id|subscriber|recipient|@[a-z0-9.-]+\.[a-z]{2,}/i,
  ]) {
    if (pattern.test(text)) leaks.push(String(pattern));
  }
  return leaks;
}

function unexpectedKeys(candidate, allowed, path, errors) {
  for (const key of Object.keys(candidate || {})) {
    if (!allowed.includes(key)) errors.push(`${path}.${key}: unexpected field`);
  }
}

/** Refuse to hand on a report that is not the shape this contract promises. */
export function validateMeasurementReviewReport(report) {
  const errors = [];
  unexpectedKeys(report, [
    "schema", "job_id", "method", "checked_at", "run_key", "observed_commit", "checks",
    "source_inputs", "findings", "finding_ids", "counts", "content_hash",
  ], "report", errors);
  if (report?.schema !== MEASUREMENT_REVIEW_SCHEMA) errors.push("report.schema: invalid");
  if (report?.job_id !== MEASUREMENT_REVIEW_JOB_ID) errors.push("report.job_id: invalid job identity");
  if (!DATE.test(String(report?.checked_at || ""))) errors.push("report.checked_at: invalid date");

  const ids = [];
  for (const [index, item] of (Array.isArray(report?.findings) ? report.findings : []).entries()) {
    const path = `report.findings[${index}]`;
    unexpectedKeys(item, ["schema", "finding_id", "kind", "subject", "detail", "evidence"], path, errors);
    if (!FINDING_KIND_SET.has(item?.kind)) errors.push(`${path}.kind: outside the closed vocabulary`);
    if (item?.finding_id !== measurementReviewFindingId(item?.kind, item?.subject)) {
      errors.push(`${path}.finding_id: does not match its kind and subject`);
    }
    ids.push(item?.finding_id);
  }
  if ((Array.isArray(report?.finding_ids) ? report.finding_ids : []).join("|") !== ids.join("|")) {
    errors.push("report.finding_ids: must mirror the findings in order");
  }
  if (!/^[a-f0-9]{64}$/.test(String(report?.content_hash || ""))) {
    errors.push("report.content_hash: invalid sha256");
  }
  for (const leak of measurementReviewLeaks(report)) errors.push(`report: private material matched ${leak}`);
  return errors;
}
