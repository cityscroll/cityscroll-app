// Translation invariant extraction + verification for informal notice translation.
//
// The official City Record text is always the record. An unofficial translation may be
// shown only when every load-bearing token from the source also appears verbatim in the
// translation: dollar amounts, dates, PINs, Request IDs, multi-digit numbers, agency
// names, and addresses. A single missing token → invariants fail → no translation shown.
//
// Pure functions — no I/O. Field cases live in worker/test/translate_invariants.test.mjs.

/** Dollar amounts as they appear in source text ($1,250,000 / $17 / $12.99). */
const MONEY_RE = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\$\s?\d+(?:\.\d{1,2})?/g;

/** ISO dates and common US numeric dates. */
const ISO_DATE_RE = /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g;
const US_DATE_RE = /\b\d{1,2}\/\d{1,2}\/(?:19|20)\d{2}\b/g;

/** Written month + day + optional year (English source notices). */
const WRITTEN_DATE_RE =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?(?:\s+(?:19|20)\d{2})?\b/g;

/** Standalone multi-digit numbers (4+ digits, or comma-grouped), excluding pure years already covered. */
const NUMBER_RE = /\b\d{1,3}(?:,\d{3})+\b|\b\d{4,}\b/g;

/** NYC-ish street address fragments commonly embedded in titles/descriptions. */
const ADDRESS_RE =
  /\b\d{1,5}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(?:Street|St\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Road|Rd\.?|Place|Pl\.?|Drive|Dr\.?|Lane|Ln\.?|Court|Ct\.?|Way|Highway|Hwy\.?|Parkway|Pkwy\.?|Broadway)\b/gi;

function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item) continue;
    const key = String(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function pushMatches(out, text, re) {
  if (!text) return;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[0].replace(/\s+/g, " ").trim());
  }
}

/**
 * Collect invariant tokens that must survive translation verbatim.
 *
 * @param {string} sourceText - concatenated English notice text (title + description + …)
 * @param {object} [meta]
 * @param {string} [meta.request_id]
 * @param {string} [meta.pin]
 * @param {string|number} [meta.contract_amount]
 * @param {string} [meta.agency_name]
 * @param {string} [meta.address]
 * @param {string} [meta.due_date]
 * @param {string} [meta.start_date]
 * @returns {{ money: string[], dates: string[], pins: string[], requestIds: string[], numbers: string[], agencies: string[], addresses: string[], all: string[] }}
 */
export function extractInvariants(sourceText, meta = {}) {
  const text = String(sourceText || "");
  const money = [];
  const dates = [];
  const pins = [];
  const requestIds = [];
  const numbers = [];
  const agencies = [];
  const addresses = [];

  pushMatches(money, text, MONEY_RE);
  pushMatches(dates, text, ISO_DATE_RE);
  pushMatches(dates, text, US_DATE_RE);
  pushMatches(dates, text, WRITTEN_DATE_RE);
  pushMatches(numbers, text, NUMBER_RE);
  pushMatches(addresses, text, ADDRESS_RE);

  if (meta.request_id) requestIds.push(String(meta.request_id).trim());
  if (meta.pin) {
    const pin = String(meta.pin).trim();
    if (pin && pin.length >= 4) pins.push(pin);
  }
  if (meta.agency_name) {
    const agency = String(meta.agency_name).trim();
    if (agency) agencies.push(agency);
  }
  if (meta.address) {
    const addr = String(meta.address).trim();
    if (addr) addresses.push(addr);
  }
  if (meta.due_date) {
    const d = String(meta.due_date).trim();
    // Prefer the date portion of an ISO datetime.
    const day = d.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) dates.push(day);
    else if (d) dates.push(d);
  }
  if (meta.start_date) {
    const d = String(meta.start_date).trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.push(d);
  }
  if (meta.contract_amount != null && meta.contract_amount !== "") {
    const raw = String(meta.contract_amount).trim();
    // Keep both the raw form and a $ form when the text uses currency notation.
    if (raw) numbers.push(raw.replace(/[$,]/g, "").replace(/\.00$/, "") || raw);
  }

  // Numbers that are already represented as money tokens should not force a second form.
  const moneyDigits = new Set(
    money.map((m) => m.replace(/[$,\s]/g, "")),
  );
  const filteredNumbers = numbers.filter((n) => {
    const digits = String(n).replace(/[$,\s]/g, "");
    if (moneyDigits.has(digits)) return false;
    // Pure years that already appear in a date token can stay via the date check.
    if (/^(?:19|20)\d{2}$/.test(digits) && dates.some((d) => d.includes(digits))) return false;
    return true;
  });

  const all = uniq([
    ...money,
    ...dates,
    ...pins,
    ...requestIds,
    ...filteredNumbers,
    ...agencies,
    ...addresses,
  ]);

  return {
    money: uniq(money),
    dates: uniq(dates),
    pins: uniq(pins),
    requestIds: uniq(requestIds),
    numbers: uniq(filteredNumbers),
    agencies: uniq(agencies),
    addresses: uniq(addresses),
    all,
  };
}

/**
 * Verify every invariant token appears verbatim in the translation.
 * Mismatch → ok:false (caller must not display or cache the translation).
 *
 * @param {string} sourceText
 * @param {string} translationText
 * @param {object} [meta]
 * @returns {{ ok: boolean, missing: string[], invariants: ReturnType<typeof extractInvariants> }}
 */
export function checkInvariants(sourceText, translationText, meta = {}) {
  const invariants = extractInvariants(sourceText, meta);
  const hay = String(translationText || "");
  const missing = [];
  for (const token of invariants.all) {
    if (!hay.includes(token)) missing.push(token);
  }
  return { ok: missing.length === 0, missing, invariants };
}

/**
 * Build the English source blob used for hashing + invariant extraction from a notice row.
 * Accepts either D1 column names or SODA field names.
 */
export function noticeSourceText(row = {}) {
  const parts = [
    row.short_title,
    row.description || row.additional_description_1,
    row.other_info || row.other_info_1,
    row.printout || row.printout_1,
  ];
  return parts.filter(Boolean).map((p) => String(p)).join("\n\n");
}

/**
 * Structured meta pulled off a notice row for invariant + prompt pinning.
 */
export function noticeMeta(row = {}) {
  return {
    request_id: row.request_id || null,
    pin: row.pin || null,
    contract_amount: row.contract_amount != null ? row.contract_amount : null,
    agency_name: row.agency_name || row.agency || null,
    address: row.address_to_request || row.event_addr1 || null,
    due_date: row.due_date || null,
    start_date: row.start_date || null,
  };
}
