#!/usr/bin/env node
/**
 * Idempotently prepare the stable Cloudflare Pages project for parallel serving.
 *
 * The API token is read from the environment and is never printed or accepted
 * as a command-line argument. Custom domains are intentionally out of scope
 * here — see docs/hosting-cutover-runbook.md for the operator cutover steps.
 */

import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.cloudflare.com/client/v4";
export const PROJECT_NAME = "cityscroll";
export const PRODUCTION_BRANCH = "main";
export const PAGES_DEV_HOST = `${PROJECT_NAME}.pages.dev`;
export const PAGES_DEV_ORIGIN = `https://${PAGES_DEV_HOST}`;

function errorMessage(payload, status) {
  const messages = Array.isArray(payload?.errors)
    ? payload.errors.map((entry) => entry?.message).filter(Boolean)
    : [];
  return messages.length ? messages.join("; ") : `Cloudflare API returned HTTP ${status}`;
}

export async function apiRequest(
  path,
  { token, method = "GET", body, fetchImpl = fetch, allowNotFound = false } = {},
) {
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok || payload?.success === false) {
    throw new Error(errorMessage(payload, statusFrom(response, payload)));
  }
  return payload.result;
}

function statusFrom(response, payload) {
  if (response?.status) return response.status;
  const code = payload?.errors?.[0]?.code;
  return code || 0;
}

export function validateAccountId(accountId) {
  if (!/^[0-9a-f]{32}$/.test(accountId || "")) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a lowercase 32-character identifier");
  }
  return accountId;
}

export async function resolveAccountId({
  accountId,
  token,
  fetchImpl = fetch,
}) {
  if (accountId) return validateAccountId(accountId);
  const accounts = await apiRequest("/accounts?per_page=50", { token, fetchImpl });
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    throw new Error(
      "Token must grant exactly one account or CLOUDFLARE_ACCOUNT_ID must be configured",
    );
  }
  return validateAccountId(accounts[0]?.id);
}

export async function ensureProject({ accountId, token, fetchImpl = fetch }) {
  const id = await resolveAccountId({ accountId, token, fetchImpl });
  const projectPath = `/accounts/${id}/pages/projects/${PROJECT_NAME}`;
  const existing = await apiRequest(projectPath, {
    token,
    fetchImpl,
    allowNotFound: true,
  });
  if (existing) {
    if (existing.production_branch !== PRODUCTION_BRANCH) {
      throw new Error(
        `Existing ${PROJECT_NAME} project uses production branch ${existing.production_branch}; expected ${PRODUCTION_BRANCH}`,
      );
    }
    return { created: false, project: existing, accountId: id };
  }

  const project = await apiRequest(`/accounts/${id}/pages/projects`, {
    token,
    method: "POST",
    body: {
      name: PROJECT_NAME,
      production_branch: PRODUCTION_BRANCH,
    },
    fetchImpl,
  });
  return { created: true, project, accountId: id };
}

async function main() {
  const phase = process.argv[2];
  const options = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
  };
  if (phase === "project") {
    const result = await ensureProject(options);
    console.log(
      result.created
        ? `Created ${PROJECT_NAME} with production branch ${PRODUCTION_BRANCH}`
        : `${PROJECT_NAME} already uses production branch ${PRODUCTION_BRANCH}`,
    );
    console.log(`Parallel host: ${PAGES_DEV_ORIGIN}/`);
    return;
  }
  throw new Error("usage: ensure_stable_pages.mjs project");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
