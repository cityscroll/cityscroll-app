// Pure, dependency-free helpers for /nl — unit-testable and runtime-agnostic
// (works identically under Node tests and the Cloudflare Workers runtime).

export const MAX_INPUT = 600;          // characters of NL we accept (a paragraph, not a novel)
export const MAX_CALLS_PER_DAY = 300;  // denial-of-wallet ceiling

// Which filter fields each lens cares about. The /nl tool schema is built from these,
// and sanitize() clamps exactly these fields — so one model, many lenses.
// Procurement categories as they appear verbatim in the dataset (vocab merged from
// Dev's crol-alert filter enums, grounded in the EDA value counts).
export const CATEGORIES = [
  "Goods",
  "Goods and Services",
  "Services (other than human services)",
  "Human Services/Client Services",
  "Construction/Construction Services",
  "Construction Related Services",
];

export const LENSES = {
  // money's field list IS the general procurement-notice filter schema — additive: a new
  // field is a new array entry + clampField case, nothing else. It's keyed to what
  // lib/compile.mjs's compileSub() can actually turn into a SODA query (see that file's own
  // header comment), not to any one example query — see AGENTS.md's "Alerts NL query"
  // section for the inventory this was drawn from.
  money:    ["keywords", "agency", "minAmount", "maxAmount", "category", "months", "noticeType", "excludeSpecial"],
  people:   ["keywords", "lookupType"],
  land:     ["keywords", "boro", "status"],
  property: ["keywords", "agency"],
  rules:    ["keywords", "agency"],
  meetings: ["keywords", "agency", "when"],
  entity:   ["name", "kind"],
  // "alerts" has no single-payload classifier (bigaward xor rfpkw xor rezone) — it reuses
  // money's full general schema so a query naming any combination of category/agency/
  // amount/notice-type/deadline keeps all of them, not just whichever one field a fixed enum
  // happened to pick. watchType/place survive only to mark the one genuinely different
  // shape: a rezoning watch, which has a place instead of a dollar amount or a due date.
  alerts:   ["watchType", "place", "keywords", "agency", "minAmount", "maxAmount", "category", "months", "noticeType", "excludeSpecial"],
  // award: "tell me when THIS notice's award registers" — the delivery wrapper the same
  // (email,lens,filter) idempotent-subscribe key already gives every other lens for free, just
  // scoped to one notice instead of a standing query. See alerts.mjs's processAwardSub() for
  // why this never runs through compileSub()/digestDecision() like the other lenses.
  award:    ["requestId", "agency"],
};

const BOROS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];

// Clamp one field to a safe, well-formed value. Anything unexpected → null / empty.
function clampField(name, v) {
  switch (name) {
    case "keywords":
      return Array.isArray(v) ? v.map((k) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 4) : [];
    case "agency":
      return typeof v === "string" && v.trim() ? v.trim() : null;
    case "minAmount":
      return typeof v === "number" && v >= 1000 ? Math.round(v) : null;
    case "maxAmount":
      return typeof v === "number" && v >= 1000 ? Math.round(v) : null;
    case "category":
      return CATEGORIES.includes(v) ? v : null;
    case "months":
      return typeof v === "number" && v > 0 && v <= 60 ? Math.round(v) : null;
    case "noticeType":
      // Explicit override of the amount-presence heuristic compileSub() otherwise falls
      // back to (only Award notices carry a dollar amount in this dataset — Solicitations
      // don't — so an amount bound alone still implies "award" when this is null).
      return v === "award" ? "award" : v === "solicitation" ? "solicitation" : null;
    case "excludeSpecial":
      return !!v;
    case "boro": {
      const s = typeof v === "string" ? v.trim().toLowerCase() : "";
      return BOROS.find((b) => b.toLowerCase() === s) || null;
    }
    case "status":
      return v === "all" ? "all" : v === "active" ? "active" : null;
    case "when":
      return v === "all" ? "all" : v === "upcoming" ? "upcoming" : null;
    case "lookupType":
      return v === "person" ? "person" : v === "role" ? "role" : null;
    case "name":
      return typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, 120) : null;
    case "kind":
      return v === "agency" ? "agency" : v === "vendor" ? "vendor" : null;
    case "watchType":
      return v === "rezone" ? "rezone" : null;
    case "place":
      return typeof v === "string" && v.trim() ? v.trim() : null;
    case "requestId":
      // Same shape handleExternalAward() already validates request ids against.
      return typeof v === "string" && /^[A-Za-z0-9_-]{4,40}$/.test(v.trim()) ? v.trim() : null;
    default:
      return null;
  }
}

// Clamp the model's tool output to exactly the lens's fields, in the expected shapes — so
// malformed/out-of-range/oversized model output can never propagate to the browser. This is
// part of the defense in depth: even a misbehaving model yields a small, well-formed object.
export function sanitize(lens, input) {
  const fields = LENSES[lens] || LENSES.money;
  const f = input || {};
  const out = {};
  for (const name of fields) out[name] = clampField(name, f[name]);
  return out;
}

// Field evidence 2026-07-14: the ask button "required very specific wording" and a paraphrase
// that the model barely parsed came back as a silent, unexplained empty result — the caller had
// no signal to distinguish "confidently narrow" from "we understood almost nothing." "low" means
// the sanitized filter carries no narrowing signal at all (no keywords, every other field still
// null/false/empty) — a pure function of sanitize()'s own output, so it needs no extra model call
// or schema change and stays inside the existing Haiku metering. Additive to /nl's response shape
// (a new sibling field, nothing existing changes) so a client that doesn't read it is unaffected.
export function filterConfidence(lens, filter) {
  const fields = LENSES[lens] || LENSES.money;
  const f = filter || {};
  const hasSignal = fields.some((name) => {
    const v = f[name];
    if (Array.isArray(v)) return v.length > 0;
    return v !== null && v !== undefined && v !== false && v !== "";
  });
  return hasSignal ? "high" : "low";
}

// Digest deep-links (w12-12): carry the originating watch's own filter in the notice link's URL
// fragment, so the site can re-render the same Matched-evidence + interpretation-echo the reader
// would have seen running the watch themselves — no server-side state, nothing identifying beyond
// what the email already contains. Drops null/false/empty fields (sanitize()'s own output always
// fills every schema field, most of them unset for a given watch) to keep the link short and to
// give the client's own clamp step, which iterates the SAME schema, nothing extra to ignore.
export function encodeWatchFilter(lens, filter) {
  if (!lens || !LENSES[lens]) return null;
  const clamped = sanitize(lens, filter);
  const compact = {};
  for (const [name, v] of Object.entries(clamped)) {
    if (v === null || v === false || (Array.isArray(v) && v.length === 0)) continue;
    compact[name] = v;
  }
  if (!Object.keys(compact).length) return null; // nothing worth carrying
  try {
    return encodeURIComponent(JSON.stringify({ lens, filter: compact }));
  } catch {
    return null;
  }
}
