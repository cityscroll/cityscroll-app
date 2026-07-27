#!/usr/bin/env node

// Read the exclusion secret from stdin so it never appears in argv, then print the browser-console
// snippet for a five-minute developer token. The Worker independently verifies the HMAC.

import { createHmac } from "node:crypto";

const secret = (await new Promise((resolve, reject) => {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => resolve(input.trim()));
  process.stdin.on("error", reject);
}));

if (secret.length < 32) {
  console.error("ANALYTICS_DEV_KEY must contain at least 32 characters.");
  process.exitCode = 1;
} else {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret)
    .update(`crol-analytics-dev-exclusion\n${timestamp}`)
    .digest("base64url");
  const token = `v1.${timestamp}.${signature}`;
  console.log(`localStorage.setItem("crol_analytics_dev_token_v1", ${JSON.stringify(token)});`);
}
