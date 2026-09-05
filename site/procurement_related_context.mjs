/**
 * Related procurement context beneath the pursuit snapshot
 * (procurement-pursuit-decision, Card 4).
 *
 * A vendor sizing up a solicitation needs to know what the agency has bought
 * before and whether the amount is unusual -- with an unmistakable line
 * between records tied to this exact procurement and records that merely
 * resemble it. This module is a pure view-model composition layer: it never
 * fetches a source, infers absence, or invents a cross-object lookup of its
 * own. A caller supplies a `subject` (the current procurement's identity,
 * agency, title, amount) plus already-resolved `candidates` (other history
 * records already surfaced elsewhere) and a `populationAmounts` cohort for
 * the amount benchmark; this module only classifies and renders.
 *
 * Reused, not reinvented:
 *   - pinBase() / usablePin() (../worker/src/lib/lineage.mjs) is the same
 *     PIN-renewal-suffix convention already treated elsewhere in this
 *     codebase as an explicit predecessor link -- a declared City Record PIN
 *     numbering convention, never a text-similarity inference.
 *   - AWARD_RANK_SMALL_N_POLICY (./comparative_award_rank.mjs) is imported
 *     verbatim as the amount-benchmark small-population policy: a cohort
 *     below its rank floor is omitted entirely, a cohort below its
 *     percentile floor exposes a rank with the percentile withheld, and a
 *     larger cohort exposes both. This module never redefines those
 *     thresholds.
 *
 * Negative rule (card ppd-04): a record enters the exact chain only on exact
 * identity evidence -- a shared publisher identifier or an explicit
 * predecessor link -- never on textual similarity, however strong. No
 * generated copy calls a related (resemblance-only) vendor an incumbent.
 */

import { AWARD_RANK_SMALL_N_POLICY } from "./comparative_award_rank.mjs";
import { pinBase, usablePin } from "../worker/src/lib/lineage.mjs";

export const PROCUREMENT_RELATED_CONTEXT_SCHEMA = "cityscroll.procurement_related_context.v1";

/** The two structurally and semantically distinct groups this module ever emits. */
export const RELATED_CONTEXT_GROUP = Object.freeze({
  EXACT: "exact",
  RELATED: "related",
});

/**
 * The existing amount-benchmark small-population policy, reused unchanged.
 * large cohort (>= minimum_percentile_count): percentile shown.
 * medium cohort (>= minimum_rank_count, < minimum_percentile_count): rank
 * shown, percentile withheld.
 * small cohort (< minimum_rank_count): omitted entirely.
 */
export const RELATED_CONTEXT_AMOUNT_BENCHMARK_POLICY = AWARD_RANK_SMALL_N_POLICY;

const RESEMBLANCE_STOPWORDS = new Set(
  "the a an of for and to in on with by at services service contract contracts renewal option year years extension citywide fiscal"
    .split(" "),
);
// Matches the codebase's existing near-match floor (site/app/money-history.mjs
// NEAR_MATCH_MIN_SCORE) -- "at least a third of this notice's significant
// title words recur" is real overlap, not one coincidental shared word.
const RESEMBLANCE_MIN_SCORE = 0.34;

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function normalizedKey(value) {
  const result = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return result || null;
}

function titleWords(title) {
  const seen = new Set();
  String(title || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).forEach((word) => {
    if (word.length > 2 && !RESEMBLANCE_STOPWORDS.has(word)) seen.add(word);
  });
  return [...seen];
}

function titleOverlapScore(a, b) {
  const wordsA = titleWords(a);
  const wordsB = titleWords(b);
  if (!wordsA.length || !wordsB.length) return 0;
  const overlap = wordsA.filter((word) => wordsB.includes(word));
  return overlap.length / wordsA.length;
}

/**
 * Exact-identity evidence only (G1/A2): a shared publisher identifier
 * (contract id, EPIN/PIN) or an explicit predecessor link -- either a
 * caller-declared predecessor field, or the renewal-suffix PIN convention
 * (pinBase()/usablePin()) City Record PINs themselves declare. Returns the
 * matched basis string, or null when no exact evidence exists. Never
 * consults title text.
 */
