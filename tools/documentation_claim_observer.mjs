/**
 * Observer for consequential documentation claims.
 *
 * The architecture reconciler compares a generated model against a human-owned
 * C4 model and deliberately strips fenced blocks before reading prose. That
 * leaves two blind spots this observer covers: a claim written inside a diagram,
 * and a claim repeated in a summary that a feature-level edit never revisited.
 *
 * Three properties keep the observer from degrading into a house-style linter.
 *
 * 1. Every blocking finding is conditional on a fact derived from a committed
 *    workflow, configuration, or handler owner. Wording alone never produces a
 *    finding: if the configuration changes so the sentence becomes true, the
 *    same sentence stops being reported.
 * 2. A claim that cannot be settled from committed files is reported as
 *    `review_needed` with the owner who can settle it, never as a pass. The
 *    observation status is `review` in that case, so a machine run cannot be
 *    mistaken for a completed semantic review.
 * 3. Nothing here reads a clock, the network, the filesystem, or a publisher.
 *    The observation is a plain value, which is what lets the frozen backtest
 *    replay an audited contradiction exactly.
 *
 * This observer does not restate the resident-read invariant and does not decide
 * whether a departure from it is acceptable. `tools/reconcile_architecture.mjs`
 * still owns prose that *grants* a request-time publisher read; this observer
 * reads prose that *denies* the recorded departures exist. The two are
 * complementary and neither weakens the other.
 */

import { createHash } from "node:crypto";

export const DOCUMENTATION_CLAIM_SCHEMA = "cityscroll.architecture.documentation_claims.v1";
export const DOCUMENTATION_CLAIM_REGISTRY_SCHEMA = "cityscroll.architecture.documentation_claim_registry.v1";

/** Closed finding vocabulary. Anything else is a registry error, not a finding. */
export const DOCUMENTATION_CLAIM_FINDINGS = Object.freeze({
  CONTRADICTED_CLAIM: "contradicted_claim",
  MISCOUNTED_CLAIM: "miscounted_claim",
  UNQUALIFIED_CLAIM: "unqualified_claim",
  MISSING_EXCEPTION_REFERENCE: "missing_exception_reference",
  REVIEW_NEEDED: "review_needed",
});

export const BLOCKING_FINDING_TYPES = Object.freeze([
  DOCUMENTATION_CLAIM_FINDINGS.CONTRADICTED_CLAIM,
  DOCUMENTATION_CLAIM_FINDINGS.MISCOUNTED_CLAIM,
  DOCUMENTATION_CLAIM_FINDINGS.UNQUALIFIED_CLAIM,
  DOCUMENTATION_CLAIM_FINDINGS.MISSING_EXCEPTION_REFERENCE,
]);

const BLOCKING = new Set(BLOCKING_FINDING_TYPES);

/** Supported claim rules. A registry entry naming anything else fails closed. */
export const CLAIM_RULES = Object.freeze(["absolute", "count", "qualified", "reference", "semantic"]);

/**
 * Supported fact predicates. Each reads one derived fact path and answers
 * whether the matched claim text is contradicted by it.
 */
export const FACT_PREDICATES = Object.freeze({
  is_true: (value) => value === true,
  is_false: (value) => value === false,
  equals: (value, expected) => Object.is(value, expected),
  not_equals: (value, expected) => !Object.is(value, expected),
  count_equals: (value, expected) => Array.isArray(value) && value.length === expected,
  count_not_equals: (value, expected) => Array.isArray(value) && value.length !== expected,
  non_empty: (value) => Array.isArray(value) && value.length > 0,
  empty: (value) => Array.isArray(value) && value.length === 0,
});

const EXCERPT_MAXIMUM = 200;
const STATEMENT_MAXIMUM = 320;
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

const NUMBER_WORDS = new Map([
  ["no", 0], ["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4],
  ["five", 5], ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10],
]);

export class DocumentationClaimError extends Error {}

function fail(message) {
  throw new DocumentationClaimError(message);
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
  }
  return value;
}

/**
 * Reading text, not markup. Emphasis, code ticks, and link syntax are style; a
 * claim written as `**two** daily cron triggers` is the same claim as `two daily
 * cron triggers`, and a guard that could be defeated by adding backticks would
 * be theatre.
 */
