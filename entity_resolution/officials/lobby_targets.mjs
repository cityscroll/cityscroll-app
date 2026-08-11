// Free-text lobbyist_targets parser (influence-graph research method port).
//
// "NYC Council Members Gale Brewer - District No. 6; ..." →
//   [{ key: "GALE BREWER", display: "NYC Council Members Gale Brewer" }, ...]
// Pure, deterministic, no network.

import { foldPersonText } from "./person_name.mjs";

const TGT_SPLIT = /[;\n]/;
const TGT_DISTRICT = /\s*-\s*District.*$/i;
const TGT_NOISE = /\b(NYC|NEW YORK CITY|COUNCIL|MEMBERS?|THE)\b/gi;
const TGT_NONALPHA = /[^A-Z ]/g;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * Parse a City Clerk eLobbyist `lobbyist_targets` blob into target entities.
 * @param {string|null|undefined} blob
 * @returns {Array<{ key: string, display: string }>}
 */
export function parseLobbyTargets(blob) {
  const seen = new Set();
  const out = [];
  for (const rawPart of String(blob ?? "").split(TGT_SPLIT)) {
    const part = clean(rawPart.replace(TGT_DISTRICT, ""));
    if (!part) continue;
    let key = foldPersonText(part);
    key = key.replace(TGT_NOISE, " ");
    key = key.replace(TGT_NONALPHA, " ");
    key = key.replace(/\s+/g, " ").trim();
    if (key.length < 4 || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, display: clean(part).slice(0, 80) });
  }
  return out;
}

/** Heuristic: person-shaped lobby target (Council members, Speaker, BP, Mayor). */
export function isPersonShapedLobbyTarget(display) {
  const text = clean(display);
  if (!text) return false;
  if (/\b(Department of|Commission on|Authority|Board of Education)\b/i.test(text)) {
    return false;
  }
  return /\b(Council Members?|Speaker|Borough President|Mayor)\b/i.test(text)
    || /^[A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z'\-]+)+$/.test(text);
}
