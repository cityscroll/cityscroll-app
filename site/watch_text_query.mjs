/**
 * Versioned precise-watch text expression (`cityscroll.watch_text_query.v1`).
 *
 * A `text_query` represents what a reader wants a standing watch to match,
 * explicitly: required alternative groups (AND of ORs), literal terms, literal
 * phrases, and literal exclusions. It exists because the legacy four-keyword
 * list cannot state any of those shapes, and every existing evaluator already
 * interprets that list differently (D1 ORs it, the procurement snapshot ANDs
 * it, the browser matcher expands plurals/synonyms). v1 is deliberately NOT an
 * extension of those matchers: one literal predicate, defined once here.
 *
 * Matching semantics (`cityscroll.watch_text_query.v1`):
 * - `all` is an AND of groups; within a group, any atom (OR) satisfies it.
 * - Every atom in `none` rejects the record when it matches.
 * - An atom is one literal term (exactly one token) or one literal phrase
 *   (an adjacent token sequence). Atoms match within a single cleaned field;
 *   a phrase never bridges two fields (title end + description start).
 * - Whole-token, case-insensitive, Unicode NFKC matching. `rat` does not match
 *   Strategy, Integrated, or rate. No prefix matching.
 * - No plural, synonym, alias, or stemming expansion. v1 literals are literal:
 *   exclusion of `maintenance` never removes `maintenance services` via
 *   imagination, and `school` does not pull in `education`. Readers list
 *   variants explicitly.
 * - Formatting HTML and punctuation inside a field are token separators, so a
 *   phrase survives `<b>Construction</b> Management` and `Design-Build` — the
 *   phrase matches the token sequence, not the raw bytes.
 *
 * Evaluated field contract: this module is field-agnostic on purpose. The
 * caller supplies the per-family field projection (for procurement notices:
 * the materialized title and the cleaned description; structured facets such
 * as agency or identifiers are NOT hidden text fields and can never
 * manufacture a phrase). Because atoms are evaluated per field, the projection
 * choice is the field-evidence contract and must be the same for every
 * renderer of one watch.
 *
 * This module is pure and dependency-free apart from text_clean.mjs (shared
 * notice-text hygiene) so the browser, the Worker, and Node tests all evaluate
 * one meaning. Compatibility: a filter without `text_query` never touches this
 * module's code paths — legacy watches keep byte-stable identities.
 */

import { cleanNoticeText } from "./text_clean.mjs";

export const TEXT_QUERY_SCHEMA = Object.freeze({
  schema: "cityscroll.watch_text_query.v1",
  version: 1,
  mode: "literal_token",
  infix: false,
  prefix: false,
  plural_expansion: false,
  synonym_expansion: false,
  phrase_spans_fields: false,
});

// Explicit input bounds (the shared specification's compatibility decisions).
// Over-limit input is REJECTED, never truncated: dropping a constraint would
// silently widen a saved watch.
export const TEXT_QUERY_LIMITS = Object.freeze({
  maxPositiveGroups: 4,
  maxAlternativesPerGroup: 4,
  maxExclusions: 8,
  maxAtomChars: 120,
  maxTotalChars: 2000,
});

/**
 * Structured non-text scope fields that make a negative-only expression (no
 * required groups, only exclusions) meaningful. A lens by itself is not scope.
 * Deliberately conservative: extend only with facets that genuinely narrow the
 * candidate set on their own.
 */
export const TEXT_QUERY_STRUCTURED_SCOPE_FIELDS = Object.freeze([
  "agency",
  "category",
  "minAmount",
  "maxAmount",
  "noticeType",
  "geographies",
  "procurement_id",
  "boro",
  "borough",
  "communityDistrict",
  "councilDistrict",
  "communityBoard",
]);

/**
 * Support registry: which lenses admit a v1 expression, and which can actually
 * evaluate one end to end. `admission` means the storage contract (validate +
 * canonicalize + identity) is wired for that lens. `evaluation` means a
 * delivery/preview path consumes the expression; until it is true, every
 * evaluator must refuse the watch (fail closed) rather than silently run it as
 * an unfiltered legacy query. Money evaluation uses the shared procurement
 * adapter (`site/watch_text_query_eval.mjs`) on owned notice and procurement-
 * object materializations. This registry is the single source both the worker
 * compilers and the tests consult — no path may accept a v1 expression it does
 * not register support for.
 */
