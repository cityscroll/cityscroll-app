// Agency-identity join — the enrichment layer on top of the site's agency-name crosswalk.
//
// The site already reconciles the City Record's free-text agency spellings to one canonical
// identity per agency: lib/agencies.mjs's canonicalAgency() maps any raw agency_name (legacy
// UPPERCASE "DEPT OF PARKS & RECREATION" or modern "Parks and Recreation") to a stable
// { canonical_id, canonical_name }. This module does NOT re-resolve raw strings — it consumes
// that same canonical table so a notice's agency resolves to exactly the identity the rest of
// the site uses, then attaches the agency's identity card (website, principal officer, budget)
// keyed by canonical_id.
//
// enrichAgency() does an O(1) lookup in the precompiled crosswalk (worker/src/data/
// agency_crosswalk.json, built by tools/build_agency_crosswalk.mjs and keyed by canonical_id).
// The matching of a canonical agency to the NYC/NYS Open Data roster + budget happens once, at
// preprocess time; a canonical_id with no identity data returns null so the caller degrades
// gracefully.
//
// normalizeAgencyKey/aliasTargetFor below are used ONLY at build time, to match a canonical
// agency name (and its raw variants) to the roster/budget datasets — never on the request path.

import { canonicalAgency } from "./agencies.mjs";

// City Record abbreviation → full word. Applied token-by-token after punctuation is spaced out,
// so "DEPT OF ENVIRONMENT PROTECTION" and "Environmental Protection" land on the same key.
const ABBR = {
  DEPT: "DEPARTMENT", DEPTS: "DEPARTMENT",
  SVC: "SERVICES", SVCS: "SERVICES", SVS: "SERVICES", SRVS: "SERVICES", SERVICE: "SERVICES", SERV: "SERVICES",
  MAYORS: "MAYOR",
  ADMIN: "ADMINISTRATION", ADMINISTRATIVE: "ADMINISTRATION",
  DVLPMNT: "DEVELOPMENT", DVLPMT: "DEVELOPMENT", DEV: "DEVELOPMENT",
  COMM: "COMMISSION", COMMISSN: "COMMISSION",
  MGMT: "MANAGEMENT",
  INFO: "INFORMATION",
  TECH: "TECHNOLOGY",
  ENVIRONMENT: "ENVIRONMENTAL",
  PRESERVATN: "PRESERVATION", PRESERV: "PRESERVATION",
  CHILDRENS: "CHILDREN", CHILDREN: "CHILDREN",
  EMPLOY: "EMPLOYMENT",
  QNS: "QUEENS", BKLYN: "BROOKLYN",
  ISL: "ISLAND",
  RECREATN: "RECREATION",
  PROB: "PROBATION",
  CORR: "CORRECTION",
  BD: "BOARD",
  OFF: "OFFICE",
  CTY: "CITY",
  RETIREMNT: "RETIREMENT", SYS: "SYSTEM",
  ELECTION: "ELECTIONS", // City Record uses the singular; the roster's agency is "Board of Elections"
};

// Filler tokens dropped from the key entirely. "New York City" / "NYC" / "City of New York" are
// stripped because the roster prefixes canonical names inconsistently; "DEPARTMENT" and "OFFICE"
// so "Department of Sanitation" and "Sanitation" agree; "COUNTY" so a District Attorney named by
// county lines up with one named by borough. "MAYOR" is deliberately NOT a stop word — dropping it
// once collapsed "Office of the Mayor" to an empty key.
const STOP = new Set([
  "OF", "THE", "AND", "FOR", "ON", "NEW", "YORK", "NYC", "CITY", "DEPARTMENT", "OFFICE", "COUNTY",
]);

