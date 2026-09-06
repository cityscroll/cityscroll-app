# Cloudflare OS entity-research Gadget

This isolated Gadget is the CS-07 composition proof. It runs one deterministic
entity-research workflow through the generic MCP Gatekeeper's named-tool grant:

1. public entity dossier;
2. bounded entity relationships;
3. matching City Record notices; and
4. cited passages.

The Gadget has no model, data-store bindings, credentials, or direct CityScroll
imports. `src/gadget.mjs` only calls the four granted MCP methods and preserves
their structured evidence groups. The pinned upstream revisions and the
kill-switch/rollback contract are in `deployment.json`.

The committed proof is generated and checked by:

```sh
node tools/verify_cloudflare_os_proof.mjs \
  --receipt artifacts/capability-spine/cloudflare-os-proof.json \
  --source integrations/cloudflare-os-entity-research
```
