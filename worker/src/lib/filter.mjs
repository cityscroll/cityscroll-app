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
  // Discovery parity (2026-08): district/process/deadline/entity fields are first-class so
  // NL can route to the same deep links the UI already supports (council/cd, process rails,
  // closing-this-week, agency forecast tab) — not only keyword lists.
  money:    ["keywords", "agency", "minAmount", "maxAmount", "category", "months", "noticeType", "excludeSpecial", "closingWeek", "route", "name", "tab"],
  people:   ["keywords", "lookupType", "view", "interestArea", "interestLabel"],
  land:     ["keywords", "boro", "status", "communityDistrict", "councilDistrict", "nearMe"],
  property: ["keywords", "agency", "process", "stage", "asset", "saleMethod", "priceBand", "sort", "borough", "neighborhood", "nearMe"],
  rules:    ["keywords", "agency", "process"],
  meetings: ["keywords", "agency", "when", "borough", "neighborhood", "locationScope", "dateWindow", "process", "nearMe"],
  district: ["councilDistrict"],
  entity:   ["name", "kind", "tab"],
  // "alerts" has no single-payload classifier (bigaward xor rfpkw xor rezone) — it reuses
  // money's full general schema so a query naming any combination of category/agency/
  // amount/notice-type/deadline keeps all of them, not just whichever one field a fixed enum
  // happened to pick. watchType/place survive only to mark the one genuinely different
  // shape: a rezoning watch, which has a place instead of a dollar amount or a due date.
  alerts:   ["watchType", "place", "keywords", "agency", "minAmount", "maxAmount", "category", "months", "noticeType", "excludeSpecial", "closingWeek", "route", "name", "tab"],
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
      return ["all", "upcoming", "week", "month", "past"].includes(v) ? v : null;
    case "borough": {
      const s = typeof v === "string" ? v.trim().toLowerCase() : "";
      return BOROS.find((b) => b.toLowerCase() === s) || null;
    }
    case "neighborhood":
      return typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, 80) : null;
    case "locationScope":
      return v === "citywide-unlocated" || v === "citywide" || v === "virtual" || v === "unlocated" ? v : null;
    case "dateWindow":
      return ["week", "month", "upcoming"].includes(v) ? v : null;
    case "lookupType":
      return v === "person" ? "person" : v === "role" ? "role" : null;
    case "view":
      return v === "guide" ? "guide" : null;
    case "interestArea":
      return [
        "public-safety", "health-care", "engineering-construction", "technology-science",
        "community-social-services", "administration-finance", "trades-operations",
      ].includes(v) ? v : null;
    case "interestLabel":
      return typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, 80) : null;
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
    case "closingWeek":
      return !!v;
    case "route":
      return v === "agency" || v === "vendor" ? v : null;
    case "tab":
      return v === "forecast" || v === "overview" ? v : null;
    case "communityDistrict": {
      const s = typeof v === "string" ? v.trim().toUpperCase() : "";
      return /^(?:M|X|K|Q|R)\d{2}$/.test(s) ? s : null;
    }
    case "councilDistrict": {
      const s = typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
      return /^(?:[1-9]|[1-4]\d|5[01])$/.test(s) ? s : null;
    }
    case "nearMe":
      return !!v;
    case "process": {
      const allowed = [
        // rules
        "proposal", "public_process", "adoption", "effective", "unstaged",
        // property disposition
        "hearing", "auction_or_rfp", "award_or_conveyance",
        // meetings
        "scheduled", "agenda", "held", "outcomes",
      ];
      return allowed.includes(v) ? v : null;
    }
    case "stage": {
      const s = typeof v === "string" ? v.trim() : "";
      return s && s !== "all" ? s.slice(0, 40) : null;
    }
    case "asset": {
      const s = typeof v === "string" ? v.trim() : "";
      return s && s !== "all" ? s.slice(0, 40) : null;
    }
    case "saleMethod": {
      const s = typeof v === "string" ? v.trim().toLowerCase().replace(/-/g, "_") : "";
      const allowed = ["online_auction", "public_auction", "sealed_bid", "rfp", "lease_auction"];
      return allowed.includes(s) ? s : null;
    }
    case "priceBand": {
      const s = typeof v === "string" ? v.trim().toLowerCase().replace(/-/g, "_") : "";
      const allowed = ["priced", "under_10k", "10k_100k", "100k_plus"];
      return allowed.includes(s) ? s : null;
    }
    case "sort": {
      const s = typeof v === "string" ? v.trim().toLowerCase().replace(/-/g, "_") : "";
      const allowed = ["closing_soon", "newest", "price_desc", "price_asc"];
      return allowed.includes(s) ? s : null;
    }
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
