# Procurement intent radar evidence

Retained corpus-backtest and shadow-mode measurement artifacts for the
prospective procurement intent workstream.

## Current retained reports

- [`corpus-backtest.md`](corpus-backtest.md) — cutoff-faithful historical
  backtest and no-promotion verdict for the labeled window.
- [`shadow-mode.md`](shadow-mode.md) — prospective shadow observation over the
  retained fixture arrival stream. Fixture-only; does not authorize public
  meeting or procurement lifecycle panels.

## Production observation path (event gate)

Public meeting and procurement intent lifecycle panels stay held until a
retained production aggregate exists at:

`docs/evidence/procurement-intent-radar/shadow-mode-production-aggregate.json`

That file is intentionally absent while only fixture streams are available.
Observe it with:

```bash
node tools/observe_procurement_intent_public_authorization.mjs \
  --merge-commit <landed-merge-sha> \
  --out docs/evidence/procurement-intent-radar/public-authorization-observation.json
```

The observer refuses absent or fixture-only aggregates and pins every receipt
to the landed merge commit. It does not itself authorize publication.
