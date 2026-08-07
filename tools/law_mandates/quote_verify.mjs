// Mechanical quote verification for statute-derived extraction rows.

/** Collapse all Unicode whitespace without changing non-whitespace characters. */
export function normalizeQuoteText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * A quote is a fact only when it is a contiguous substring of the fetched law
 * after whitespace normalization. Typography or punctuation changes fail.
 */
export function verifyQuote(quote, lawText) {
  const normalizedQuote = normalizeQuoteText(quote);
  const normalizedLaw = normalizeQuoteText(lawText);
  if (!normalizedQuote) return { verified: false, reason: "missing_quote" };
  if (!normalizedLaw) return { verified: false, reason: "missing_law_text" };
  if (normalizedLaw.includes(normalizedQuote)) return { verified: true, reason: "matched" };
  return { verified: false, reason: "quote_not_found" };
}
