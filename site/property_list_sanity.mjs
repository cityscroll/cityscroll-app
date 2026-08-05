/**
 * Property list sanity detectors — chip-format + default-view temporal honesty.
 *
 * Two-deliverable law: format and time-sense regressions that green a11y/demo
 * screenshot gates can still miss must fail a pure unit check here.
 *
 * Pure: no DOM, no network.
 */

/** English month names used in fdt() long-form dates (en-US). */
export const ENGLISH_MONTHS = Object.freeze([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]);

/**
 * Currency symbol immediately before a month name on a close/date chip.
 * Catches the price-fact `$` prefix leaking into date templates
 * ("closes $September 16, 2013").
 */
export const CURRENCY_BEFORE_MONTH_RE = new RegExp(
  String.raw`\bclos(?:es?|ed)\s+\$\s*(?:${ENGLISH_MONTHS.join("|")})\b`,
  "i",
);

/**
 * Broader currency-before-month (any preceding word context).
 * Use when scanning free rendered text for the same class of leak.
 */
export const CURRENCY_SYMBOL_BEFORE_MONTH_RE = new RegExp(
  String.raw`\$\s*(?:${ENGLISH_MONTHS.join("|")})\b`,
  "i",
);

/** Future-implying verbs with date tails that must be past-tense when past-dated. */
export const TENSE_PARITY_VERB_DATE_RE = new RegExp(
  String.raw`\b(?:auction\s+)?(?<verb>closes?|opens?|ends?)\s+(?<date>(?:(?:${ENGLISH_MONTHS.join("|")})\s+\d{1,2},\s*\d{4}|\d{4}-\d{2}-\d{2}))`,
  "i",
);

const MONTH_TO_NUM = Object.fromEntries(
  ENGLISH_MONTHS.map((name, index) => [name.toLowerCase(), String(index + 1).padStart(2, "0")]),
);

