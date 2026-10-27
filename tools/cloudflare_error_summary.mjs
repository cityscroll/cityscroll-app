#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const MAX_CODES = 8;
const CODE_PATTERN = /^\d{3,6}$/;
const UNKNOWN_CODE = "UNKNOWN";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function addCode(codes, value) {
  const code = String(value ?? "").trim();
  if (!CODE_PATTERN.test(code) || codes.includes(code) || codes.length >= MAX_CODES) return;
  codes.push(code);
}

function codesFromCloudflareJson(value, codes) {
  if (!value || typeof value !== "object" || !Array.isArray(value.errors)) return;
  for (const error of value.errors) {
    if (error && typeof error === "object") addCode(codes, error.code);
  }
}

function codesFromJsonLine(line, codes) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return;
  try {
    codesFromCloudflareJson(JSON.parse(trimmed), codes);
  } catch {
    // Wrangler's human-readable output is handled by the explicit context patterns.
  }
}

function codesFromProviderContext(line, codes) {
  const patterns = [
    /\bcloudflare(?:\s+api)?\b[^\n]{0,160}\b(?:error\s+)?code\s*[:=]\s*(\d{3,6})\b/i,
    /\bcloudflare\s+api\s+error\s+code\s*[:=]\s*(\d{3,6})\b/i,
    /\b(?:error\s+)?code\s*[:=]\s*(\d{3,6})\s*\]/i,
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) addCode(codes, match[1]);
  }
}

export function cloudflareErrorCodes(logText) {
  const codes = [];
  const text = String(logText || "").replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "");
  for (const line of text.split(/\r?\n/)) {
    codesFromJsonLine(line, codes);
    codesFromProviderContext(line, codes);
    if (codes.length >= MAX_CODES) break;
  }
  if (codes.length < MAX_CODES) {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        codesFromCloudflareJson(JSON.parse(trimmed), codes);
      } catch {
        // A non-JSON log cannot contribute structured provider codes here.
      }
    }
  }
  return codes;
}

export function deploymentErrorMessage(codes) {
  const values = Array.isArray(codes) ? codes.filter((code) => CODE_PATTERN.test(String(code))) : [];
  return `Cloudflare rejected the deployment with code(s) ${values.length ? values.join(", ") : UNKNOWN_CODE}.`;
}

export function summarizeCloudflareError(logText) {
  const error_codes = cloudflareErrorCodes(logText);
  return { error_codes, message: deploymentErrorMessage(error_codes) };
}

export function writeCloudflareErrorSummary({ logPath, artifactPath, summaryPath }) {
  const summary = summarizeCloudflareError(readFileSync(logPath, "utf8"));
  writeFileSync(artifactPath, `${JSON.stringify(summary, null, 2)}\n`);
  appendFileSync(summaryPath, [
    "",
    "### Cloudflare Worker deployment error",
    `- ${summary.message}`,
    "",
  ].join("\n"));
  return summary;
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const logPath = argument("--log");
  const artifactPath = argument("--artifact");
  const summaryPath = argument("--summary");
  if (!logPath || !artifactPath || !summaryPath) {
    console.error("usage: cloudflare_error_summary.mjs --log PATH --artifact PATH --summary PATH");
    process.exitCode = 2;
  } else {
    writeCloudflareErrorSummary({ logPath, artifactPath, summaryPath });
  }
}