export function exactIdentityBasis(subject = {}, candidate = {}) {
  const s = subject || {};
  const c = candidate || {};

  const contractId = normalizedKey(s.contract_id);
  if (contractId && contractId === normalizedKey(c.contract_id)) return "exact_contract_id";

  const epin = normalizedKey(s.epin || s.pin);
  if (epin && epin === normalizedKey(c.epin || c.pin)) return "exact_epin";

  if (s.predecessor_pin && normalizedKey(s.predecessor_pin) === normalizedKey(c.pin || c.epin)) {
    return "exact_predecessor_link";
  }
  if (c.predecessor_pin && normalizedKey(c.predecessor_pin) === normalizedKey(s.pin || s.epin)) {
    return "exact_predecessor_link";
  }

  const subjectPin = text(s.pin || s.epin);
  const candidatePin = text(c.pin || c.epin);
  if (subjectPin && candidatePin && subjectPin !== candidatePin
    && usablePin(subjectPin) && usablePin(candidatePin)) {
    const subjectBase = pinBase(subjectPin);
    const candidateBase = pinBase(candidatePin);
    if (subjectBase && candidateBase && subjectBase === candidateBase) return "exact_predecessor_link";
    if (subjectBase && !candidateBase && subjectBase === candidatePin) return "exact_predecessor_link";
    if (candidateBase && !subjectBase && candidateBase === subjectPin) return "exact_predecessor_link";
  }

  return null;
}

/**
 * Resemblance-only evidence: same agency plus meaningful title-word overlap.
 * Never sufficient to enter the exact chain, however high the score, and
 * never rendered as incumbency (G2/A3).
 */
export function resemblanceBasis(subject = {}, candidate = {}) {
  const s = subject || {};
  const c = candidate || {};
  const subjectAgency = text(s.agency_name);
  const candidateAgency = text(c.agency_name);
  if (!subjectAgency || !candidateAgency) return null;
  if (subjectAgency.toLowerCase() !== candidateAgency.toLowerCase()) return null;
  const score = titleOverlapScore(s.short_title || s.title, c.short_title || c.title);
  return score >= RESEMBLANCE_MIN_SCORE ? { basis: "title_overlap", score } : null;
}

/**
 * Classify one candidate against the subject procurement. Exact identity is
 * checked first and always wins when present -- a candidate is never
 * demoted to "related" merely because it also happens to resemble the
 * title. Returns { group: "exact" | "related" | null, basis }.
 */
export function classifyHistoryCandidate(subject, candidate) {
  const exact = exactIdentityBasis(subject, candidate);
  if (exact) return { group: RELATED_CONTEXT_GROUP.EXACT, basis: exact };
  const related = resemblanceBasis(subject, candidate);
  if (related) return { group: RELATED_CONTEXT_GROUP.RELATED, basis: related.basis, score: related.score };
  return { group: null, basis: null };
}

/**
 * Amount benchmark against a comparison population, gated by
 * RELATED_CONTEXT_AMOUNT_BENCHMARK_POLICY (imported unchanged). The subject
 * amount is inserted into the population to form the comparison cohort --
 * the same shape comparative_award_rank.mjs's own peer group takes -- and
 * ranked/percentiled with that module's own tie-aware formula.
 */
