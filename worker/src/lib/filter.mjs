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
  money:    ["keywords", "agency", "minAmount", "maxAmount", "category", "months", "excludeSpecial"],
  people:   ["keywords", "lookupType"],
  land:     ["keywords", "boro", "status"],
  property: ["keywords", "agency"],
  rules:    ["keywords", "agency"],
  meetings: ["keywords", "agency", "when"],
  entity:   ["name", "kind"],
  alerts:   ["watchType", "threshold", "keyword", "place"],
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
      return ["bigaward", "rfpkw", "rezone"].includes(v) ? v : null;
    case "threshold":
      return typeof v === "number" && v >= 1000 ? Math.round(v) : null;
    case "keyword":
      return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
    case "place":
      return typeof v === "string" && v.trim() ? v.trim() : null;
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
