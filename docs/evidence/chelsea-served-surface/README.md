# Chelsea Near You served-surface production read

Production evidence for the Chelsea-Hudson Yards (`nta2020:MN0401`) Near You
served surface: no-lens overview, first-viewport map fit on `surface=map`,
per-lens coverage, negative controls, interaction continuity, and identity
compare against committed `district_activity` geography items.

## Capture status

**Captured** against production after Worker Live URL smoke and Pages
`artifact-manifest.json` both contained the required overview and first-viewport
map ancestors. Textual receipts only; screenshot binaries stay under local task
scratch and are not committed.

Single fresh `--half both` run (`capture_run_id` / `packet_hash` on the receipt).
Do not merge halves from different runs into the shipped packet.

Observed production overview-link place-scope is **split by served half and viewport** (do not merge Worker-SSR with Pages-client):

- **Worker-SSR** (`overview-open-lens-links-place-scope-worker-ssr-{desktop,narrow}`): document-load probe (`worker/src/near_you.mjs` imports `site/near_you_view.mjs`).
- **Pages-client** (`overview-open-lens-links-place-scope-pages-client-{desktop,narrow}`): island-adopt client path with both Open meetings / Open Zoning hrefs snapshotted on the adopted client DOM before document-navigation clicks; post-reload clicks labeled Worker-SSR unless re-adopted. Integrated dual-half re-observation remains pending while live halves diverge.
- **Same-document client lens switch** (`overview-client-lens-switch-same-document-{desktop,narrow}`): window-marker survival for same-document client lens switch.
- **Scoped failed-detail (live product recovery)**: product-rendered Chelsea record link; narrowly `route.continue` redirect that document request to a real nonexistent `/meetings/` id so Pages edge answers with its own 404 + Try again / Browse meetings; Back restores Chelsea (`interaction-scoped-failed-detail-real-*`). Abort retained-page and authored/replayed fulfill-body rows are diagnostic only and never live scoped failed-detail recovery.
- **Keyboard**: deployed-route journeys recorded separately; hermetic negative controls do not substitute. Category transition targets overview Open Zoning (meetings surfaces omit Chelsea `lens=land` controls). Keyboard place-link destination is recorded; map-first surface difference is labeled explicitly and is not treated as broken browser-history return. Native browser Back shortcut is not required for the keyboard journey. Separate history API Back (`page.go_back`) is recorded on its own row.
- Dual-half packets assert one uniform `served_revision` across every observation row before write (`summary.uniform_served_revision`).
- Lens coverage, viewport chrome (both viewports including 390px), and negative controls remain at `1440x900` and `390x844`.
- Capture ship is evidence refresh. Focused proofs may exist while updated integrated dual-half production capture remains pending.


## Verify

```bash
python3 tools/capture_chelsea_served_surface_production_read.py --check-gates
python3 tools/capture_chelsea_served_surface_production_read.py --check
node --test test/chelsea_served_surface_production_read.test.mjs
```

To refresh against a newer green dual-half deploy:

```bash
python3 tools/capture_chelsea_served_surface_production_read.py
python3 tools/capture_chelsea_served_surface_production_read.py --check
```
