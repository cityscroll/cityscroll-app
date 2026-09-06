/**
 * Public guide-review projection.
 *
 * Maps the tracked guide sources onto the observations an editorial review can
 * act on: which article depends on code that changed, which cited example no
 * longer passes, which article is overdue for a human read, which shipped
 * journey nothing documents yet, and which check could not run at all.
 *
 * Three properties hold the lane honest.
 *
 * 1. Nothing here reads a clock. `checked_at` is a required input, so the same
 *    inputs always produce the same report and a rebuild rewrites nothing.
 * 2. `last_checked` is machine evidence and `last_reviewed` is a human fact.
 *    This module reads `last_reviewed` and never proposes a value for it. A
 *    finding suggests editorial work; it never endorses, publishes, withdraws,
 *    or rewrites guide prose, and the report carries no field that could.
 * 3. Only public metadata crosses. Assignment, queue position, reviewer
 *    identity, and desk state belong to the private review owner and have no
 *    representation in this schema.
 *
 * Example pairing reuses the existing capability/demo join authority rather
 * than opening a second registry of example URLs.
 */

import { sha256Hex } from "../entity_resolution/hash.mjs";
import { PRODUCT_UPDATE_JOINS, DEMO_MANIFEST_PATH } from "./product_updates_source.mjs";

export const GUIDE_REVIEW_SCHEMA = "cityscroll.guide_review.v1";
export const GUIDE_REVIEW_ARTICLE_SCHEMA = "cityscroll.guide_review_article.v1";
export const GUIDE_REVIEW_FINDING_SCHEMA = "cityscroll.guide_review_finding.v1";
export const GUIDE_REVIEW_METHOD = "guide_review_source_v1";

/** The job identity the existing outbox conventions key deduplication on. */
export const GUIDE_REVIEW_JOB_ID = "guide-review";

export const GUIDE_ARTICLE_DIR = "site/guide/_articles";
export const CAPABILITY_REGISTRY_PATH = "capabilities/registry.mjs";
export const SOURCE_CONTRACTS_PATH = "site/data/source_contracts.json";

export const GUIDE_REVIEW_SOURCE_INPUTS = Object.freeze([
  Object.freeze({ id: "guide_articles", path: GUIDE_ARTICLE_DIR }),
  Object.freeze({ id: "demo_manifest", path: DEMO_MANIFEST_PATH }),
  Object.freeze({ id: "capability_registry", path: CAPABILITY_REGISTRY_PATH }),
  Object.freeze({ id: "source_contracts", path: SOURCE_CONTRACTS_PATH }),
]);

/** Sorted, closed vocabulary. A finding outside this set is a validation error. */
export const GUIDE_REVIEW_FINDING_KINDS = Object.freeze([
  "broken_example",
  "changed_behavior",
  "check_unavailable",
  "possible_new_journey",
  "review_due",
]);

const FINDING_KIND_SET = new Set(GUIDE_REVIEW_FINDING_KINDS);

/** How long an article may go unread before the lane raises it. */
export const DEFAULT_REVIEW_INTERVAL_DAYS = 90;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COMMIT = /^[0-9a-f]{7,40}$/i;
const RUN_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,80}$/;
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f]", "g");
const DETAIL_MAXIMUM = 240;
const PRIVATE_LEAK = /(?:\/Users\/|\/var\/folders|file:\/\/|127\.0\.0\.1|localhost|ADMIN_KEY|cityscroll-internal|desk\.cityscroll\.org|operator[_ -]?state)/i;
/** Words that would turn an observation into an editorial verdict. */
const VERDICT_COPY = /\b(?:approved|unpublish|retracted|rewritten|auto[- ]?(?:approve|merge|publish))\b/i;

export class GuideReviewError extends Error {}

