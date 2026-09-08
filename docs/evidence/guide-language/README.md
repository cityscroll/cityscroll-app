# Guide language verification

All 19 existing articles and the guide home use the product's 11 shipping
languages: English, Spanish, Simplified Chinese, Russian, Bengali, Haitian
Creole, Korean, French, Polish, Arabic and Urdu.

- `coverage.json` measures all 209 article-language pairs through the same strict
  renderer used to publish the guide. An English fallback or unchanged English
  paragraph is incomplete. Protected names, URLs, dates and catalog-bound labels
  are intentional content, not substitute paragraphs.
- `rendered.json` records the no-JavaScript phone and desktop reads for every
  document, plus contextual-help journeys in Spanish, Chinese and Arabic.
- `journeys.json` records a separate replay of the nine guide-return journeys.
- `accessibility.json` records the isolated accessibility shards and language-policy
  regression checks against the complete public build.
- Product illustrations and their per-article receipts live in `site/media/guide/`.
  The capture rule covers board selection, preview and save confirmation;
  calendar subscription, copy choices and meeting filters; and collection pinning, notes and
  exports; connection evidence; and date filtering in Spanish, Chinese and Arabic,
  at phone and desktop widths. Other
  figures identify their English interface explicitly, and their translated
  captions retain the UI labels that the image shows.

The ten locale drafts each contained 821 complete source segments, reconciled
into 800 distinct sentence templates after binding shared product terminology.
All drafts preserve required placeholders. Haitian Creole initially rejected
three passages about tax liens; those were drafted only after the glossary gained
an official Department of Finance source. No unresolved linguistic rejections
entered the dictionaries.

Terminology comes from `STRINGS` in `site/i18n.js` and `site/i18n/lang/`, with civic
terms pinned by `site/i18n/glossary.json`. Named controls use the same dictionary
values as the product. Official record titles, identifiers and source quotations
retain their original wording. Existing English product labels remain recognizable
where the corresponding product surface uses them.

The evidence is a local rendering and navigation rehearsal. Following uses an
empty disposable preview and intercepted successful subscription response; no
email is sent. It does not prove email delivery or external calendar refresh.
Translations retain the existing machine-drafted provenance and disclosure;
passing these checks does not constitute native editorial review or advance any
article review date.

Reproduce with the commands in `docs/public-guide.md`. Capture files stay ignored;
only route, viewport, revision, data-vintage, assertions and digests are published.
