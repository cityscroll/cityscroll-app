#!/usr/bin/env node
/** Import reviewed draft files into the existing product dictionaries.
 * --units <extracted JSON> --draft <locale JSON> [--write]
 * The default is validation only. No editorial metadata is changed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadGuideCatalog, reconcileGuideDraft, guideTranslator, guideUnitIsSourceOnly } from './guide_translation_catalog.mjs';
const flags = process.argv.slice(2);
const option = name => flags[flags.indexOf(name) + 1];
if (!flags.includes('--units') || !flags.includes('--draft')) throw new Error('--units and --draft are required');
const units = JSON.parse(readFileSync(option('--units')));
const draft = JSON.parse(readFileSync(option('--draft')));
const catalog = loadGuideCatalog();
const {locale} = draft;
if (!catalog.SHIPPING_LANGS.includes(locale)) throw new Error('Unsupported shipping locale');
if (draft.rejections?.length) throw new Error(`Unresolved draft rejections: ${draft.rejections.length}`);
const english = {}, translations = {};
const aliases = draft.terminology_gaps?.early_mappings || {};
for (const unit of units) {
  if (typeof draft.translations[unit.key] !== 'string') throw new Error(`Missing draft: ${unit.key}`);
  const row = reconcileGuideDraft(unit, draft.translations[unit.key], catalog, aliases, locale);
  if (guideUnitIsSourceOnly(row)) row.translated = row.template;
  catalog.STRINGS[locale][row.key] = row.translated;
  guideTranslator(catalog, locale)(unit.source);
  english[row.key] = row.template;
  translations[row.key] = row.translated;
}
if (flags.includes('--write')) {
  for (const [language, entries] of [['en', english], [locale, translations]]) {
    const path = language === 'en' ? 'site/i18n.js' : `site/i18n/lang/${language}.js`;
    const begin = '// BEGIN GUIDE TRANSLATIONS';
    const end = '// END GUIDE TRANSLATIONS';
    const block = `${begin}\n${Object.entries(entries).map(([key,value]) => `    ${key}: ${JSON.stringify(value)},`).join('\n')}\n    ${end}`;
    let source = readFileSync(path, 'utf8');
    // Remove the former append-only form if importing an intermediate draft.
    if (source.includes(begin) && source.slice(source.indexOf(begin), source.indexOf(end)).includes('Object.assign')) {
      source = source.slice(0, source.indexOf(begin)) + source.slice(source.indexOf(end) + end.length);
    }
    if (source.includes(begin)) source = source.slice(0, source.indexOf(begin)) + block + source.slice(source.indexOf(end) + end.length);
    else {
      const anchor = language === 'en' ? /const STRINGS = \{\s*en:\s*\{/ : /Object\.assign\(W\.STRINGS\[[^\]]+\],\s*\{/;
      if (!anchor.test(source)) throw new Error('Missing product dictionary insertion point');
      source = source.replace(anchor, match => match + '\n    ' + block + '\n');
    }
    writeFileSync(path, source.trimEnd() + '\n');
  }
}
console.log(`${locale}: ${units.length} draft segments, ${Object.keys(translations).length} catalog entries, 0 rejected; editorial dates unchanged`);
