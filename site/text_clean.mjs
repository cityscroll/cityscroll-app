// Shared notice-text hygiene for the static site and Worker.
//
// City Record fields arrive with presentation HTML and named/numeric entities
// (&ldquo; &rdquo; &rsquo; &sect; &nbsp; &#8220; …). Preview cards and full-notice
// views must process that source the same way:
//
//   1. strip tags
//   2. decode entities (plain Unicode)
//   3. truncate on the decoded string (never mid-entity)
//   4. escape once for HTML output
//
// Skipping step 2 then escaping yields literal "&ldquo;Agency&rdquo;" in cards
// (notice 20220525018). Decoding without step 4 opens XSS. Every excerpt surface
// should call excerptPlain / excerptHtml rather than inventing its own slice+escape.

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
  ldquo: "\u201C",
  rdquo: "\u201D",
  lsquo: "\u2018",
  rsquo: "\u2019",
  sbquo: "\u201A",
  bdquo: "\u201E",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  bull: "\u2022",
  middot: "\u00B7",
  sect: "\u00A7",
  para: "\u00B6",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  deg: "\u00B0",
  times: "\u00D7",
  divide: "\u00F7",
  plusmn: "\u00B1",
  frac12: "\u00BD",
  frac14: "\u00BC",
  frac34: "\u00BE",
  euro: "\u20AC",
  pound: "\u00A3",
  yen: "\u00A5",
  cent: "\u00A2",
};

// Up to two passes so a double-encoded "&amp;ldquo;" becomes a curly quote without
// looping forever on a bare ampersand.
export function decodeHtmlEntities(value) {
  let out = String(value == null ? "" : value);
  for (let pass = 0; pass < 2; pass++) {
    const next = out.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named !== undefined ? named : match;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

export function stripTags(value) {
  return String(value == null ? "" : value)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

// Plain Unicode notice text: tags gone, entities decoded, whitespace collapsed.
// Safe for search/matching/CSV/mailto. HTML sinks must escape the result once.
export function cleanNoticeText(value) {
  if (value == null || value === "") return "";
  return decodeHtmlEntities(stripTags(value))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Alias used by location extractors / hearing normalizers.
export function plainText(value) {
  return cleanNoticeText(value);
}

// Truncate on decoded plain text so a cut never lands inside "&ldquo;".
export function excerptPlain(value, maxLen = 240) {
  const plain = cleanNoticeText(value);
  if (!plain) return "";
  const n = Math.max(0, Number(maxLen) || 0);
  if (plain.length <= n) return plain;
  return plain.slice(0, n) + "…";
}

export function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&#39;",
    '"': "&quot;",
  }[c]));
}

// Decode → truncate → escape once. The only HTML excerpt path preview cards should use.
export function excerptHtml(value, maxLen = 240) {
  const plain = cleanNoticeText(value);
  if (!plain) return "";
  const n = Math.max(0, Number(maxLen) || 0);
  if (plain.length <= n) return escapeHtml(plain);
  return escapeHtml(plain.slice(0, n)) + "…";
}