function normalizeTextDateToDay(rawDate) {
  const exact = String(rawDate || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (exact) return `${exact[1]}-${exact[2]}-${exact[3]}`;
  const longDate = String(rawDate || "").trim().match(
    new RegExp(String.raw`^(${ENGLISH_MONTHS.join("|")})\s+(\d{1,2}),\s*(\d{4})$`, "i"),
  );
  if (!longDate) return null;
  const month = MONTH_TO_NUM[longDate[1].toLowerCase()];
  if (!month) return null;
  return `${longDate[3]}-${month}-${String(longDate[2]).padStart(2, "0")}`;
}

/**
 * Lint rendered chip / card text for currency-symbol-before-month date chips.
 *
 * @param {string|string[]|{text?: string, label?: string}[]} input
 * @returns {{ ok: boolean, findings: Array<{ text: string, match: string, source?: string }> }}
 */
export function findCurrencyLeakedDateChips(input) {
  const items = normalizeTextItems(input);
  const findings = [];
  for (const item of items) {
    const text = item.text;
    if (!text) continue;
    // Prefer the close-chip-specific pattern; fall back to $Month when the
    // surrounding token is close/closed-shaped.
    const closeHit = text.match(CURRENCY_BEFORE_MONTH_RE);
    if (closeHit) {
      findings.push({ text, match: closeHit[0], source: item.source });
      continue;
    }
    if (/\bclos(?:es?|ed)\b/i.test(text) && CURRENCY_SYMBOL_BEFORE_MONTH_RE.test(text)) {
      const m = text.match(CURRENCY_SYMBOL_BEFORE_MONTH_RE);
      findings.push({ text, match: m ? m[0] : "$Month", source: item.source });
    }
  }
  return { ok: findings.length === 0, findings };
}

/**
 * Static i18n catalog check: date-bearing close keys must not use the
 * price-fact `${placeholder}` dollar-prefix form.
 *
 * @param {Record<string, string>|null|undefined} strings — e.g. STRINGS.en
 * @param {string[]} [keys]
 * @returns {{ ok: boolean, findings: Array<{ key: string, value: string }> }}
 */
export function findCurrencyLeakedDateI18n(
  strings,
  keys = ["property_commercial_close", "property_commercial_closed"],
) {
  const findings = [];
  const dict = strings && typeof strings === "object" ? strings : {};
  for (const key of keys) {
    const value = dict[key];
    if (value == null) continue;
    // `${date}` leaves a stray $ after {date} placeholder substitution.
    if (/\$\{date\}/.test(String(value)) || /\$\s*\{date\}/.test(String(value))) {
      findings.push({ key, value: String(value) });
    }
  }
  return { ok: findings.length === 0, findings };
}

/**
 * Lint rendered text for active voice ("closes/opens/ends") with past dates.
 *
 * @param {string|string[]|{text?: string, label?: string}[]} input
 * @param {{today?: string}} [opts]
 * @returns {{
 *   ok: boolean,
 *   findings: Array<{ source?: string, text: string, match: string, verb: string, date: string }>,
 * }}
 */
export function findTenseParityViolations(input, opts = {}) {
  const items = normalizeTextItems(input);
  const today = String(opts.today || "").slice(0, 10) || null;
  const findings = [];

  if (!today) return { ok: true, findings };

  for (const item of items) {
    const text = item.text;
    if (!text) continue;
    const pattern = new RegExp(TENSE_PARITY_VERB_DATE_RE.source, "ig");
    for (const match of text.matchAll(pattern)) {
      const verb = String(match?.groups?.verb || "").toLowerCase();
      if (!verb) continue;
      const date = normalizeTextDateToDay(match?.groups?.date || "");
      if (!date || date >= today) continue;
      findings.push({
        source: item.source,
        text,
        match: match[0],
        verb,
        date,
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

/**
 * Lint repeated identical actions/CTAs in one section when the same label+href
 * appears more than maxRepeats times.
 *
 * @param {Array<{section?: string, buttons?: Array<{label?: string, href?: string, source?: string}>}>} input
 * @param {{maxRepeats?: number}} [opts]
 * @returns {{ ok: boolean, findings: Array<{ section: string, label: string, href: string, count: number, sources: string[] }> }}
 */
export function findRepeatedIdenticalButtonActions(input, opts = {}) {
  const maxRepeats = Number.isFinite(Number(opts.maxRepeats)) ? Number(opts.maxRepeats) : 3;
  const buckets = new Map();

  for (const card of Array.isArray(input) ? input : []) {
    if (!card || typeof card !== "object") continue;
    const section = String(card.section || card.surface || "default").trim() || "default";
    const buttons = Array.isArray(card.buttons) ? card.buttons : [card];

    for (const button of buttons) {
      if (!button || typeof button !== "object") continue;
      const label = String(button.label || button.text || "").trim();
      const href = String(button.href || button.url || "").trim();
      if (!label || !href) continue;
      const key = `${section}||${label}||${href}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          section,
          label,
          href,
          count: 0,
          sources: [],
        });
      }
      const bucket = buckets.get(key);
      bucket.count += 1;
      if (button.source) bucket.sources.push(button.source);
    }
  }

  const findings = [];
  for (const bucket of buckets.values()) {
    if (bucket.count > maxRepeats) findings.push(bucket);
  }
  return { ok: findings.length === 0, findings };
}

/**
 * Default-view temporal sanity: the open (pre-archive) head of a default lens
 * list must not lead with past-dated deadlines/closes.
 *
 * @param {Array<{
 *   close_date?: string|null,
 *   temporal_status?: string|null,
 *   section?: string|null,
 *   id?: string|null,
 *   request_id?: string|null,
 * }>} cards — ordered as the default view would render them
 * @param {{
 *   today?: string,
 *   topN?: number,
 *   archiveSection?: string,
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   open_head: Array<object>,
 *   findings: Array<{ index: number, close_date: string, id?: string|null, reason: string }>,
 * }}
 */
export function findPastDeadlinesInDefaultView(cards, opts = {}) {
  const today = opts.today ? String(opts.today).slice(0, 10) : null;
  const topN = Number.isFinite(opts.topN) ? Math.max(1, Number(opts.topN)) : 10;
  const archiveSection = opts.archiveSection || "closed";
  const list = Array.isArray(cards) ? cards : [];

  const openHead = [];
  for (const card of list) {
    if (!card || typeof card !== "object") continue;
    const section = String(card.section || card.list_section || "").toLowerCase();
    if (section === archiveSection || section === "archive" || section === "closed") break;
    if (card.temporal_status === "closed") break;
    openHead.push(card);
    if (openHead.length >= topN) break;
  }

  const findings = [];
  openHead.forEach((card, index) => {
    const day = card.close_date ? String(card.close_date).slice(0, 10) : null;
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    if (!today) return;
    if (day < today) {
      findings.push({
        index,
        close_date: day,
        id: card.id || card.request_id || null,
        reason: "past_close_in_default_open_head",
      });
    }
  });

  return { ok: findings.length === 0, open_head: openHead, findings };
}

/**
 * Build ordered default-view cards from stamped explorer entries (for detectors).
 * Open cards first; closed cards tagged with section "closed".
 *
 * @param {object[]} entries — stampPropertyExplorerTemporal output preferred
 * @returns {Array<{ close_date: string|null, temporal_status: string, section: string|null, request_id: string|null }>}
 */
export function defaultViewCardsFromEntries(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const closed = entry?.temporal_status === "closed";
    return {
      close_date: entry?.close_date || null,
      temporal_status: entry?.temporal_status || (closed ? "closed" : "open"),
      section: closed ? "closed" : null,
      request_id: entry?.primary?.request_id || entry?.request_id || null,
      action_key: entry?.action_key || null,
    };
  });
}

function normalizeTextItems(input) {
  if (input == null) return [];
  if (typeof input === "string") return [{ text: input, source: null }];
  if (!Array.isArray(input)) return [{ text: String(input), source: null }];
  return input.map((item, i) => {
    if (typeof item === "string") return { text: item, source: `item:${i}` };
    if (item && typeof item === "object") {
      return {
        text: String(item.text || item.label || item.chip || ""),
        source: item.source || item.id || `item:${i}`,
      };
    }
    return { text: String(item ?? ""), source: `item:${i}` };
  });
}
