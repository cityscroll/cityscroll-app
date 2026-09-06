/**
 * Ask / device entity phrasing → reviewed identity only.
 *
 * Reads AGENCY_GROUPS + resolveAgencyIdentity / canonicalAgency (the same
 * functions entity_resolution/normalizers/agency.mjs re-exports) and, when
 * supplied, the reviewed vendor alias registry. Informal phrases resolve only
 * when they uniquely derive from those reviewed surfaces.
 *
 * Unresolved input stays plain text. This adapter never mints an
 * `agency:id:…` from an unmatched slug — that is the per-request invention
 * the search-quality card forbids. Do not copy NL_AGENCY_ALIASES into the
 * identity graph; that list remains a classic-script fallback only.
 */

import {
  AGENCY_GROUPS,
  agencyComparisonKey,
  canonicalAgency,
  resolveAgencyIdentity,
} from "./agency_identity.mjs";

export const CANONICAL_ENTITY_INTERPRETATION = "cityscroll.canonical_entity_interpretation.v1";

const PHRASE_STOP = new Set([
  "AND", "CITY", "DEPT", "DEPARTMENT", "FOR", "NEW", "NYC", "OF", "OFFICE",
  "THE", "YORK",
]);

// Connectors carry no initial in a conventional acronym, while the leading
// noun always does. Stripping only these keeps "Office of Racial Equity" ->
// ORE and "Commission on Racial Equity" -> CORE, which PHRASE_STOP cannot do:
// it drops OFFICE (losing the distinguishing initial) and keeps ON (adding one).
const PHRASE_CONNECTORS = new Set(["AND", "AT", "FOR", "IN", "OF", "ON", "THE", "TO"]);

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function phraseKey(value) {
  return agencyComparisonKey(value).toLowerCase();
}

function tokensOf(value) {
  const key = agencyComparisonKey(value);
  return key ? key.split(" ") : [];
}

function unresolved(text) {
  return Object.freeze({
    schema: CANONICAL_ENTITY_INTERPRETATION,
    status: "unresolved",
    kind: null,
    text: clean(text),
    canonical_id: null,
    canonical_name: null,
    subject_ref: null,
    method: null,
    matched: false,
  });
}

function reviewedAgencyRecord(canonicalName) {
  const identity = resolveAgencyIdentity(canonicalName);
  if (!identity?.matched) return null;
  const er = canonicalAgency(canonicalName);
  if (!er?.canonical_id || er.canonical_id !== identity.canonical_id) return null;
  return Object.freeze({
    canonical_id: identity.canonical_id,
    canonical_name: identity.canonical_name || canonicalName,
  });
}

function addPhrase(map, phrase, record, method) {
  const key = phraseKey(phrase);
  if (!key || key.length < 2) return;
  const existing = map.get(key);
  if (existing && existing.canonical_id !== record.canonical_id) {
    map.set(key, Object.freeze({ ...existing, canonical_id: "", ambiguous: true }));
    return;
  }
  if (existing) return;
  map.set(key, Object.freeze({
    canonical_id: record.canonical_id,
    canonical_name: record.canonical_name,
    phrase: String(phrase),
    method,
    ambiguous: false,
  }));
}

function departmentRest(tokens) {
  const deptAt = tokens.findIndex((token) => token === "DEPARTMENT" || token === "DEPT");
  if (deptAt < 0) return null;
  let rest = tokens.slice(deptAt + 1);
  if (rest[0] === "OF" || rest[0] === "FOR") rest = rest.slice(1);
  return rest.length ? rest : null;
}

