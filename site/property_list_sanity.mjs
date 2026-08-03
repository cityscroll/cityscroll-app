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
