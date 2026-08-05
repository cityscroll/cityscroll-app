// Pure helpers for POST /batch — the Datashare-style watchlist cross-reference.
// Caps are the denial-of-wallet posture: bounded names per request, bounded name length.

import { cleanNoticeText } from "../../../site/text_clean.mjs";
import { entityHref, entityRouteRef } from "../../../site/entity_pivot.mjs";

export const MAX_NAMES = 10;
export const MAX_NAME_LEN = 80;

export function vendorEntityPermalink(name, origin = "https://cityscroll.org") {
  const label = cleanNoticeText(name);
  return new URL(entityHref({ ref: entityRouteRef("vendor", label), label }), `${String(origin).replace(/\/$/, "")}/`).href;
}

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
