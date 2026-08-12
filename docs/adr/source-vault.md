# ADR: R2 source vault with official-link fallback

| Field | Value |
| --- | --- |
| Status | Accepted, feature-gated |
| Date | 2026-08-12 |
| Scope | Custody of approved public documents and provenance manifests |
| Supersedes | — |
| Related | `worker/src/source_vault.mjs`, `worker/wrangler.toml`, `test/source-vault.test.mjs`, `tools/audit-r2-quarantine.mjs` |

## Context

Some CityScroll features need to retain an approved public document alongside
the official source URL. A retained document needs more than a URL: it needs a
content hash, provenance, an eligibility decision, and a bounded content
inspection. The implementation has an R2 handler for this custody path, but
production must not imply that the bucket is active when its policy and
provisioning prerequisites are not ready.

## Decision

Use an R2-backed, content-addressed source vault for eligible public documents,
with a manifest that records the official URL, SHA-256 hash, process IDs,
retrieval time, eligibility, inspection results, retention policy, and object
key.

The vault accepts only configured public HTTPS source classes and an allowlist
of document types. It rejects uncertain rights or access, credentials,
oversized content, executable signatures, malware signatures, and type/signature
mismatches. New content is written through a quarantined manifest before the
object is approved; reads require an approved manifest. Identical content is
deduplicated by hash.

The production state is disabled: `SOURCE_VAULT_ENABLED = "false"` and the
`SOURCE_VAULT` R2 binding is commented out in `worker/wrangler.toml`. When
disabled, the handler returns the official-link fallback rather than claiming
that retained bytes are available.

## Alternatives

- Store documents directly in the repository or committed site artifacts.
- Fetch and serve source documents on every reader request without custody.
- Enable R2 immediately and accept all public-looking URLs.
- Store only an official URL and omit retained bytes and manifests.

## Rationale

The code supports content-addressed custody, provenance, quarantine, bounded
inspection, and an official-link fallback. The Wrangler comments state that the
feature remains fail-closed until content-policy fixtures and the automatically
provisioned bucket are ready. Those are the evidenced reasons for the current
disabled production state. Any broader historical rationale for introducing a
new R2 service is not recorded: rationale required.

## Consequences

- Approved bytes can be reproduced and deduplicated without losing the
  publisher URL or retrieval context.
- The vault adds policy, storage, manifest, and retention maintenance.
- Public behavior remains safe while the binding is disabled: readers are sent
  to the official source rather than a missing or unapproved object.
- Enabling production requires the binding, policy fixtures, and operational
  checks to be ready together; setting the flag alone is insufficient.

## Evidence

- `worker/wrangler.toml` — sets `SOURCE_VAULT_ENABLED = "false"` and comments
  out the R2 binding.
- `worker/src/source_vault.mjs` — implements source eligibility, inspection,
  SHA-256 addressing, quarantine, approval, deduplication, and disabled-mode
  fallback.
- `test/source-vault.test.mjs` — covers approved manifests, deduplication,
  refusal cases, disabled R2, and rejection of unapproved bytes.
- `tools/audit-r2-quarantine.mjs` — asserts the fail-closed configuration and
  quarantine/approval invariants.
