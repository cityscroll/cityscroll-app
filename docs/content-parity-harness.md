# Content-parity performance harness

`tools/content_parity_harness.py` is the local before/after gate for performance changes. It
uses the same six routes and hermetic Playwright fixture network as the existing performance
e2e coverage. The capture is content-aware: each surface has an adapter for meaningful records
and controls, so an optimization cannot pass by preserving only a shell or a DOM shape.

## Run it

Serve the site artifact on a local route-aware server, then capture each build separately:

```sh
python3 tools/local_site_server.py --directory site --port 0 --ready-file /tmp/cityscroll-site-ready
export CROL_BASE="$(tr -d '\\n' </tmp/cityscroll-site-ready)"
tools/content-parity-harness capture --ref baseline
tools/content-parity-harness capture --ref candidate
tools/content-parity-harness compare --before baseline --after candidate
```

`CROL_BASE` may be exported instead of passing `--base`. Captures default to three runs per
viewport so the report contains p75 values. Use `--surfaces home,notice` for a focused pass or
`--runs 1` for a quick local iteration. The default output is `.artifacts/content-parity/`.

Each capture contains a stable SHA-256 fingerprint, sorted records and controls, readiness and
paint samples, and full-page mobile (390×844) and desktop (1440×900) screenshots. `compare`
writes `reports/index.html` plus one JSON report per surface. The HTML report is the batch review
surface; screenshots are linked beside each verdict.

The PNGs are comparison working files; each full-page screenshot is also encoded as WebP and
copied into the content-addressed owner-proof store under `.artifacts/evidence-store/`. Its receipt
index records the PR, card, capture kind, phase, viewport, commit, hash, media type, bytes, stable
URL, retention deadline, and gate receipt. The store uses DuckDB when the optional package in
`tools/requirements-evidence-store.txt` is installed. It also writes a deterministic JSONL receipt
index so local capture and verification remain usable without that package; CI capture jobs should
install the requirements file before running the gate. Objects are addressed by their SHA-256
bytes and are written once. Ordinary evidence expires after 90 days; a `release`,
`release-evidence`, or `accepted-release` phase has no retention deadline. Functional goldens and
fixtures remain in the repository.

In GitHub Actions, the gate derives a stable run URL from `GITHUB_SERVER_URL`,
`GITHUB_REPOSITORY`, and `GITHUB_RUN_ID`. Upload both the comparison output and store directory
with the same artifact name after the two captures:

```yaml
- name: Upload content-parity owner proof
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: content-parity-${{ github.run_id }}
    path: |
      .artifacts/content-parity/
      .artifacts/evidence-store/
    if-no-files-found: error
    retention-days: 90
```

Outside CI, object URLs use the `backstage://` scheme and the receipt retains the local object
path separately. A `file://` or other local filesystem URL is rejected by
`tools/verify_evidence_store.mjs`.

The gate is fail-closed:

- every baseline record and field must still exist in the candidate;
- every baseline meaningful control must still exist;
- no readiness or paint p75 may regress, and at least one must improve by the configured minimum;
- a pixel-diff above the visual threshold is a `REVIEW` and fails the command until reviewed.

Additive content is allowed. An intentional loss must be named in a versioned allow file and
carry a reason; there is no broad or silent bypass:

```json
{
  "schema": "cityscroll.content_parity_allow.v1",
  "changes": [
    {
      "surface": "notice",
      "kind": "field",
      "key": "record:notice:20260714015.text",
      "reason": "The old duplicate summary is intentionally removed; the canonical body remains."
    }
  ]
}
```

Pass it explicitly with `compare --allow-file path/to/allow.json`. The report records allowed
losses separately from a clean parity pass.
