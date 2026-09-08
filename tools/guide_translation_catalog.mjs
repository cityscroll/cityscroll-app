/** Build-time adapter for the product's existing i18n catalogs. No network reads. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const SITE = new URL('../site/', import.meta.url);
export function loadGuideCatalog() {
  const context = { window: {} };
  runInNewContext(readFileSync(new URL('i18n.js', SITE), 'utf8'), context);
  for (const locale of context.window.SHIPPING_LANGS) {
    runInNewContext(readFileSync(new URL(`i18n/lang/${locale}.js`, SITE), 'utf8'), context);
  }
  return context.window;
}

const letters = n => n < 26 ? String.fromCharCode(97 + n) : letters(Math.floor(n / 26) - 1) + letters(n % 26);
const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

const terminologyMaps = new WeakMap();

/** Preserve exact UI labels and destinations while translating a complete sentence. */
export function guideTranslationUnit(source, catalog) {
  const bindings = {};
  const bind = (kind, value, key = null) => {
    const name = `${kind}_${letters(Object.keys(bindings).length)}`;
    bindings[name] = { value, key };
    return `{${name}}`;
  };
  let ui = terminologyMaps.get(catalog.STRINGS.en);
  if (!ui) {
    ui = new Map();
  for (const [key, value] of Object.entries(catalog.STRINGS.en)) {
    if (!key.startsWith('guide_text_') && typeof value === 'string' && !/^(?:CityScroll|Manhattan|Brooklyn|Queens|Bronx|Staten Island|CSV|JSON|PDF|ICS|PIN|BBL)$/.test(value) && !ui.has(value)) ui.set(value, key);
  }
    // Earlier guide copy names this control in lowercase and by its accessible name.
    ui.set('details', 'connection_details_control');
    ui.set('View connection details', 'connection_details_control');
    terminologyMaps.set(catalog.STRINGS.en, ui);
  }
  const raw = String(source);
  let template = raw.replace(/\]\(([^)\s]+)\)/g, (_, url) => `](${bind('link', url)})`);
  template = template.replace(/\*\*([^*]+)\*\*/g, (whole, label) => ui.has(label)
    ? `**${bind('control', label, ui.get(label))}**` : whole);
  template = template.replace(/\[([^\]]+)\]\(/g, (whole, label) => ui.has(label)
    ? `[${bind('control', label, ui.get(label))}](` : whole);
  if (ui.has(template)) template = bind('control', template, ui.get(template));
  const taught = /^(?:following_(?:choose_topic|refine|board_number|preview_matches|update_matches|watch_summary|watch_criteria|current_matches|email_frequency|create_heading|create_button|subscribed)|calendar_(?:subscribe_control|open_subscription|copy_url|subscribe_how)|connection_(?:evidence_heading|copy_link|details_control|how_heading|published_match|record_match|person_accepted)|connected_records_heading|as_of_(?:day|date|apply|later)_control|inv_export_csv|inv_export_json)$/;
  for (const [label, key] of [...ui.entries()].filter(([label, key]) => taught.test(key) && (key !== 'connection_details_control' || label === 'Details') && key !== 'as_of_later_control' && (!/^as_of_(?:date|apply)_control$/.test(key) || /^\d+\./.test(raw))).sort((a,b) => b[0].length - a[0].length)) {
    const pattern = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    template = template.replace(new RegExp(`(?<![A-Za-z])${pattern}(?![A-Za-z])`, 'g'), () => bind('control', label, key));
  }
  template = template.replace(/\b(?:Department of Youth & Community Development|DSNY|Zoning Application Portal, Department of City Planning|The City Record|BBL|CityScroll|Manhattan|Brooklyn|Queens|Bronx|Staten Island|JavaScript|CSV|JSON|PDF|ICS|PIN|ULURP|CPC|DCAS|NYCHA|DHS|HPD|RFP)\b/g, value => bind('name', value));
  template = template.replace(/\b\d{4}-\d{2}-\d{2}\b/g, value => bind('date', value));
  return { key: `guide_text_${sha(template)}`, source: raw, template, bindings };
}