// Normalize any agency surface (a City Record string, a canonical name, an acronym) to its key.
// Returns "" for empty/garbage input so callers can treat falsy as "no key".
export function normalizeAgencyKey(input) {
  let s = String(input == null ? "" : input).toUpperCase();
  s = s.replace(/[.,'’`/&()\-–—:;#]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const out = [];
  for (let tok of s.split(" ")) {
    if (!tok) continue;
    if (ABBR[tok]) tok = ABBR[tok];
    if (STOP.has(tok)) continue;
    if (tok.length <= 1) continue; // drop the stray "S" a possessive ("Attorney's") splits into
    out.push(tok);
  }
  return out.sort().join(" ");
}

// Hand-verified bridges for City Record strings the normalizer cannot reach on its own. Keys are
// written as readable, real City Record agency strings and normalized on load (so an entry stays
// correct if the normalizer changes); values are canonical surfaces the roster/budget answer to.
// Kept small and auditable; every entry maps a real, high-volume City Record string.
export const ALIASES = {
  // Board of Elections publishes an enormous run of poll-worker personnel notices under this name.
  "Board of Election Poll Workers": "Board of Elections",
  // Department of Education's admin notices; the roster carries no DOE identity card, so this
  // resolves to the Expense Budget line (budget-only) — an honest partial join.
  "Department of Education Admin": "Department of Education",
  // Human Resources Administration / Department of Social Services twin naming.
  "HRA/Dept of Social Services": "Human Resources Administration",
  "Dept. of Social Svcs/Human Resources Administration": "Human Resources Administration",
  // Information Technology & Telecommunications was folded into the Office of Technology & Innovation.
  "Dept of Info Tech & Telecomm": "Office of Technology and Innovation",
  "Information Technology and Telecommunications": "Office of Technology and Innovation",
  // District Attorney offices named by county in the City Record vs. by borough in the roster.
  "District Attorney - New York County": "Manhattan District Attorney's Office",
  "District Attorney-Special Narc": "Manhattan District Attorney's Office",
  "District Attorney Richmond Cou": "Staten Island District Attorney's Office",
  // Youth and Community Development's legacy string abbreviates "Community" as "Comm" — which
  // the normalizer would otherwise read as "Commission". Pin it to the right agency.
  "Dept of Youth & Comm Dev Srvs": "Department of Youth and Community Development",
  // Office of Management and Budget: the roster carries it under its "Mayor's Office of" name.
  "Office of Management and Budget": "Mayor's Office of Management and Budget",
  "Management and Budget": "Mayor's Office of Management and Budget",
  // Small Business Services' former name in the City Record.
  "Department of Business Services": "Department of Small Business Services",
  // CUNY community colleges are units of the City University of New York.
  "Community College": "City University of New York",
  "CUNY Central Office": "City University of New York",
  "Hunter College High School": "City University of New York",
  "Guttman Community College": "City University of New York",
};

// Precompiled: normalized-alias-key → canonical target. Built once at module load.
const ALIAS_BY_KEY = new Map();
for (const [raw, target] of Object.entries(ALIASES)) {
  const k = normalizeAgencyKey(raw);
  if (k && !ALIAS_BY_KEY.has(k)) ALIAS_BY_KEY.set(k, target);
}

// Some City Record strings share a normalized stem with a canonical unit but add a distinguishing
// suffix ("... Poll Workers"). Alias matching also tries dropping trailing descriptor tokens so
// those still resolve without a bespoke entry each.
export function aliasTargetFor(key) {
  if (!key) return null;
  if (ALIAS_BY_KEY.has(key)) return ALIAS_BY_KEY.get(key);
  // Community-college boroughs: "Community College Manhattan" etc. all map to CUNY.
  if (/\bCOLLEGE\b/.test(key) && ALIAS_BY_KEY.has(normalizeAgencyKey("Community College"))) {
    return ALIAS_BY_KEY.get(normalizeAgencyKey("Community College"));
  }
  return null;
}

// Look up an agency string's identity card. Routes the raw string through the site's own
// canonicalAgency() (lib/agencies.mjs) so it resolves to the SAME canonical identity the rest of
// the site uses, then reads the enrichment keyed by that canonical_id. `crosswalk` is the parsed
// bundle's `entries` object. Returns the identity card (with match_method) or null when the
// canonical agency has no identity data.
export function enrichAgency(crosswalk, agencyString) {
  if (!crosswalk) return null;
  const { canonical_id } = canonicalAgency(agencyString);
  if (!canonical_id) return null;
  return crosswalk[canonical_id] || null;
}
