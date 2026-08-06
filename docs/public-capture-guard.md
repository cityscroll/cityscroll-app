# Public image capture guard

Public pull requests scan only newly added raster images. The guard checks path segments for
private-surface markers and reads PNG text metadata for the private site URL and a multi-token
navigation signature. A word boundary is required, so names such as `desktop.png` are unaffected.

An intentional public capture must be rare and must be listed in
`docs/public-capture-allowlist.json` using its exact repository-relative path and a reason:

```json
{
  "captures": {
    "docs/screenshots/example-public-capture.png": "Public landing-page capture for the accessibility guide."
  }
}
```

The allowlist is an exception record, not a path-pattern bypass. Reviewers should remove an entry
when the capture leaves the documentation or test corpus.