export function guideTranslator(catalog, locale = 'en', units = new Map(), uiLocale = locale) {
  if (!['en', ...catalog.SHIPPING_LANGS].includes(locale)) throw new Error(`Unsupported guide locale: ${locale}`);
  const dictionary = catalog.STRINGS[locale];
  const translate = source => {
    if (!String(source).trim() || /^[\d\s.,·—:;-]+$/.test(source)) return source;
    const unit = guideTranslationUnit(source, catalog);
    units.set(unit.key, unit);
    const sourceOnly = !unit.template.replace(/\{[a-z_]+\}/g, '').replace(/[\s*()[\].,·—:;-]/g, '');
    const value = locale === 'en' || sourceOnly ? unit.template : dictionary[unit.key];
    if (typeof value !== 'string' || !value.trim() || (!sourceOnly && locale !== 'en' && value === unit.template)) {
      throw new Error(`Incomplete guide translation: ${locale}/${unit.key}`);
    }
    const tokens = text => [...text.matchAll(/\{[a-z_]+\}/g)].map(m => m[0]).sort().join('|');
    if (tokens(value) !== tokens(unit.template)) throw new Error(`Guide translation changed placeholders: ${locale}/${unit.key}`);
    return value.replace(/\{([a-z_]+)\}/g, (whole, name) => {
      const binding = unit.bindings[name];
      if (!binding) return whole;
      if (!binding.key) return binding.value;
      const label = catalog.STRINGS[uiLocale]?.[binding.key];
      if (typeof label !== 'string') throw new Error(`Missing UI terminology: ${locale}/${binding.key}`);
      return label;
    });
  };
  translate.withUILocale = value => guideTranslator(catalog, locale, units, value);
  translate.units = units;
  return translate;
}

/** Names protected from translation are explicit English islands in body prose. */
export function markGuideSourceLanguage(html, units) {
  const names = [...new Set([...units.values()].flatMap(unit => [
    ...Object.entries(unit.bindings).filter(([name]) => name.startsWith('name_')).map(([, binding]) => binding.value),
    // An unchanged emphasized source title or quoted control is an English island.
    // Only exact source wording qualifies; translated emphasis remains in the page language.
    ...[...unit.source.matchAll(/\*\*([^*]+)\*\*/g)].map(match => match[1]).filter(value => /[A-Za-z]/.test(value)),
  ]))].sort((a, b) => b.length - a.length);
  if (!names.length) return html;
  const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b(?:${names.map(escaped).join('|')})\\b`, 'g');
  const split = html.indexOf('</head>') + 7;
  const body = html.slice(split).replace(/>([^<]+)</g, (_, text) => `>${text.replace(pattern, name => `<bdi lang="en" dir="ltr">${name}</bdi>`)}<`)
    .replaceAll('<code>', '<code lang="en" dir="ltr">');
  return html.slice(0, split) + body;
}

/** Migrate a draft after additional UI labels acquire authoritative catalog keys. */
export function reconcileGuideDraft(oldUnit, value, catalog, aliases = {}, locale = "en") {
  const preserved = {};
  let expanded = value.replace(/\{([a-z_]+)\}/g, (whole, name) => {
    if (!oldUnit.bindings[name]) return whole;
    if (name.startsWith("link_")) return oldUnit.bindings[name].value;
    const token = `preserved_${letters(Object.keys(preserved).length)}`;
    preserved[token] = oldUnit.bindings[name];
    return `{${token}}`;
  });
  const target = guideTranslationUnit(oldUnit.source, catalog);
  const boundLabels = new Set(Object.values(target.bindings).filter(binding => binding.key).map(binding => binding.value));
  for (const [english, translated] of Object.entries(aliases).sort((a, b) => b[1].length - a[1].length)) {
    if (boundLabels.has(english) && typeof translated === 'string' && translated && translated !== english) expanded = expanded.replaceAll(translated, english);
  }
  for (const binding of Object.values(target.bindings).filter(binding => binding.key)) {
    const translated = catalog.STRINGS[locale]?.[binding.key];
    if (!translated || translated === binding.value) continue;
    expanded = expanded.replaceAll(`**${translated}**`, `**${binding.value}**`).replaceAll(`[${translated}](`, `[${binding.value}](`);
    if (expanded === translated) expanded = binding.value;
    // Named controls in captions are plain text too. Only labels bound by the source are eligible.
    if (translated.length > 1) expanded = expanded.replaceAll(translated, binding.value);
  }
  const draft = guideTranslationUnit(expanded, catalog);
  const used = new Set();
  const translated = draft.template.replace(/\{([a-z_]+)\}/g, (whole, name) => {
    const binding = preserved[name] || draft.bindings[name];
    if (!binding) return whole;
    const match = Object.entries(target.bindings).find(([key, candidate]) => (candidate.value === binding.value || (binding.key && candidate.key === binding.key)) && !used.has(key));
    if (!match) return binding.value;
    used.add(match[0]);
    return `{${match[0]}}`;
  });
  return { ...target, translated };
}

/** A source-language-only unit is intentional content, never a translation fallback. */
export function guideUnitIsSourceOnly(unit) {
  return !unit.template.replace(/\{[a-z_]+\}/g, '').replace(/[\s*()[\].,·—:;-]/g, '');
}