export const TEXT_QUERY_SUPPORT = Object.freeze({
  money: Object.freeze({
    lens: "money",
    admission: true,
    evaluation: true,
  }),
});

const ADMISSION_LENSES = new Set(
  Object.values(TEXT_QUERY_SUPPORT).filter((s) => s.admission).map((s) => s.lens),
);
const EVALUATION_LENSES = new Set(
  Object.values(TEXT_QUERY_SUPPORT).filter((s) => s.evaluation).map((s) => s.lens),
);

/** True when the lens's storage contract admits a v1 expression. */
export function textQueryAdmissionSupported(lens) {
  return ADMISSION_LENSES.has(String(lens || ""));
}

/** True when some registered delivery path actually evaluates v1 for the lens. */
export function textQueryEvaluationSupported(lens) {
  return EVALUATION_LENSES.has(String(lens || ""));
}

// Literal v1 tokenizer: HTML/entities stripped via the shared cleaner, NFKC,
// lowercase, Unicode word tokens. No singular/plural canonicalization and no
// synonym table — unlike site/keyword_matcher.mjs, whose reviewed expansions
// are intentionally NOT inherited here.
export function textQueryTokens(value) {
  return cleanNoticeText(String(value == null ? "" : value))
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function atomError(code, detail) {
  return { code, detail: detail ?? null };
}

// Validate and canonicalize one atom. Returns { ok, atom } or { ok:false, code }.
function canonicalAtom(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, ...atomError("malformed_atom") };
  }
  const keys = Object.keys(raw);
  if (keys.some((k) => k !== "kind" && k !== "value")) {
    return { ok: false, ...atomError("unknown_atom_key") };
  }
  if (raw.kind !== "term" && raw.kind !== "phrase") {
    return { ok: false, ...atomError("unknown_atom_kind") };
  }
  if (typeof raw.value !== "string" || !raw.value.trim()) {
    return { ok: false, ...atomError("empty_atom") };
  }
  const tokens = textQueryTokens(raw.value);
  if (!tokens.length) {
    return { ok: false, ...atomError("empty_atom") };
  }
  if (raw.kind === "term" && tokens.length !== 1) {
    return { ok: false, ...atomError("term_not_single_token") };
  }
  // Canonical value: the token sequence joined by single spaces. Whitespace,
  // casing, formatting HTML, and punctuation variants all collapse to it, so
  // the canonical form is what identity (canonical JSON) is computed over.
  const value = tokens.join(" ");
  if (value.length > TEXT_QUERY_LIMITS.maxAtomChars) {
    return { ok: false, ...atomError("atom_too_long") };
  }
  return { ok: true, atom: { kind: raw.kind, value } };
}

const atomKey = (a) => `${a.kind}\u0000${a.value}`;

function isPlainArray(value) {
  return Array.isArray(value);
}

/**
 * Validate a raw text_query value and return its canonical form.
 *
 * Returns `{ ok: true, canonical }` where `canonical` is either `null` (the
 * expression carries no constraint at all — callers omit the field) or a plain
 * JSON object `{ version: 1, all: [[{kind,value}...]], none: [{kind,value}] }`
 * with groups and atoms deduped and deterministically sorted, so semantically
 * reordered / case-equivalent expressions canonicalize to one identity.
 * Returns `{ ok: false, code, reason }` for everything the specification
 * rejects; nothing is ever silently dropped or truncated.
 *
 * `structuredScope` (boolean) is required context for a negative-only
 * expression: exclusions with no required group must ride on a meaningful
 * non-text scope (e.g. a selected agency), supplied by the filter-level caller.
 */