export function buildAmountBenchmark(subjectAmount, populationAmounts = []) {
  const amount = Number(subjectAmount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const population = (Array.isArray(populationAmounts) ? populationAmounts : [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const group = [...population, amount].sort((a, b) => b - a);
  const cohortSize = group.length;
  const policy = RELATED_CONTEXT_AMOUNT_BENCHMARK_POLICY;

  if (cohortSize < policy.minimum_rank_count) return null; // small cohort: omitted entirely

  let tieStart = 0;
  while (tieStart < cohortSize && group[tieStart] > amount) tieStart += 1;
  let tieEnd = tieStart;
  while (tieEnd + 1 < cohortSize && group[tieEnd + 1] === amount) tieEnd += 1;
  const rank = tieStart + 1;
  const tieCount = tieEnd - tieStart + 1;

  if (cohortSize < policy.minimum_percentile_count) {
    return {
      status: "rank_only",
      rank,
      tie_count: tieCount,
      cohort_size: cohortSize,
      percentile: null,
      label: `Ranks ${rank} of ${cohortSize} comparable awards by amount (percentile withheld for a small cohort)`,
    };
  }

  const percentile = Math.round(((cohortSize - tieStart) / cohortSize) * 10_000) / 100;
  return {
    status: "percentile",
    rank,
    tie_count: tieCount,
    cohort_size: cohortSize,
    percentile,
    label: `Larger than ${percentile}% of ${cohortSize} comparable awards by amount`,
  };
}

function candidateEntry(candidate, classification) {
  const amount = Number(candidate?.amount);
  return {
    id: text(candidate?.request_id || candidate?.id),
    title: text(candidate?.short_title || candidate?.title) || "Untitled record",
    vendor_name: text(candidate?.vendor_name),
    agency_name: text(candidate?.agency_name),
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    award_date: text(candidate?.award_date || candidate?.start_date),
    href: text(candidate?.href),
    basis: classification.basis,
    ...(classification.group === RELATED_CONTEXT_GROUP.RELATED ? { resemblance: true } : {}),
  };
}

/**
 * Build the related-procurement-context view model, or null when there is
 * nothing to show (no classified candidates and no amount benchmark) --
 * matching the pursuit snapshot's own null-means-no-section contract.
 */
export function buildRelatedProcurementContext({ subject = {}, candidates = [], populationAmounts = [] } = {}) {
  const s = subject || {};
  const subjectId = text(s.request_id || s.id);
  const exactChain = [];
  const related = [];

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate) continue;
    const candidateId = text(candidate.request_id || candidate.id);
    if (subjectId && candidateId && subjectId === candidateId) continue; // never match the subject to itself
    const classification = classifyHistoryCandidate(s, candidate);
    if (classification.group === RELATED_CONTEXT_GROUP.EXACT) {
      exactChain.push(candidateEntry(candidate, classification));
    } else if (classification.group === RELATED_CONTEXT_GROUP.RELATED) {
      related.push(candidateEntry(candidate, classification));
    }
  }

  const byRecencyDesc = (a, b) => (b.award_date || "").localeCompare(a.award_date || "");
  exactChain.sort(byRecencyDesc);
  related.sort(byRecencyDesc);

  const amountBenchmark = buildAmountBenchmark(s.amount, populationAmounts);

  if (!exactChain.length && !related.length && !amountBenchmark) return null;

  return {
    schema: PROCUREMENT_RELATED_CONTEXT_SCHEMA,
    exact_chain: exactChain,
    related,
    amount_benchmark: amountBenchmark,
  };
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toLocaleString("en-US")}` : null;
}

const EXACT_HEADING = "Exact procurement history";
const RELATED_HEADING = "Related procurement context";
// Deliberately never uses "incumbent" -- resemblance is not lineage, and this
// module's fixed copy never asserts what the underlying records do not
// support (G2/A3), whatever exact_chain vendors it renders alongside.
const RELATED_NOTE = "These resemble this opportunity by agency and shared title language, but are not proven to be the same procurement.";

function historyRowHtml(entry) {
  const title = esc(entry.title);
  const titleHtml = entry.href
    ? `<a class="related-context-link" href="${esc(entry.href)}">${title}</a>`
    : `<span class="related-context-title">${title}</span>`;
  const vendor = entry.vendor_name ? `<span class="related-context-vendor">${esc(entry.vendor_name)}</span>` : "";
  const amount = formatMoney(entry.amount);
  const amountHtml = amount ? `<span class="related-context-amount">${esc(amount)}</span>` : "";
  const date = entry.award_date ? `<span class="related-context-date">${esc(entry.award_date)}</span>` : "";
  return `<li class="related-context-row" data-related-context-basis="${esc(entry.basis || "")}">${titleHtml}${vendor}${amountHtml}${date}</li>`;
}

function amountBenchmarkHtml(benchmark) {
  if (!benchmark?.label) return "";
  return `<p class="related-context-benchmark" data-related-context-benchmark-status="${esc(benchmark.status)}">${esc(benchmark.label)}</p>`;
}

/**
 * Render the related-context view model to a self-contained HTML section.
 * Callers embed this immediately beneath the pursuit snapshot on procurement
 * detail. Returns "" when `view` is null so an unready caller can splice
 * this in unconditionally, same as renderPursuitSnapshotHtml().
 */
export function renderRelatedProcurementContextHtml(view, { headingId = "related-context-heading" } = {}) {
  if (!view) return "";

  const exactHtml = view.exact_chain.length
    ? `<div class="related-context-group" data-related-context-group="exact">
        <p class="related-context-subhead">${esc(EXACT_HEADING)}</p>
        <ul class="related-context-list">${view.exact_chain.map(historyRowHtml).join("")}</ul>
      </div>`
    : "";
  const relatedHtml = view.related.length
    ? `<div class="related-context-group" data-related-context-group="related">
        <p class="related-context-subhead">${esc(RELATED_HEADING)}</p>
        <p class="related-context-note">${esc(RELATED_NOTE)}</p>
        <ul class="related-context-list">${view.related.map(historyRowHtml).join("")}</ul>
      </div>`
    : "";
  const benchmarkHtml = amountBenchmarkHtml(view.amount_benchmark);

  if (!exactHtml && !relatedHtml && !benchmarkHtml) return "";

  return `<section class="related-context" aria-labelledby="${esc(headingId)}" data-related-context="1">
    <h2 id="${esc(headingId)}">Related context and benchmarks</h2>
    ${benchmarkHtml}
    ${exactHtml}
    ${relatedHtml}
  </section>`;
}
