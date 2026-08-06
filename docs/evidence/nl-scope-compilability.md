# NL-to-scope compilability

This is a deterministic synthetic measurement of the offline parser. Production query text is not retained: first-party analytics stores aggregate dimensions, not search text. The corpus is the committed suggestion pool, which exercises the parser's forced-field schemas across the seven supported lenses.

Fractions are measured over the query count shown; `fully-compilable` means at least one typed field and no free-text keyword residue.

| Lens | Queries | Fully | Partial | Free-text only | Residual entity types |
| --- | ---: | ---: | ---: | ---: | --- |
| money | 8 | 0.125 | 0.375 | 0.5 | procurement_topic |
| people | 4 | 0.25 | 0.75 | 0 | person, procurement_topic |
| land | 5 | 0 | 0.8 | 0.2 | land_project_topic, parcel_or_neighborhood |
| property | 5 | 0 | 1 | 0 | property_asset_or_topic |
| rules | 5 | 0 | 0.8 | 0.2 | rule_topic |
| meetings | 6 | 0.3333 | 0.6667 | 0 | meeting_subject |
| alerts | 4 | 0.5 | 0.5 | 0 | procurement_topic |

Closest to keyword retirement in this corpus: **alerts, meetings, people, money, property, land, rules**. This is a readiness signal, not a product decision; the corpus is synthetic and small.

Run `node tools/measure_nl_scope_compilability.mjs` to regenerate the JSON receipt and this report, or add `--check` to verify both committed artifacts.
