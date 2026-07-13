# Civic-terms glossary

Human-readable companion to `glossary.json` (the machine-readable source `test/standards/
i18n_glossary.py` checks against). Pins the hard civic terms **before** bulk translation drafting
so a term is consistent everywhere it appears, instead of re-decided per string — see backlog
card w8-02.

**Rule:** where the City already publishes the term in a designated language (a MOIA translated
material, an agency Language Access Plan), the City's own term wins over a more "literally
correct" alternative — consistency with what an LEP reader sees on official paper beats literal
correctness. Where no official City translation exists, `glossary.json` records the judgment call
and the reasoning, so a later reviewer can revisit it with actual sourcing.

| Term | en | es | zh-Hans | ru |
|---|---|---|---|---|
| RFP | Request for Proposals (RFP) | Solicitud de Propuestas (RFP) | 征求建议书 (RFP) | Запрос предложений (RFP) |
| Award | award | adjudicación | 中标（授予合同） | присуждение контракта |
| Procurement | Procurement | Adquisiciones | 采购 | Закупки |
| Rezoning | rezoning | rezonificación | 重新分区 | изменение зонирования |
| City Record (chrome) | The City Record | Registro Municipal | 市政公报 | Городской вестник |
| PIN | PIN | PIN | PIN | PIN |
| Community Board | Community Board | Junta Comunitaria | 社区委员会 | Общественный совет |
| Upset price | upset price | precio mínimo | 保留价 | минимальная цена |
| Borough/place names | Brooklyn, Gowanus, 79 Rivington, … | unchanged (English) | unchanged (English) | unchanged (English) |
| Mandatory Inclusionary Housing | Mandatory Inclusionary Housing | Vivienda Inclusiva Obligatoria (MIH) | 强制性包容性住房 (MIH) | Обязательное инклюзивное жильё (MIH) |

See `glossary.json` for per-term sourcing and notes (why a term was chosen, and which strings it
governs). `test/standards/i18n_glossary.py` enforces: (1) every `{placeholder}` and inline HTML
tag in an `en` string survives byte-for-byte in every shipping language's translation, and (2) a
sample grep-consistency check that each glossary term's pinned translation actually appears in
that language's dictionary.

## Review ledger

Per-language review state lives in each dictionary file's header comment (`i18n/lang/<lang>.js`),
not here — see that file for `review_state` / `reviewed_by` / `reviewed_date`. As of wave 8, es,
zh-Hans, and ru are all `machine-drafted` (glossary-pinned, placeholder-verified, **not yet**
native-reviewed) — the UI shows a machine-translation disclosure banner for any language in that
state until a native reviewer signs off and the frontmatter is updated to `native-reviewed`.
