// tools/changelog_extract.mjs — pure extraction of a PR's user-impact line from its body.
//
// Convention (documented in CONTRIBUTING.md): a PR marks itself user-facing by carrying a
// "## What this means for you" section (any heading level, case-insensitive) with one line
// of plain-language, user-impact text. A PR with no such section is plumbing and produces
// nothing — this is the mechanism that keeps changelog.html self-updating without a human
// deciding, per PR, whether it belongs.
//
// Plain ESM (this repo's tools/ scripts and their tests use `.mjs` + import/export; the
// require()-able-dictionary convention documented for i18n.js/nl_parse.js is specific to
// runtime files loaded as plain <script> tags in the browser, which this is not).

const MARKER_RE = /^#{1,6}\s*what this means for you\s*$/i;
const HEADING_RE = /^#{1,6}\s+\S/;

export function extractUserImpact(body) {
  if (!body) return null;
  const lines = String(body).replace(/\r\n/g, "\n").split("\n");

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (MARKER_RE.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;

  const collected = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (HEADING_RE.test(line)) break; // next section ends the marker's scope
    const trimmed = line.trim();
    if (!trimmed) {
      if (collected.length) break; // blank line after content ends the section
      continue; // allow a blank line right after the heading
    }
    collected.push(trimmed);
  }

  const text = collected.join(" ").replace(/\s+/g, " ").trim();
  return text || null;
}