function fail(message) {
  throw new GuideReviewError(message);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clean(value, max = DETAIL_MAXIMUM) {
  return String(value ?? "")
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

function validDate(value) {
  const text = clean(value, 10);
  if (!ISO_DATE.test(text)) return null;
  return Number.isFinite(Date.parse(`${text}T00:00:00Z`)) ? text : null;
}

function validCommit(value) {
  const text = clean(value, 40);
  return COMMIT.test(text) ? text : null;
}

function dayNumber(date) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
}

function daysBetween(from, to) {
  return dayNumber(to) - dayNumber(from);
}

function uniqueSorted(values) {
  return [...new Set((values || []).map((value) => clean(value, 200)).filter(Boolean))].sort();
}

/**
 * A dependency matches when the changed path is the file itself or either path
 * contains the other as a directory. An article may name a directory, and a
 * build may report a file inside one.
 */
function dependencyMatches(dependency, changedPath) {
  if (dependency === changedPath) return true;
  return changedPath.startsWith(`${dependency}/`) || dependency.startsWith(`${changedPath}/`);
}

/** Public per-article metadata. Nothing private has a key here to live under. */
export function guideReviewArticleRecord(article) {
  const id = clean(article?.id, 120);
  if (!id) fail("guide review article record needs an id");
  return deepFreeze({
    schema: GUIDE_REVIEW_ARTICLE_SCHEMA,
    id,
    type: clean(article?.type, 40) || null,
    url: clean(article?.url, 200) || null,
    title: clean(article?.title, 200) || null,
    published: validDate(article?.published),
    updated: validDate(article?.updated),
    last_reviewed: validDate(article?.last_reviewed),
    demos: uniqueSorted(article?.demos),
    historical_demos: uniqueSorted(article?.historical_demos),
    capabilities: uniqueSorted(article?.capabilities),
    source_contracts: uniqueSorted(article?.source_contracts),
    depends_on: uniqueSorted(article?.depends_on),
  });
}

/**
 * Stable finding identity. The same observation about the same article and the
 * same subject is the same finding across runs, which is what lets a repeated
 * report collapse instead of accumulating.
 */
export function guideReviewFindingId(kind, articleId, subject) {
  return sha256Hex(`${kind}\n${articleId ?? ""}\n${subject ?? ""}`).slice(0, 32);
}

/**
 * Event identity for the shared outbox. Deliberately the same derivation the
 * existing scheduled jobs use, so this lane needs no separate replay rule.
 */
export function guideReviewEventId(runKey) {
  return sha256Hex(`${GUIDE_REVIEW_JOB_ID}\n${runKey}`).slice(0, 32);
}

function finding({ kind, articleId, subject, detail, evidence = {} }) {
  if (!FINDING_KIND_SET.has(kind)) fail(`unknown guide review finding kind ${JSON.stringify(kind)}`);
  const article = articleId === null ? null : clean(articleId, 120);
  const subjectText = clean(subject, 200);
  const detailText = clean(detail, DETAIL_MAXIMUM);
  if (!detailText) fail(`finding ${kind} needs a detail line`);
  if (VERDICT_COPY.test(detailText)) fail(`finding ${kind} detail reads as an editorial verdict`);
  return {
    schema: GUIDE_REVIEW_FINDING_SCHEMA,
    finding_id: guideReviewFindingId(kind, article, subjectText),
    kind,
    article_id: article,
    subject: subjectText,
    detail: detailText,
    evidence: sorted(evidence),
  };
}

function demoIndex(manifest) {
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  return new Map(entries.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
}

function capabilityIndex(capabilities) {
  const list = Array.isArray(capabilities) ? capabilities : [];
  return new Map(list.filter((row) => row?.reference).map((row) => [row.reference, row]));
}

function contractIndex(contracts) {
  const list = Array.isArray(contracts?.contracts)
    ? contracts.contracts
    : Array.isArray(contracts) ? contracts : [];
  return new Map(list.filter((row) => row?.id).map((row) => [row.id, row]));
}

function demoResultFor(demoResults, demoId) {
  if (!demoResults || typeof demoResults !== "object") return null;
  const row = Array.isArray(demoResults)
    ? demoResults.find((entry) => entry?.id === demoId)
    : demoResults[demoId];
  if (!row) return null;
  if (typeof row === "string") return { status: clean(row, 40), detail: "" };
  return { status: clean(row.status, 40), detail: clean(row.detail, DETAIL_MAXIMUM) };
}

function articleFindings(record, context) {
  const { checkedAt, changedPaths, demos, capabilities, contracts, demoResults, intervalDays } = context;
  const found = [];

  const changed = record.depends_on.filter((dependency) =>
    changedPaths.some((path) => dependencyMatches(dependency, path)));
  if (changed.length) {
    found.push(finding({
      kind: "changed_behavior",
      articleId: record.id,
      subject: changed.join(" "),
      detail: `Code this article describes changed in the window: ${changed.join(", ")}.`,
      evidence: { changed_paths: changed, last_reviewed: record.last_reviewed },
    }));
  }

  const historical = new Set(record.historical_demos);
  for (const demoId of record.demos) {
    const entry = demos.get(demoId);
    if (!entry) {
      found.push(finding({
        kind: "check_unavailable",
        articleId: record.id,
        subject: demoId,
        detail: `Example ${demoId} is cited by this article but is not in the demo manifest, so it could not be checked.`,
        evidence: { reason: "unregistered_demo", demo_id: demoId },
      }));
      continue;
    }
    const result = demoResultFor(demoResults, demoId);
    if (!result) {
      found.push(finding({
        kind: "check_unavailable",
        articleId: record.id,
        subject: demoId,
        detail: `Example ${demoId} was not exercised in this window, so its state is unknown.`,
        evidence: { reason: "not_exercised", demo_id: demoId },
      }));
      continue;
    }
    if (result.status === "ok" || result.status === "pass") continue;
    if (result.status === "unavailable" || result.status === "skipped") {
      found.push(finding({
        kind: "check_unavailable",
        articleId: record.id,
        subject: demoId,
        detail: `Example ${demoId} could not be checked in this window${result.detail ? `: ${result.detail}` : "."}`,
        evidence: { reason: "check_unavailable", demo_id: demoId, status: result.status },
      }));
      continue;
    }
    // A demo the article already frames as historical is expected to behave
    // like its own era. It carries a note on the page and is not a breakage.
    if (historical.has(demoId)) continue;
    found.push(finding({
      kind: "broken_example",
      articleId: record.id,
      subject: demoId,
      detail: `Example ${demoId} did not behave as the article describes${result.detail ? `: ${result.detail}` : "."}`,
      evidence: { demo_id: demoId, status: result.status },
    }));
  }

  for (const reference of record.capabilities) {
    if (capabilities.has(reference)) continue;
    found.push(finding({
      kind: "check_unavailable",
      articleId: record.id,
      subject: reference,
      detail: `Capability ${reference} is cited by this article but is not in the public registry, so it could not be checked.`,
      evidence: { reason: "unregistered_capability", capability_reference: reference },
    }));
  }

  for (const contractId of record.source_contracts) {
    if (contracts.has(contractId)) continue;
    found.push(finding({
      kind: "check_unavailable",
      articleId: record.id,
      subject: contractId,
      detail: `Source ${contractId} is cited by this article but is not a published source contract, so it could not be checked.`,
      evidence: { reason: "unregistered_source_contract", source_contract_id: contractId },
    }));
  }

  if (!record.last_reviewed) {
    found.push(finding({
      kind: "review_due",
      articleId: record.id,
      subject: "never",
      detail: "This article records no review date, so no one has confirmed it against the live site.",
      evidence: { reason: "never_reviewed" },
    }));
  } else if (record.updated && dayNumber(record.updated) > dayNumber(record.last_reviewed)) {
    found.push(finding({
      kind: "review_due",
      articleId: record.id,
      subject: `updated:${record.updated}`,
      detail: `This article was updated on ${record.updated}, after its recorded review on ${record.last_reviewed}.`,
      evidence: { reason: "updated_after_review", updated: record.updated, last_reviewed: record.last_reviewed },
    }));
  } else {
    const age = daysBetween(record.last_reviewed, checkedAt);
    if (age > intervalDays) {
      found.push(finding({
        kind: "review_due",
        articleId: record.id,
        subject: `interval:${intervalDays}`,
        detail: `This article was last reviewed on ${record.last_reviewed}, ${age} days before this check.`,
        evidence: {
          reason: "interval_elapsed",
          age_days: age,
          interval_days: intervalDays,
          last_reviewed: record.last_reviewed,
        },
      }));
    }
  }

  return found;
}

/**
 * Journeys the site can already demonstrate that no article cites. The pairing
 * comes from the existing capability/demo join authority; this lane adds no
 * second list of example URLs.
 */
function journeyFindings({ records, joins, demos }) {
  const cited = new Set(records.flatMap((record) => [...record.demos, ...record.historical_demos]));
  const found = [];
  for (const join of joins) {
    const demoId = clean(join?.demo_id, 80);
    const reference = clean(join?.capability_reference, 80);
    if (!demoId || cited.has(demoId)) continue;
    if (!demos.has(demoId)) continue;
    found.push(finding({
      kind: "possible_new_journey",
      articleId: null,
      subject: demoId,
      detail: `The site demonstrates ${demoId} through ${reference}, and no guide article cites it yet.`,
      evidence: { demo_id: demoId, capability_reference: reference, join_id: clean(join?.id, 200) },
    }));
  }
  return found;
}

/** Collapse identical findings, then sort into a stable review order. */
function dedupe(findings) {
  const byId = new Map();
  for (const item of findings) {
    if (!byId.has(item.finding_id)) byId.set(item.finding_id, item);
  }
  return [...byId.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind)
    || String(left.article_id ?? "").localeCompare(String(right.article_id ?? ""))
    || left.subject.localeCompare(right.subject));
}

function reviewEvidence(report) {
  return sorted({
    schema: report.schema,
    method: report.method,
    checked_at: report.checked_at,
    observed_commit: report.observed_commit,
    review_interval_days: report.review_interval_days,
    source_inputs: report.source_inputs,
    articles: report.articles,
    findings: report.findings,
    finding_ids: report.finding_ids,
  });
}

export function hashGuideReviewEvidence(report) {
  return sha256Hex(JSON.stringify(reviewEvidence(report)));
}

export function serializeGuideReviewReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Build one review report. Every date and every identifier comes from an
 * argument; there is no ambient time and no network call in this function.
 */
export function buildGuideReviewReport({
  articles = [],
  demoManifest = null,
  capabilities = [],
  sourceContracts = null,
  changedPaths = [],
  demoResults = null,
  checkedAt = null,
  observedCommit = null,
  runKey = null,
  reviewIntervalDays = DEFAULT_REVIEW_INTERVAL_DAYS,
  joins = PRODUCT_UPDATE_JOINS,
} = {}) {
  const checked = validDate(checkedAt);
  if (!checked) fail("buildGuideReviewReport needs checkedAt as a YYYY-MM-DD date");
  const commit = validCommit(observedCommit);
  if (!commit) fail("buildGuideReviewReport needs observedCommit as a git commit id");
  const key = clean(runKey, 80);
  if (!RUN_KEY.test(key)) fail("buildGuideReviewReport needs a runKey the outbox can key on");
  if (!Number.isInteger(reviewIntervalDays) || reviewIntervalDays <= 0) {
    fail("reviewIntervalDays must be a positive whole number of days");
  }

  const records = articles.map(guideReviewArticleRecord)
    .sort((left, right) => left.id.localeCompare(right.id));
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.id)) fail(`two guide articles share the id ${JSON.stringify(record.id)}`);
    seen.add(record.id);
  }

  const context = {
    checkedAt: checked,
    changedPaths: uniqueSorted(changedPaths),
    demos: demoIndex(demoManifest),
    capabilities: capabilityIndex(capabilities),
    contracts: contractIndex(sourceContracts),
    demoResults,
    intervalDays: reviewIntervalDays,
  };

  const findings = dedupe([
    ...records.flatMap((record) => articleFindings(record, context)),
    ...journeyFindings({ records, joins: Array.isArray(joins) ? joins : [], demos: context.demos }),
  ]);

  const report = {
    schema: GUIDE_REVIEW_SCHEMA,
    method: GUIDE_REVIEW_METHOD,
    job_id: GUIDE_REVIEW_JOB_ID,
    run_key: key,
    event_id: guideReviewEventId(key),
    checked_at: checked,
    observed_commit: commit,
    review_interval_days: reviewIntervalDays,
    source_inputs: GUIDE_REVIEW_SOURCE_INPUTS.map((input) => ({ ...input })),
    articles: records.map((record) => ({ ...record })),
    findings,
    finding_ids: findings.map((item) => item.finding_id),
    counts: Object.fromEntries(GUIDE_REVIEW_FINDING_KINDS.map((kind) =>
      [kind, findings.filter((item) => item.kind === kind).length])),
  };
  report.content_hash = hashGuideReviewEvidence(report);
  return deepFreeze(report);
}