export function normalizeClaimText(value, max = STATEMENT_MAXIMUM) {
  return String(value ?? "")
    .replace(CONTROL, " ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isListStart(line) {
  return /^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/.test(line);
}

/**
 * Split a document into the segments a claim is judged against.
 *
 * A markdown list item is its own segment, so a qualifier added to a later
 * bullet cannot silently excuse an absolute in an earlier one. Inside a fenced
 * block every non-empty line is its own segment, because a diagram is a set of
 * independent assertions rather than one flowing paragraph, and a JSON document
 * is read line by line for the same reason.
 */
export function segmentDocument(path, text) {
  const lines = String(text ?? "").split("\n");
  const jsonLike = /\.json$/.test(String(path || ""));
  const segments = [];
  let current = null;
  let fenced = false;

  // Segments are normalized in full: truncating here would silently drop a
  // claim written at the end of a long paragraph, which is exactly the kind of
  // blind spot this observer exists to close. Only the reported statement is
  // shortened, and never the text a pattern is tested against.
  const flush = () => {
    if (!current) return;
    const normalized = normalizeClaimText(current.raw.join(" "), Number.MAX_SAFE_INTEGER);
    if (normalized) segments.push({ line: current.line, text: normalized, fenced: current.fenced });
    current = null;
  };

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (/^\s*```/.test(raw)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced || jsonLike) {
      flush();
      const normalized = normalizeClaimText(raw, Number.MAX_SAFE_INTEGER);
      if (normalized) segments.push({ line, text: normalized, fenced });
      continue;
    }
    if (!raw.trim()) {
      flush();
      continue;
    }
    if (isListStart(raw)) flush();
    if (!current) current = { line, raw: [], fenced };
    current.raw.push(raw);
  }
  flush();
  return segments;
}

/** Read one dotted fact path. A missing path is `undefined`, never invented. */
export function readFactPath(facts, path) {
  if (!path) return undefined;
  let cursor = facts;
  for (const key of String(path).split(".")) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * Evaluate one fact condition. An unknown operator or an unreadable fact path is
 * a hard error: a claim whose truth cannot be derived must not quietly pass.
 */
export function evaluateFactCondition(condition, facts) {
  if (!condition) return true;
  const predicate = FACT_PREDICATES[condition.op];
  if (!predicate) fail(`unknown fact predicate ${JSON.stringify(condition.op)}`);
  const value = readFactPath(facts, condition.fact);
  if (value === undefined) fail(`fact path ${JSON.stringify(condition.fact)} is not derivable`);
  return predicate(value, condition.value);
}

function factSnapshot(condition, facts) {
  if (!condition) return null;
  const value = readFactPath(facts, condition.fact);
  return { fact: condition.fact, value: Array.isArray(value) ? value.length : value };
}

// Global, so a summary paragraph that states the same kind of claim more than
// once is read as the several claims it is rather than only the first one.
function compiled(patterns, flags = "gi") {
  return (patterns || []).map((pattern) => new RegExp(pattern, flags));
}

/** Every (segment, match) pair a claim's patterns produce, in document order. */
function* claimMatches(segments, patterns, skip = null) {
  for (const segment of segments) {
    if (skip && skip(segment)) continue;
    for (const pattern of patterns) {
      for (const match of segment.text.matchAll(pattern)) yield { segment, match };
    }
  }
}

/**
 * Stable finding identity. The same claim, in the same document, over the same
 * matched text, is the same finding across runs. The line number is reported for
 * a reader but deliberately excluded here, so inserting an unrelated paragraph
 * above a claim does not present an old finding as a new one.
 */
export function documentationFindingId(type, claimId, document, excerpt) {
  return sha256Hex(`${type}\n${claimId}\n${document}\n${excerpt}`).slice(0, 32);
}

function finding({ type, claim, document, line, excerpt, statement, expected, observed }) {
  const excerptText = normalizeClaimText(excerpt, EXCERPT_MAXIMUM);
  return {
    schema: DOCUMENTATION_CLAIM_SCHEMA,
    finding_id: documentationFindingId(type, claim.id, document, excerptText),
    type,
    blocking: BLOCKING.has(type),
    claim_id: claim.id,
    claim_title: claim.title,
    document,
    line,
    excerpt: excerptText,
    statement: normalizeClaimText(statement, STATEMENT_MAXIMUM),
    expected: expected ?? null,
    observed: observed ?? null,
    source: { ...claim.owner },
    why: claim.why,
  };
}

function parseQuantity(token) {
  const text = String(token ?? "").trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  return NUMBER_WORDS.has(text) ? NUMBER_WORDS.get(text) : null;
}

function validateClaim(claim) {
  if (!claim || typeof claim !== "object") fail("every claim must be an object");
  if (!claim.id) fail("every claim needs an id");
  if (!CLAIM_RULES.includes(claim.rule)) fail(`claim ${claim.id} has unknown rule ${JSON.stringify(claim.rule)}`);
  if (!Array.isArray(claim.documents) || claim.documents.length === 0) {
    fail(`claim ${claim.id} must name the documents it covers`);
  }
  if (!claim.owner?.path) fail(`claim ${claim.id} must name the committed owner its truth comes from`);
  if (!claim.why) fail(`claim ${claim.id} must say why the claim would be wrong`);
  if (claim.finding_type && !BLOCKING.has(claim.finding_type)) {
    fail(`claim ${claim.id} names a finding type outside the blocking vocabulary`);
  }
  if (!Array.isArray(claim.patterns) || claim.patterns.length === 0) {
    fail(`claim ${claim.id} has no pattern, so it would check nothing`);
  }
  if (claim.rule !== "semantic" && !claim.false_when && claim.rule !== "count") {
    fail(`claim ${claim.id} must say which derived fact makes it false`);
  }
  if (claim.rule === "count" && !claim.count_fact) fail(`claim ${claim.id} must name the fact it counts`);
  if (claim.rule === "qualified" && !claim.qualifier) fail(`claim ${claim.id} must name the qualifier that makes it honest`);
  if (claim.rule === "reference" && !(claim.required_reference || []).length) {
    fail(`claim ${claim.id} must name the reference it requires`);
  }
  if (claim.rule === "semantic" && !claim.adjudicated_by) {
    fail(`claim ${claim.id} must name who adjudicates it`);
  }
}

function absoluteFindings(claim, document, segments, facts) {
  if (!evaluateFactCondition(claim.false_when, facts)) return [];
  const snapshot = factSnapshot(claim.false_when, facts);
  return [...claimMatches(segments, compiled(claim.patterns))].map(({ segment, match }) => finding({
    type: DOCUMENTATION_CLAIM_FINDINGS.CONTRADICTED_CLAIM,
    claim,
    document,
    line: segment.line,
    excerpt: match[0],
    statement: segment.text,
    expected: claim.expected ?? null,
    observed: snapshot,
  }));
}

function qualifiedFindings(claim, document, segments, facts) {
  if (!evaluateFactCondition(claim.false_when, facts)) return [];
  // The qualifier has to be readable with the absolute it excuses, so it is
  // looked for in the same statement. A disclaimer three paragraphs away does
  // not reach the reader who stops at the absolute.
  const qualifier = new RegExp(claim.qualifier, "i");
  const type = claim.finding_type || DOCUMENTATION_CLAIM_FINDINGS.UNQUALIFIED_CLAIM;
  const snapshot = factSnapshot(claim.false_when, facts);
  const skip = (segment) => qualifier.test(segment.text);
  return [...claimMatches(segments, compiled(claim.patterns), skip)].map(({ segment, match }) => finding({
    type,
    claim,
    document,
    line: segment.line,
    excerpt: match[0],
    statement: segment.text,
    expected: claim.expected ?? null,
    observed: snapshot,
  }));
}

function countFindings(claim, document, segments, facts) {
  const truth = readFactPath(facts, claim.count_fact);
  if (!Array.isArray(truth)) fail(`claim ${claim.id} needs an array at ${JSON.stringify(claim.count_fact)}`);
  const found = [];
  for (const { segment, match } of claimMatches(segments, compiled(claim.patterns))) {
    const declared = parseQuantity(match[1]);
    // A word that is not a quantity is not a claim about how many there are.
    if (declared === null || declared === truth.length) continue;
    found.push(finding({
      type: DOCUMENTATION_CLAIM_FINDINGS.MISCOUNTED_CLAIM,
      claim,
      document,
      line: segment.line,
      excerpt: match[0],
      statement: segment.text,
      expected: { fact: claim.count_fact, value: truth.length },
      observed: { declared },
    }));
  }
  return found;
}

function referenceFindings(claim, document, text, segments, facts) {
  if (!evaluateFactCondition(claim.false_when, facts)) return [];
  const references = claim.required_reference || [];
  if (references.some((reference) => text.includes(reference))) return [];
  const snapshot = factSnapshot(claim.false_when, facts);
  for (const { segment, match } of claimMatches(segments, compiled(claim.patterns))) {
    // One finding per document: the document, not the sentence, is missing the
    // pointer, and repeating it per sentence would be noise in the review.
    return [finding({
      type: DOCUMENTATION_CLAIM_FINDINGS.MISSING_EXCEPTION_REFERENCE,
      claim,
      document,
      line: segment.line,
      excerpt: match[0],
      statement: segment.text,
      expected: { required_reference: references },
      observed: snapshot,
    })];
  }
  return [];
}

function semanticFindings(claim, document, segments, facts) {
  if (!evaluateFactCondition(claim.applies_when, facts)) return [];
  const snapshot = factSnapshot(claim.applies_when, facts);
  return [...claimMatches(segments, compiled(claim.patterns))].map(({ segment, match }) => finding({
    type: DOCUMENTATION_CLAIM_FINDINGS.REVIEW_NEEDED,
    claim,
    document,
    line: segment.line,
    excerpt: match[0],
    statement: segment.text,
    expected: { adjudicated_by: claim.adjudicated_by },
    observed: snapshot,
  }));
}

function dedupe(findings) {
  const byId = new Map();
  for (const item of findings) if (!byId.has(item.finding_id)) byId.set(item.finding_id, item);
  return [...byId.values()].sort((left, right) =>
    left.type.localeCompare(right.type)
    || left.claim_id.localeCompare(right.claim_id)
    || left.document.localeCompare(right.document)
    || left.excerpt.localeCompare(right.excerpt));
}

/**
 * The fact values every registered claim reads, so a changed source fact
 * invalidates the review even when it produces no finding. Only the paths the
 * registry actually names are digested; an unrelated configuration edit does not
 * disturb this lane.
 */
export function readClaimFacts(claims, facts) {
  const read = {};
  for (const claim of claims || []) {
    for (const path of [claim.false_when?.fact, claim.applies_when?.fact, claim.count_fact]) {
      if (!path || Object.hasOwn(read, path)) continue;
      const value = readFactPath(facts, path);
      read[path] = Array.isArray(value) ? { length: value.length } : value ?? null;
    }
  }
  return sortDeep(read);
}

export function claimsDigest(claims) {
  return sha256Hex(JSON.stringify(sortDeep(claims ?? []))).slice(0, 32);
}

export function factsDigest(claims, facts) {
  return sha256Hex(JSON.stringify(readClaimFacts(claims, facts))).slice(0, 32);
}

/**
 * Observe one set of documents against one set of derived facts.
 *
 * `documents` maps a repository path to its text. `facts` is the derived-fact
 * bundle keyed by deriver. `claims` is the bounded, independently owned
 * registry; nothing is discovered by walking the repository.
 */
export function observeDocumentationClaims(observation = {}) {
  const documents = observation.documents && typeof observation.documents === "object"
    ? observation.documents
    : {};
  const facts = observation.facts && typeof observation.facts === "object" ? observation.facts : {};
  const claims = Array.isArray(observation.claims) ? observation.claims : [];
  for (const claim of claims) validateClaim(claim);

  const segmentCache = new Map();
  const segmentsFor = (path) => {
    if (!segmentCache.has(path)) segmentCache.set(path, segmentDocument(path, documents[path]));
    return segmentCache.get(path);
  };
  const textCache = new Map();
  const textFor = (path) => {
    if (!textCache.has(path)) {
      textCache.set(path, normalizeClaimText(documents[path], Number.MAX_SAFE_INTEGER));
    }
    return textCache.get(path);
  };

  const raw = [];
  const uncovered = [];
  for (const claim of claims) {
    for (const document of claim.documents) {
      if (!Object.hasOwn(documents, document)) {
        uncovered.push({ claim_id: claim.id, document });
        continue;
      }
      const segments = segmentsFor(document);
      const text = textFor(document);
      if (claim.rule === "absolute") raw.push(...absoluteFindings(claim, document, segments, facts));
      if (claim.rule === "qualified") raw.push(...qualifiedFindings(claim, document, segments, facts));
      if (claim.rule === "count") raw.push(...countFindings(claim, document, segments, facts));
      if (claim.rule === "reference") raw.push(...referenceFindings(claim, document, text, segments, facts));
      if (claim.rule === "semantic") raw.push(...semanticFindings(claim, document, segments, facts));
    }
  }

  const findings = dedupe(raw);
  const blocking = findings.filter((item) => item.blocking);
  const status = blocking.length ? "drift" : findings.length ? "review" : "healthy";
  return {
    schema: DOCUMENTATION_CLAIM_SCHEMA,
    status,
    findings,
    counts: Object.fromEntries(Object.values(DOCUMENTATION_CLAIM_FINDINGS)
      .map((type) => [type, findings.filter((item) => item.type === type).length])),
    // A claim registered against a document the caller did not supply is
    // reported rather than silently skipped: bounded coverage has to be visible.
    uncovered_documents: uncovered.sort((left, right) =>
      left.claim_id.localeCompare(right.claim_id) || left.document.localeCompare(right.document)),
    claims_digest: claimsDigest(claims),
    facts_digest: factsDigest(claims, facts),
  };
}
