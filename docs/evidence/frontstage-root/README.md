# Public URL parity evidence

The stable and beta captures show the same static home-page state at desktop and
mobile widths. The beta-only release banner identifies the reviewed commit and
links back to the stable site.

- [Stable desktop](backstage://cityscroll-evidence/objects/sha256/c3/c37a804dc2382e7351c26bd45ea23c7501b7eb22f4fd41f095f12421ea6daeed.webp) and [beta desktop](backstage://cityscroll-evidence/objects/sha256/eb/ebf762d4837d9c40659e73b24aaa9dadd1ef23c9b18eb6e5d55619d702f4fdc4.webp)
- [Stable mobile](backstage://cityscroll-evidence/objects/sha256/d2/d29d71e602a61e88a1d7d76f27a26eec4051cce39be2e606741b249f0bd2d23f.webp) and [beta mobile](backstage://cityscroll-evidence/objects/sha256/12/128cce3b9213381e4b00a06e37da49f02b2bfd113a21addf9839cdb155038650.webp)
- [`url-parity.json`](url-parity.json) records the status and normalized SHA-256
  comparison for every shipped HTML, JavaScript, JSON, image, manifest, and text
  asset. All 144 paths returned HTTP 200 with matching content hashes.

The comparison normalizes only review-channel metadata and delivery-layer
transformations: the build-derived i18n version, Cloudflare's injected analytics
beacon, and Cloudflare email protection. Source content is otherwise hashed
byte-for-byte.
