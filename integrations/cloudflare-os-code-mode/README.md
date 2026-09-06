# Cloudflare OS Code Mode measurement

This isolated rehearsal is the CS-08 measurement card. It asks whether pinned
typed Code Mode reduces model-input tokens or external round trips for the same
bounded four-capability composition already proved on ordinary MCP by CS-07.

The rehearsal is not a production migration. It keeps the CS-07 fixture, public-read
grant, bounds, and semantic expectations constant. The kill switch
`CITYSCROLL_CS08_ENABLED` defaults to disabled.

Generate and check the committed receipt with:

```sh
node tools/verify_cloudflare_os_proof.mjs \
  --receipt artifacts/capability-spine/cloudflare-os-proof.json \
  --source integrations/cloudflare-os-entity-research

node tools/verify_code_mode_measurement.mjs \
  --repetitions 30 \
  --require-parity \
  --max-p95-regression 0.10
```
