# Public URL parity evidence

The stable and beta captures show the same static home-page state at desktop and
mobile widths. The beta-only release banner identifies the reviewed commit and
links back to the stable site.

- [Stable desktop](stable-1440.png) and [beta desktop](beta-1440.png)
- [Stable mobile](stable-390.png) and [beta mobile](beta-390.png)
- [`url-parity.json`](url-parity.json) records the status and normalized SHA-256
  comparison for every shipped HTML, JavaScript, JSON, image, manifest, and text
  asset. All 144 paths returned HTTP 200 with matching content hashes.

The comparison normalizes only review-channel metadata and delivery-layer
transformations: the build-derived i18n version, Cloudflare's injected analytics
beacon, and Cloudflare email protection. Source content is otherwise hashed
byte-for-byte.
