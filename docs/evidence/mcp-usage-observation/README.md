# MCP usage observation evidence

Offline proof lives in `worker/test/mcp_usage.test.mjs` (handler-level outcomes,
closed schema, secret sentinels, kill switch, broken sink, and private statistics
fold).

Production measurement proof is operator-gated and post-deployment:

```bash
MCP_CANARY_ADMIN_KEY=… node tools/verify_mcp_usage_stats_canary.mjs
```

That canary marks its own MCP traffic as `probe`, then reads `mcp_usage` from the
authenticated private statistics surface. It writes `canary-receipt.json` and
`capture-manifest.json` here. Do not commit image binaries.
