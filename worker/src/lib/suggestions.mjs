// Pure: the suggestion-chip candidate pool + the query-building that decides whether a
// candidate is currently fruitful. No network, no KV — see ../suggest.mjs for the daily
// cron pipeline that actually calls out to Socrata and writes the validated set.
//
// Field evidence (site owner, live production, 2026-07-15): under the money/contracts lens,
// the prefab suggestions "IT consulting RFPs" and "shelter services contracts" returned ZERO
// results while "construction contracts over $500k" worked — a suggestion that leads nowhere
// reads as a broken site, not an empty search. Every candidate below is verified against fresh
// data by the daily cron (worker/src/suggest.mjs's runSuggestionValidation(), called from the
// 13:00 UTC scheduled handler) before it's ever allowed to render as a chip.
//
// idx is a STABLE per-lens identifier — once assigned it is never reassigned to a different
// candidate, because it's also the i18n key suffix (`sugg_<lens>_<idx>` in i18n.js) and the
// index.html static-fallback subset (NL_SUGGESTIONS_FALLBACK) pins specific idx values. Add a
// new candidate at the next unused idx for its lens; never renumber an existing one.
//
// "people" has no entry here on purpose: compileSub() below returns null for it ("people isn't
// cron-replayable yet" — payroll-title counting needs different plumbing than every other lens,
// which all resolve to a Socrata $where + count(1)). Its chips stay the pre-existing hardcoded
// NL_SAMPLES.people in index.html, unvalidated — a documented, deliberate gap, not an oversight.
export const SUGGESTION_POOL = [
  { lens: "money", idx: 0, text: "construction contracts over $500k" },
  { lens: "money", idx: 1, text: "IT consulting RFPs" },
  { lens: "money", idx: 2, text: "shelter services contracts" },
  { lens: "money", idx: 3, text: "park maintenance contracts" },
  { lens: "money", idx: 4, text: "school food service contracts" },
  { lens: "money", idx: 5, text: "senior center contracts" },

  { lens: "land", idx: 0, text: "rezonings in Brooklyn" },
  { lens: "land", idx: 1, text: "rezonings in Queens" },
  { lens: "land", idx: 2, text: "79 Rivington" },
  { lens: "land", idx: 3, text: "rezonings in the Bronx" },

  { lens: "property", idx: 0, text: "HPD property sales" },
  { lens: "property", idx: 1, text: "environmental protection land" },
  { lens: "property", idx: 2, text: "police department property" },
  { lens: "property", idx: 3, text: "parks department property" },

  { lens: "rules", idx: 0, text: "buildings rules" },
  { lens: "rules", idx: 1, text: "sanitation rules" },
  { lens: "rules", idx: 2, text: "taxi rules" },
  { lens: "rules", idx: 3, text: "health department rules" },

  { lens: "meetings", idx: 0, text: "recent landmarks hearings" },
  { lens: "meetings", idx: 1, text: "recent city council hearings" },
  { lens: "meetings", idx: 2, text: "recent community board meetings" },
  { lens: "meetings", idx: 3, text: "recent taxi and limousine hearings" },

  { lens: "alerts", idx: 0, text: "awards over $1M" },
  { lens: "alerts", idx: 1, text: "education contracts over $200K due in 3 months" },
  { lens: "alerts", idx: 2, text: "rezonings near 79 Rivington" },
  { lens: "alerts", idx: 3, text: "sanitation contract awards" },
];

// The static client-side fallback (index.html's NL_SUGGESTIONS_FALLBACK) used only when the
// worker's /suggestions route is unreachable — kept deliberately smaller than the full pool and
// NEVER including a candidate known (or suspected) to go stale, so it needs no daily validation
// of its own. Its honesty is proven once, live, by worker/e2e/suggestions.mjs rather than
// re-checked every day. Keep index.html's copy of these exact idx lists in sync by hand if this
// changes — the two can't share an import across the static-site/worker boundary.
export const FALLBACK_INDICES = {
  money: [0, 3, 4, 5],       // excludes idx 1/2 — the field-evidence dead examples
  land: [0, 1, 2, 3],
  property: [0, 1, 2, 3],
  rules: [0, 1, 2, 3],
  meetings: [0, 1, 2, 3],
  alerts: [0, 1, 2, 3],
};

// "A handful of results" per the site owner's field report, made concrete: three real,
// current matches is enough to prove a suggestion isn't a dead end, without demanding so many
// that a genuinely narrow (but real) query gets excluded.
export const MIN_SUGGESTION_RESULTS = 3;

import { compileSub } from "./compile.mjs";

// {lens, filter} (the exact shape parseLensFilter()/nlResolve() produce for this candidate's
// text) -> a Socrata/ZAP { url, params } count query, or null when this lens/filter can't be
// counted (people; or a rezone alert naming no place). Reuses compileSub() — the same
// pure query-builder the digest cron already trusts to replay a saved subscription — so a
// suggestion's honesty is judged by the identical query shape a real click resolves to,
// not a bespoke second implementation that could quietly drift from it.
export function suggestionCountParams(lens, filter, todayISO) {
  const f = filter || {};
  // "alerts" has no compileSub() case of its own — it reuses money's schema for everything
  // except a rezone watch (watchType==="rezone"), which has a place instead of a dollar
  // amount/due date (see filter.mjs's LENSES.alerts comment).
  const sub =
    lens === "alerts"
      ? f.watchType === "rezone"
        ? { lens: "land", filter: { keywords: [f.place].filter(Boolean) } }
        : { lens: "money", filter: f }
      : { lens, filter: f };

  const compiled = compileSub(sub, todayISO);
  if (!compiled) return null;
  const params = { ...compiled.params, "$select": "count(1) as n" };
  delete params["$order"];
  delete params["$limit"];
  return { url: compiled.url, params };
}
