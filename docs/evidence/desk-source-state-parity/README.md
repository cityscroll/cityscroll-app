# Deployed source-state parity evidence

This directory records bounded evidence for the authenticated data-source register. It contains no credentials, private diagnostic payloads, or captured image binaries.

The retained production observation in [`before.json`](before.json) proves that the deployed page still served a 62-row schema 4 snapshot after the canonical producer had moved to schema 5. Age alone did not diagnose the problem. Executing the pinned consumer's compatibility check against the pinned application revision produced the explicit `incompatible-schema` outcome before rendering began.

The repair keeps the canonical schema 4 source model as the **compatibility envelope**—the stable base shape shared with deployed readers—and publishes repair observations as a separately versioned additive extension. It does not add another catalog, health evaluator, scheduler, queue, or interpretation layer.

Evidence boundaries:

- A successful HTTP response proves only that the authenticated route was fetched.
- Structured inventory, detail, run, and receipt reads are separate, bounded, read-only observations. They do not refresh publishers, enqueue work, send alerts, or mutate lifecycle state.
- Publisher, acquisition, serving, and monitoring clocks retain `UNKNOWN` when the canonical observation does not know them.
- Source coverage remains separate from relationship/join coverage.
- Role-specific page fields remain owned by the private consumer. This producer change does not alter authentication, access policy, or public route discovery.
- The provider association was observed without impersonation or access expansion. An anonymous HTTP 403 was deliberately excluded from role-specific authorization evidence.
- Local failure fixtures and local rendering checks are isolated proof, not live-production evidence.

The post-change render manifest is generated from the isolated authenticated-page build and records its route, viewport, revision, data vintage, assertion, and render-content digest. Captures themselves remain ignored.
