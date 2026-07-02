// Pure helpers for POST /batch — the Datashare-style watchlist cross-reference.
// Caps are the denial-of-wallet posture: bounded names per request, bounded name length.

export const MAX_NAMES = 10;
export const MAX_NAME_LEN = 80;

export function parseNames(input) {
  const arr = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const s = String(raw || "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LEN);
    if (s.length >= 3 && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
    if (out.length >= MAX_NAMES) break;
  }
  return out;
}
