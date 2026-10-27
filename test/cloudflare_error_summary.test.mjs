import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import { summarizeCloudflareError, writeCloudflareErrorSummary } from "../tools/cloudflare_error_summary.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

function expected(codes) {
  return {
    error_codes: codes,
    message: `Cloudflare rejected the deployment with code(s) ${codes.length ? codes.join(", ") : "UNKNOWN"}.`,
  };
}

test("structured Cloudflare errors yield only codes and a fixed template", () => {
  const result = summarizeCloudflareError(JSON.stringify({
    success: false,
    errors: [{ code: 10021, message: "token=secret-value" }],
    result: { request_body: { api_key: "nested-secret", body: "private request" } },
  }));

  assert.deepEqual(result, expected(["10021"]));
});

test("quoted and nested JSON credentials never enter the summary", () => {
  const result = summarizeCloudflareError(
    `Cloudflare response: {"errors":[{"code":10021,"message":"token=secret"}],"request_body":{"api_key":"nested-secret","body":"private"}}`,
  );

  assert.deepEqual(result, expected([]));
  assert.doesNotMatch(JSON.stringify(result), /token|request_body|api_key|nested-secret|private/);
});

test("plain api_key, body, and generic API code text is withheld even when it mentions failure", () => {
  const result = summarizeCloudflareError(
    "deployment failed: api_key=secret body=private request error code=not-a-number; api error code: 10021",
  );

  assert.deepEqual(result, expected([]));
  assert.doesNotMatch(JSON.stringify(result), /api_key|body|secret|private|deployment failed|request error code/);
});

test("unknown identifiers, URLs, emails, and freeform lines are withheld", () => {
  const result = summarizeCloudflareError(
    "failed request https://example.invalid/accounts/0123456789abcdef0123456789abcdef to ops@example.com; id=private-123",
  );

  assert.deepEqual(result, expected([]));
  assert.doesNotMatch(JSON.stringify(result), /https?:\/\/|ops@example\.com|private-123|failed/);
});

test("Markdown and summary injection cannot enter the fixed output", () => {
  const result = summarizeCloudflareError(
    "### injected\n- [open](https://example.invalid/?token=secret)\n[code: 10021]\n<script>bad</script>",
  );

  assert.deepEqual(result, expected(["10021"]));
  assert.equal(result.message, "Cloudflare rejected the deployment with code(s) 10021.");
  assert.doesNotMatch(JSON.stringify(result), /###|\[open\]|https?:\/\/|token|script|injected/);
});

test("the offline writer stores only the fixed summary in the artifact and job summary", async () => {
  await withTempDir("cloudflare-error-summary-test", async (dir) => {
    const logPath = `${dir}/deploy.log`;
    const artifactPath = `${dir}/error.json`;
    const summaryPath = `${dir}/summary.md`;
    writeFileSync(logPath, "Cloudflare API error code: 10021; email ops@example.com; token=secret-value\n");
    writeFileSync(summaryPath, "existing summary\n");

    writeCloudflareErrorSummary({ logPath, artifactPath, summaryPath });

    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    const summary = readFileSync(summaryPath, "utf8");
    assert.deepEqual(artifact, expected(["10021"]));
    assert.match(summary, /Cloudflare rejected the deployment with code\(s\) 10021\./);
    assert.doesNotMatch(`${JSON.stringify(artifact)}\n${summary}`, /ops@example\.com|secret-value|https?:\/\//);
  });
});