function derivePhrases(surface) {
  const raw = String(surface || "").trim();
  const tokens = tokensOf(raw);
  if (!tokens.length) return [];
  const phrases = [[raw, "reviewed_agency_group"]];
  const initialsAll = tokens.map((token) => token[0]).join("");
  if (initialsAll.length >= 3) phrases.push([initialsAll, "reviewed_agency_acronym"]);
  const significant = tokens.filter((token) => !PHRASE_STOP.has(token));
  const initialsSig = significant.map((token) => token[0]).join("");
  if (initialsSig.length >= 3) phrases.push([initialsSig, "reviewed_agency_acronym"]);
  const named = tokens.filter((token) => !PHRASE_CONNECTORS.has(token));
  const initialsNamed = named.map((token) => token[0]).join("");
  if (initialsNamed.length >= 3) phrases.push([initialsNamed, "reviewed_agency_acronym"]);

  const rest = departmentRest(tokens);
  if (rest) {
    phrases.push([`DEPARTMENT OF ${rest.join(" ")}`, "reviewed_agency_department_phrase"]);
    phrases.push([`${rest.join(" ")} DEPARTMENT`, "reviewed_agency_department_phrase"]);
    if (rest[0] && rest[0].length >= 4 && !PHRASE_STOP.has(rest[0])) {
      phrases.push([`DEPARTMENT OF ${rest[0]}`, "reviewed_agency_department_phrase"]);
      phrases.push([`${rest[0]} DEPARTMENT`, "reviewed_agency_department_phrase"]);
    }
  }

  const leading = raw.split(/\s+[-–—]\s+/)[0].trim();
  if (/^[A-Za-z]{3,8}$/.test(leading) && !PHRASE_STOP.has(leading.toUpperCase())) {
    phrases.push([leading, "reviewed_agency_acronym"]);
  }
  const uniformCaps = raw === raw.toUpperCase() && /[A-Z]/.test(raw);
  if (!uniformCaps) {
    for (const token of raw.split(/[^A-Za-z]+/)) {
      if (/^[A-Z]{3,8}$/.test(token) && !PHRASE_STOP.has(token)) {
        phrases.push([token, "reviewed_agency_acronym"]);
      }
    }
  }
  return phrases;
}

function buildAgencyPhraseIndex() {
  const map = new Map();
  for (const [canonicalName, variants] of Object.entries(AGENCY_GROUPS)) {
    const record = reviewedAgencyRecord(canonicalName);
    if (!record) continue;
    const surfaces = [canonicalName, ...(Array.isArray(variants) ? variants : [])];
    for (const surface of surfaces) {
      addPhrase(map, surface, record, "reviewed_agency_group");
      for (const [phrase, method] of derivePhrases(surface)) {
        addPhrase(map, phrase, record, method);
      }
    }
  }
  for (const [key, entry] of map) {
    if (entry.ambiguous || !entry.canonical_id) map.delete(key);
  }
  return map;
}

const AGENCY_PHRASES = buildAgencyPhraseIndex();

function buildAgencyAcronymIndex() {
  const byId = new Map();
  for (const entry of AGENCY_PHRASES.values()) {
    if (entry.method !== "reviewed_agency_acronym") continue;
    const list = byId.get(entry.canonical_id) || [];
    const phrase = String(entry.phrase || "").toUpperCase();
    if (phrase && !list.includes(phrase)) list.push(phrase);
    byId.set(entry.canonical_id, list);
  }
  for (const [id, list] of byId) byId.set(id, Object.freeze([...list].sort()));
  return byId;
}

const AGENCY_ACRONYMS_BY_ID = buildAgencyAcronymIndex();

/**
 * Reviewed acronyms that resolve to exactly one agency. An acronym two
 * reviewed groups both derive is dropped by the phrase index, so this list
 * never hands one body's shorthand to another.
 */
export function reviewedAgencyAcronyms(value) {
  const raw = clean(value);
  if (!raw) return [];
  const direct = AGENCY_ACRONYMS_BY_ID.get(raw);
  if (direct) return direct;
  const identity = resolveAgencyIdentity(raw);
  return AGENCY_ACRONYMS_BY_ID.get(identity?.canonical_id) || [];
}

