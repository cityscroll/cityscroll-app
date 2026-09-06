# Capture-manifest image guard

A new `docs/evidence/<name>/` directory or `capture-manifest.json` names itself
under the same public identity contract as `architecture/evidence.d`
(`tools/public_identity_contract.mjs`): a descriptive name, or — where none
applies yet — the `c<12-hex>` fallback token. Neither carries a card id or a
workstream slug. Existing evidence directories that predate this convention are
unchanged; see `architecture/evidence.d/README.md`.

Visual proof for a change is a capture-manifest entry, not a committed screenshot. A manifest
under `docs/evidence/**/capture-manifest.json` records, per capture, the `route` (or fixture),
`viewport`, `revision`, data vintage, `assertion`, and a `sha256` of the rendered output; the image
itself is retained by the site owner outside the repository, in a gitignored path, and is never
committed. A card-scoped review can miss a screenshot slipping in beside a correct manifest, so
this is enforced at delivery time instead.

The guard (`tools/check_capture_manifest_images.mjs`) lists only paths ADDED in the pull request
against its merge base and fails if any of them sits under `docs/` and matches an image extension
(`.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`, `.bmp`, `.tiff`/`.tif`). Renaming or modifying one of the
pre-existing screenshots under `docs/screenshots/` is unaffected — only a brand-new image path
fails — so the existing corpus never needs a migration or a baseline exemption.

A companion advisory step (`tools/lint_capture_manifest_schema.mjs`) checks that any
`capture-manifest.json` a pull request adds or changes carries a `sha256` on every capture, so the
manifest can actually stand in for the image it replaces. It warns rather than fails: the manifest
corpus only partially carries that field today, and the repository does not yet treat manifest
schema as a hard gate.

## Exceptions

An intentional committed image (for example a README logo) is listed in
`docs/capture-manifest-image-allowlist.json` by its exact repository-relative path with a one-line
reason — no glob patterns. Unlike the legacy-name guard's allowlist, an entry here may be added in
the same change that adds the image: this list exists to let a reviewer approve a genuinely new,
permanent asset in one pass, not to grandfather a violation that predates the rule. The review
discipline instead comes from the exact-path requirement and the mandatory reason — there is no
pattern that silently covers future additions, so every new image still has to be named and
justified on its own line.