export function validateTextQuery(raw, { structuredScope = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "not_object", reason: "text_query must be an object" };
  }
  const unknown = Object.keys(raw).filter((k) => k !== "version" && k !== "all" && k !== "none");
  if (unknown.length) {
    return { ok: false, code: "unknown_key", reason: `unknown text_query key: ${unknown[0]}` };
  }
  if (raw.version !== 1) {
    return { ok: false, code: "unsupported_version", reason: "unsupported text_query version" };
  }
  const all = raw.all === undefined ? [] : raw.all;
  const none = raw.none === undefined ? [] : raw.none;
  if (!isPlainArray(all)) {
    return { ok: false, code: "malformed_groups", reason: "text_query.all must be an array of groups" };
  }
  if (!isPlainArray(none)) {
    return { ok: false, code: "malformed_exclusions", reason: "text_query.none must be an array of atoms" };
  }
  if (all.length > TEXT_QUERY_LIMITS.maxPositiveGroups) {
    return { ok: false, code: "too_many_groups", reason: `at most ${TEXT_QUERY_LIMITS.maxPositiveGroups} positive groups` };
  }
  if (none.length > TEXT_QUERY_LIMITS.maxExclusions) {
    return { ok: false, code: "too_many_exclusions", reason: `at most ${TEXT_QUERY_LIMITS.maxExclusions} exclusions` };
  }

  const canonicalGroups = [];
  for (const group of all) {
    if (!isPlainArray(group) || !group.length) {
      return { ok: false, code: "empty_group", reason: "every positive group must be a nonempty array of atoms" };
    }
    if (group.length > TEXT_QUERY_LIMITS.maxAlternativesPerGroup) {
      return { ok: false, code: "group_too_large", reason: `at most ${TEXT_QUERY_LIMITS.maxAlternativesPerGroup} alternatives per group` };
    }
    const atoms = [];
    const seen = new Set();
    for (const rawAtom of group) {
      const result = canonicalAtom(rawAtom);
      if (!result.ok) {
        return { ok: false, code: result.code, reason: `invalid atom: ${result.code}` };
      }
      const key = atomKey(result.atom);
      if (!seen.has(key)) {
        seen.add(key);
        atoms.push(result.atom);
      }
    }
    atoms.sort((a, b) => atomKey(a).localeCompare(atomKey(b)));
    canonicalGroups.push(atoms);
  }
  canonicalGroups.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const dedupedGroups = canonicalGroups.filter((g, i) =>
    i === 0 || JSON.stringify(g) !== JSON.stringify(canonicalGroups[i - 1]));

  const canonicalNone = [];
  const seenNone = new Set();
  for (const rawAtom of none) {
    const result = canonicalAtom(rawAtom);
    if (!result.ok) {
      return { ok: false, code: result.code, reason: `invalid exclusion atom: ${result.code}` };
    }
    const key = atomKey(result.atom);
    if (!seenNone.has(key)) {
      seenNone.add(key);
      canonicalNone.push(result.atom);
    }
  }
  canonicalNone.sort((a, b) => atomKey(a).localeCompare(atomKey(b)));

  if (!dedupedGroups.length && !canonicalNone.length) {
    // Empty expression with no exclusions carries no constraint: omit it.
    return { ok: true, canonical: null };
  }
  if (!dedupedGroups.length && !structuredScope) {
    return {
      ok: false,
      code: "negative_only_requires_scope",
      reason: "exclusions without a required group need a structured scope such as a selected agency",
    };
  }

  const canonical = { version: 1, all: dedupedGroups };
  if (canonicalNone.length) canonical.none = canonicalNone;
  if (JSON.stringify(canonical).length > TEXT_QUERY_LIMITS.maxTotalChars) {
    return { ok: false, code: "expression_too_long", reason: "expression exceeds total size limit" };
  }

  // Direct contradiction: a positive group whose every alternative is also
  // excluded can never match — reject it instead of storing an always-false watch.
  const excluded = new Set(canonicalNone.map(atomKey));
  if (dedupedGroups.some((group) => group.every((atom) => excluded.has(atomKey(atom))))) {
    return {
      ok: false,
      code: "contradictory_required_excluded",
      reason: "a required group is entirely excluded by text_query.none",
    };
  }

  return { ok: true, canonical };
}

/** Canonicalize an already-validated expression; null when it carries no constraint. */
export function canonicalTextQuery(raw, options) {
  const result = validateTextQuery(raw, options);
  return result.ok ? result.canonical : null;
}

function atomTokens(atom) {
  // Canonical values are tokens joined by single spaces and tokens never
  // contain spaces, so splitting is exact.
  return atom.value.split(" ");
}