/**
 * What changed between two runs. The private owner uses this to raise only what
 * is new, which is why a repeated report produces no repeated work item.
 */
export function guideReviewDelta(previous, current) {
  const before = new Set(Array.isArray(previous?.finding_ids) ? previous.finding_ids : []);
  const after = new Map((Array.isArray(current?.findings) ? current.findings : [])
    .map((item) => [item.finding_id, item]));
  const newIds = [...after.keys()].filter((id) => !before.has(id)).sort();
  const persistingIds = [...after.keys()].filter((id) => before.has(id)).sort();
  const resolvedIds = [...before].filter((id) => !after.has(id)).sort();
  return deepFreeze({
    new_ids: newIds,
    persisting_ids: persistingIds,
    resolved_ids: resolvedIds,
    new_findings: newIds.map((id) => ({ ...after.get(id) })),
  });
}

export function guideReviewLeaks(report) {
  const errors = [];
  const text = JSON.stringify(report ?? {});
  if (PRIVATE_LEAK.test(text)) {
    errors.push("guide review report contains a private path, host, or operator state");
  }
  if (VERDICT_COPY.test(text)) {
    errors.push("guide review report reads as an editorial verdict rather than an observation");
  }
  for (const key of ["assignee", "assigned_to", "reviewer", "queue", "queue_position", "desk", "priority_rank"]) {
    if (Object.prototype.hasOwnProperty.call(report ?? {}, key)) {
      errors.push(`guide review report carries private review state in ${key}`);
    }
  }
  return errors;
}

