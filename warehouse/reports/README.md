# Warehouse reports

Static, generated HTML for reading inside the project. Nothing here is served
by the site, routed to, or written for a resident: these are the artifacts a
reviewer opens directly from the working copy, alongside the JSON receipts in
`warehouse/receipts/proof/`.

The rule for anything added here is the rule the first report was built on: an
observed record, a model estimate and an absence in the record are three
different kinds of claim, and a page that renders them alike is worse than no
page. Every generated report must keep them visibly distinct and must print an
estimate's measured calibration next to the estimate, not in a footnote.

| Directory | Produced by | Documented in |
| --- | --- | --- |
| `seqra-review-cards/` | `node tools/build_seqra_baselines.mjs` | [`docs/seqra-multi-target-baselines-internal-card-v1.md`](../../docs/seqra-multi-target-baselines-internal-card-v1.md) |
| `challenge-watch-cards/` | `node tools/backtest_article78_ontology.mjs --write` | [`docs/article78-challenge-watch-card-v1.md`](../../docs/article78-challenge-watch-card-v1.md) |

Every file here is generated and committed, and the command in the table above
fails if a committed report does not reproduce byte for byte
(`npm run warehouse:seqra:backtest` for the review cards,
`npm run warehouse:article78:backtest` for the challenge-watch cards). Edit the
builder, never the output.
