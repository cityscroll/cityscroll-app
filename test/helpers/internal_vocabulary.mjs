/**
 * Internal product vocabulary for rendered-copy assertions.
 *
 * The names are deliberately not written here, in any form.
 *
 * This repository is public, and its naming boundary
 * (docs/repository-governance/naming-boundary.v1.json) keeps every private
 * identifier in an owner-controlled term set outside the tree, because a
 * committed denylist publishes the very name it exists to keep out. That holds
 * for an encoded denylist too: a digest, a character-code table, or a pair of
 * quoted fragments joined at run time is a mechanical, reversible encoding of
 * the word, and tools/private_identifier_scan.mjs decodes exactly those shapes
 * for that reason. Writing a private name here in any spelling would put it on
 * the public tip.
 *
 * So this helper reads the same owner-controlled term set the scan reads, and
 * carries no term of its own. Adding another private name is a change to that
 * owner-controlled input, never a change to this repository.
 *
 * Modes follow the scan's:
 *
 *   no term set   The internal clause contributes nothing and the surrounding
 *                 assertion still runs on its public vocabulary. Public CI stays
 *                 credential-free and asserts only what it can actually check.
 *   term set      Every supplied term is asserted absent from the rendered copy,
 *                 case-insensitively, on the same word boundaries as the public
 *                 vocabulary.
 *
 * An unreadable term set is an error rather than an empty term set, so a
 * mistyped owner-controlled path can never read as a quiet pass.
 */

import { loadTermSet } from "../../tools/private_identifier_scan.mjs";

const REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * Escape a term for literal use inside an alternation. Terms arrive as plain
 * text from the owner-controlled input, so they are literals, unlike the public
 * alternatives below which are already patterns.
 */
function escapeLiteral(term) {
  return term.replace(REGEXP_METACHARACTERS, "\\$&");
}

/**
 * The owner-supplied private terms, as escaped alternation fragments. Empty when
 * no term set is supplied.
 */
export function internalVocabularyAlternatives({ env = process.env } = {}) {
  const loaded = loadTermSet({ env });
  if (loaded.error) throw new Error(`internal vocabulary term set unavailable: ${loaded.error}`);
  return loaded.terms.map(escapeLiteral);
}

/**
 * Build the forbidden-vocabulary matcher for a rendered-copy assertion.
 *
 * `publicAlternatives` are regular-expression fragments, exactly as they were
 * written inline before this helper existed. The owner-supplied private terms
 * are appended as escaped literals.
 */
export function forbiddenVocabularyPattern(publicAlternatives, { env = process.env, flags = "i" } = {}) {
  const alternatives = [...publicAlternatives, ...internalVocabularyAlternatives({ env })];
  return new RegExp(String.raw`\b(?:${alternatives.join("|")})\b`, flags);
}