function unexpectedKeys(value, allowed, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key}: field is not in the public allowlist`);
  }
}

export function validateGuideReviewReport(report) {
  const errors = guideReviewLeaks(report);
  unexpectedKeys(report, [
    "schema", "method", "job_id", "run_key", "event_id", "checked_at", "observed_commit",
    "review_interval_days", "source_inputs", "articles", "findings", "finding_ids",
    "counts", "content_hash",
  ], "report", errors);

  if (report?.schema !== GUIDE_REVIEW_SCHEMA) errors.push("report.schema: invalid schema");
  if (report?.method !== GUIDE_REVIEW_METHOD) errors.push("report.method: invalid method");
  if (report?.job_id !== GUIDE_REVIEW_JOB_ID) errors.push("report.job_id: invalid job identity");
  if (!RUN_KEY.test(clean(report?.run_key, 80))) errors.push("report.run_key: invalid run key");
  if (report?.event_id !== guideReviewEventId(clean(report?.run_key, 80))) {
    errors.push("report.event_id: does not match the job and run key");
  }
  if (!validDate(report?.checked_at)) errors.push("report.checked_at: invalid date");
  if (!validCommit(report?.observed_commit)) errors.push("report.observed_commit: invalid commit");
  if (!Number.isInteger(report?.review_interval_days) || report.review_interval_days <= 0) {
    errors.push("report.review_interval_days: must be a positive whole number of days");
  }

  const expected = GUIDE_REVIEW_SOURCE_INPUTS.map(({ id, path }) => `${id}:${path}`).join("|");
  const actual = (Array.isArray(report?.source_inputs) ? report.source_inputs : [])
    .map((row) => `${row?.id}:${row?.path}`).join("|");
  if (actual !== expected) errors.push("report.source_inputs: must name the four public sources");

  if (!Array.isArray(report?.articles)) {
    errors.push("report.articles must be an array");
  } else {
    for (const [index, record] of report.articles.entries()) {
      const path = `report.articles[${index}]`;
      unexpectedKeys(record, [
        "schema", "id", "type", "url", "title", "published", "updated", "last_reviewed",
        "demos", "historical_demos", "capabilities", "source_contracts", "depends_on",
      ], path, errors);
      if (record?.schema !== GUIDE_REVIEW_ARTICLE_SCHEMA) errors.push(`${path}.schema: invalid schema`);
      if (!clean(record?.id, 120)) errors.push(`${path}.id: required`);
      for (const key of ["published", "updated", "last_reviewed"]) {
        if (record?.[key] !== null && !validDate(record?.[key])) errors.push(`${path}.${key}: invalid date`);
      }
    }
  }

  if (!Array.isArray(report?.findings)) {
    errors.push("report.findings must be an array");
    return [...new Set(errors)].sort();
  }

  const ids = [];
  for (const [index, item] of report.findings.entries()) {
    const path = `report.findings[${index}]`;
    unexpectedKeys(item, ["schema", "finding_id", "kind", "article_id", "subject", "detail", "evidence"], path, errors);
    if (item?.schema !== GUIDE_REVIEW_FINDING_SCHEMA) errors.push(`${path}.schema: invalid schema`);
    if (!FINDING_KIND_SET.has(item?.kind)) errors.push(`${path}.kind: not in the finding vocabulary`);
    if (item?.finding_id !== guideReviewFindingId(item?.kind, item?.article_id, item?.subject)) {
      errors.push(`${path}.finding_id: does not match its kind, article, and subject`);
    }
    if (!clean(item?.detail, DETAIL_MAXIMUM)) errors.push(`${path}.detail: required`);
    ids.push(item?.finding_id);
  }
  if (new Set(ids).size !== ids.length) errors.push("report.findings: contains duplicate findings");
  if ((Array.isArray(report?.finding_ids) ? report.finding_ids : []).join("|") !== ids.join("|")) {
    errors.push("report.finding_ids: must mirror the findings in order");
  }

  for (const kind of GUIDE_REVIEW_FINDING_KINDS) {
    const counted = report.findings.filter((item) => item?.kind === kind).length;
    if (report?.counts?.[kind] !== counted) errors.push(`report.counts.${kind}: does not match the findings`);
  }

  if (!/^[a-f0-9]{64}$/.test(clean(report?.content_hash, 64))) {
    errors.push("report.content_hash: invalid sha256");
  } else if (hashGuideReviewEvidence(report) !== report.content_hash) {
    errors.push("report.content_hash: does not match canonical evidence");
  }

  return [...new Set(errors)].sort();
}

const KIND_HEADINGS = Object.freeze({
  broken_example: "Examples that did not behave as described",
  changed_behavior: "Articles whose code changed",
  check_unavailable: "Checks that could not run",
  possible_new_journey: "Journeys nothing documents yet",
  review_due: "Articles due for a read",
});

/**
 * One plain-text section for the existing review flow to include. It reports
 * what a machine observed and whose reading is due; it proposes no decision and
 * writes no review date.
 */
export function renderGuideReviewSection(report) {
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const articleCount = (Array.isArray(report?.articles) ? report.articles : []).length;
  const lines = [
    "## Guide review",
    "",
    `Last checked ${report?.checked_at} at ${String(report?.observed_commit ?? "").slice(0, 12)}. `
    + "A check is machine evidence; an article's review date stays a human record and nothing here changes it.",
    "",
  ];
  if (!findings.length) {
    lines.push(`No guide findings this run across ${articleCount} articles.`);
    return `${lines.join("\n")}\n`;
  }
  for (const kind of GUIDE_REVIEW_FINDING_KINDS) {
    const group = findings.filter((item) => item.kind === kind);
    if (!group.length) continue;
    lines.push(`### ${KIND_HEADINGS[kind]} (${group.length})`, "");
    for (const item of group) {
      lines.push(`- ${item.article_id ? `${item.article_id}: ` : ""}${item.detail}`);
    }
    lines.push("");
  }
  lines.push("Each line is a suggestion for an editor to look at. Nothing above has been acted on.");
  return `${lines.join("\n")}\n`;
}