function vendorAliasForms(registry) {
  const forms = [];
  for (const entry of registry?.entries || []) {
    if (entry.status && String(entry.status).toUpperCase() !== "ACCEPTED") continue;
    for (const side of [entry.left, entry.right]) {
      const name = clean(side?.display_name);
      if (name) forms.push(name);
    }
  }
  return forms;
}

function interpretReviewedVendorAlias(text, registry) {
  if (!registry || !Array.isArray(registry.entries)) return null;
  const key = phraseKey(text);
  if (!key) return null;
  const names = [...new Set(vendorAliasForms(registry).filter((name) => phraseKey(name) === key))];
  if (names.length !== 1) return null;
  return Object.freeze({
    schema: CANONICAL_ENTITY_INTERPRETATION,
    status: "resolved",
    kind: "vendor",
    text: clean(text),
    canonical_id: null,
    canonical_name: names[0],
    subject_ref: null,
    method: "reviewed_vendor_alias",
    matched: true,
  });
}

function hitToResult(text, hit) {
  const record = reviewedAgencyRecord(hit.canonical_name);
  if (!record) return unresolved(text);
  return Object.freeze({
    schema: CANONICAL_ENTITY_INTERPRETATION,
    status: "resolved",
    kind: "agency",
    text: clean(text),
    canonical_id: record.canonical_id,
    canonical_name: record.canonical_name,
    subject_ref: `agency:id:${record.canonical_id}`,
    method: hit.method,
    matched: true,
  });
}

function lookupAgencyPhrase(phrase) {
  const key = phraseKey(phrase);
  if (!key) return null;
  return AGENCY_PHRASES.get(key) || null;
}

/**
 * Interpret a standalone entity phrase. Unresolved stays text and never
 * carries a minted subject_ref.
 */
export function interpretEntityPhrase(text, options = {}) {
  const raw = clean(text);
  if (!raw) return unresolved(text);
  const agencyHit = lookupAgencyPhrase(raw);
  if (agencyHit) return hitToResult(raw, agencyHit);
  const vendorHit = interpretReviewedVendorAlias(raw, options.aliasRegistry);
  if (vendorHit) return vendorHit;
  return unresolved(raw);
}

function paddedPhraseHaystack(text) {
  return ` ${phraseKey(text)} `;
}

/**
 * Scan a sentence for a unique reviewed agency phrase. Longer phrases win.
 * Single common topic words are not scanned here — standalone interpret
 * still accepts exact reviewed names.
 */
export function extractReviewedAgencyFromText(text) {
  const raw = clean(text);
  if (!raw) return unresolved(text);
  const standalone = interpretEntityPhrase(raw);
  if (standalone.status === "resolved" && standalone.kind === "agency") return standalone;

  const haystack = paddedPhraseHaystack(raw);
  const matches = [];
  for (const [key, hit] of AGENCY_PHRASES) {
    const words = key.split(" ").filter(Boolean);
    const inTextAcronym = words.length === 1 && key.length >= 3 && key.length <= 6;
    const specific = words.length > 1 || inTextAcronym;
    if (!specific) continue;
    if (!haystack.includes(` ${key} `)) continue;
    matches.push({ key, hit, length: key.length });
  }
  matches.sort((a, b) => b.length - a.length);
  if (!matches.length) return unresolved(raw);
  const best = matches[0];
  const same = matches.filter((row) => row.hit.canonical_id !== best.hit.canonical_id);
  if (same.length) return unresolved(raw);
  return hitToResult(raw, best.hit);
}

export function installAgencyPhraseInterpreter(target = globalThis) {
  target.CrolInterpretAgencyPhrase = extractReviewedAgencyFromText;
  return extractReviewedAgencyFromText;
}

export function reviewedAgencyPhrase(phrase) {
  const hit = lookupAgencyPhrase(phrase);
  return hit ? { canonical_id: hit.canonical_id, canonical_name: hit.canonical_name, method: hit.method } : null;
}
