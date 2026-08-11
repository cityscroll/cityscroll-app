# Data frontiers (per-entry register)

The ranked August 2026 frontier table is stored as **one JSON record per gap**
so concurrent collection / reopen work does not rewrite a shared markdown table.

| Path | Role |
| --- | --- |
| `docs/data-frontiers/2026-08/entries/*.json` | Source of truth for each ranked row |
| `docs/data-frontiers/2026-08/fragments/before.md` | Prose above the table |
| `docs/data-frontiers/2026-08/fragments/after.md` | Prose below the table (RC bodies, maintenance) |
| `docs/data-frontiers-2026-08.md` | **Generated** projection — rebuild, do not hand-edit table rows |

```bash
# After editing an entry disposition or measurement cell:
node tools/build_data_frontiers.mjs

# CI / preflight drift gate:
node tools/build_data_frontiers.mjs --check
```

Update only the entry file for the gap you own. Rebuild the projection in the
same change when you are the sole frontier editor; if two changes both rebuild
the markdown projection they may still touch that one generated file — the
per-entry records themselves merge cleanly.