function atomMatchesField(atom, fieldTokens) {
  const needle = atomTokens(atom);
  const span = needle.length;
  for (let i = 0; i + span <= fieldTokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < span; j += 1) {
      if (fieldTokens[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Pure v1 predicate. `fields` is the caller's per-family field projection
 * (array of strings; nullish entries are skipped). `expression` is a raw or
 * canonical v1 expression. Every atom is evaluated within a single field, so
 * phrases never span field boundaries. An expression that carries no
 * constraint (empty / null) is vacuously true — callers omit it instead.
 */
export function matchesTextQuery(fields, expression) {
  // An omitted expression carries no constraint (vacuously true). Admission
  // canonicalizes empty expressions to null and omits the field entirely.
  if (expression == null) return true;
  // structuredScope is a filter-level admission concern, not a matching
  // concern: a legitimately admitted negative-only expression must still
  // evaluate here (match unless an exclusion matches).
  const validated = validateTextQuery(expression, { structuredScope: true });
  if (!validated.ok) return false;
  const canonical = validated.canonical;
  if (!canonical) return true;
  const cleaned = (Array.isArray(fields) ? fields : [])
    .filter((f) => f != null && f !== "")
    .map(textQueryTokens);
  const matchesAtom = (atom) => cleaned.some((tokens) => atomMatchesField(atom, tokens));
  if (canonical.all.length && !canonical.all.every((group) => group.some(matchesAtom))) return false;
  if (canonical.none?.length && canonical.none.some(matchesAtom)) return false;
  return true;
}

/**
 * Conservative candidate-retrieval groups for SQL LIKE / haystack pushdown.
 * Each required group becomes one OR-of-tokens group so retrieval is a
 * *superset* of canonical matches. Exclusions are never pushed: a LIKE
 * exclusion can omit a valid row when HTML or tokenization differs.
 * The shared predicate still decides membership.
 */
export function textQueryCandidateTermGroups(expression) {
  const validated = validateTextQuery(expression, { structuredScope: true });
  if (!validated.ok || !validated.canonical) return [];
  return validated.canonical.all
    .map((group) => [...new Set(group.flatMap((atom) => atomTokens(atom)))])
    .filter((group) => group.length);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function atomPassage(cleaned, atom, radius = 70) {
  const tokens = atomTokens(atom);
  if (!tokens.length || !cleaned) return null;
  const pattern = new RegExp(tokens.map(escapeRegExp).join("[^\\p{L}\\p{N}]+"), "iu");
  const match = cleaned.match(pattern);
  if (!match || match.index == null) return null;
  const start = Math.max(0, match.index - radius);
  const end = Math.min(cleaned.length, match.index + match[0].length + radius);
  return {
    index: match.index,
    hit: match[0],
    passage: `${start > 0 ? "…" : ""}${cleaned.slice(start, end)}${end < cleaned.length ? "…" : ""}`,
  };
}

/**
 * Field-evidence companion to `matchesTextQuery`. `namedFields` is
 * `[{ name, value }, ...]`; each atom is still evaluated within one field.
 * Returns `{ match, groups, exclusion }` where `groups` has one hit per
 * required group (the first matching alternative) and `exclusion` is the
 * first matching excluded atom, or null.
 */
export function explainTextQuery(namedFields, expression) {
  const fields = (Array.isArray(namedFields) ? namedFields : [])
    .filter((field) => field && field.value != null && field.value !== "")
    .map((field) => ({
      name: String(field.name || "field"),
      value: field.value,
      tokens: textQueryTokens(field.value),
      cleaned: cleanNoticeText(String(field.value)),
    }));
  if (expression == null) {
    return { match: true, groups: [], exclusion: null };
  }
  const validated = validateTextQuery(expression, { structuredScope: true });
  if (!validated.ok) return { match: false, groups: [], exclusion: null };
  const canonical = validated.canonical;
  if (!canonical) return { match: true, groups: [], exclusion: null };

  const locate = (atom) => {
    for (const field of fields) {
      if (!atomMatchesField(atom, field.tokens)) continue;
      const found = atomPassage(field.cleaned, atom);
      return {
        atom: { kind: atom.kind, value: atom.value },
        field: field.name,
        passage: found?.passage || field.cleaned,
        hit: found?.hit || atom.value,
      };
    }
    return null;
  };

  const groups = canonical.all.map((group) => {
    for (const atom of group) {
      const hit = locate(atom);
      if (hit) return hit;
    }
    return null;
  });
  const exclusion = (canonical.none || []).map(locate).find(Boolean) || null;
  const match = groups.every(Boolean) && !exclusion;
  return { match, groups, exclusion };
}
