// tools/changelog_extract.mjs — pure extraction of a PR's user-impact line from its body,
// plus the gate that decides whether that PR clears the changelog's editorial bar.
//
// Convention (documented in CONTRIBUTING.md): a PR states its user impact in a
// "## What this means for you" section (any heading level, case-insensitive). That alone
// no longer earns a changelog.html entry — every PR in this project's workflow carries that
// section by internal convention, whether the change is a major feature or an invisible
// refactor, so section-presence stopped meaning "significant" (the
// generated page had drifted into a near-mirror of the merged-PR log, some entries reading
// "No visible change to the site" or "Not user-facing" — literally saying they don't belong
// on the page while still appearing on it). A PR now ALSO needs the `changelog:major` label
// to be harvested — an explicit, one-click affirmation ("this is worth a reader's attention"),
// separate from the body text. No label -> no entry, same as no marker section -> no entry;
// this is the mechanism that keeps changelog.html self-updating without a human hand-editing
// the page, while keeping "is this significant" a deliberate per-PR decision instead of a
// default.
//
// Plain ESM (this repo's tools/ scripts and their tests use `.mjs` + import/export; the
// require()-able-dictionary convention documented for i18n.js/nl_parse.js is specific to
// runtime files loaded as plain <script> tags in the browser, which this is not).

const MARKER_RE = /^#{1,6}\s*what this means for you\s*$/i;
const HEADING_RE = /^#{1,6}\s+\S/;
const LIST_MARKER_RE = /^(?:[-*+]|\d+[.)])\s+/;

export const MAJOR_LABEL = "changelog:major";

export function hasMajorLabel(labels) {
  if (!labels) return false;
  const list = Array.isArray(labels) ? labels : [labels];
  return list.some((l) => String(l).trim().toLowerCase() === MAJOR_LABEL);
}

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
    // Strip a leading list marker ("- ", "* ", "1. ") so a section written as a bullet
    // list doesn't leak a literal "-" into the rendered, joined-with-spaces sentence.
    collected.push(trimmed.replace(LIST_MARKER_RE, ""));
  }

  const text = collected.join(" ").replace(/\s+/g, " ").trim();
  return text || null;
}
