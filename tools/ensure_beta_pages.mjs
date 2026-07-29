#!/usr/bin/env node
/**
 * Idempotently prepare the Cloudflare Pages project or its production domain.
 *
 * The API token is read from the environment and is never printed or accepted
 * as a command-line argument.
 */

import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.cloudflare.com/client/v4";
export const PROJECT_NAME = "crol-list-beta";
export const PRODUCTION_BRANCH = "beta";
export const BETA_DOMAIN = "beta.crol-list.org";

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
    throw new Error(errorMessage(payload, response.status));
  }
  return payload.result;
}

export function validateAccountId(accountId) {
  if (!/^[0-9a-f]{32}$/.test(accountId || "")) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a lowercase 32-character identifier");
  }
  return accountId;
}

export async function ensureProject({ accountId, token, fetchImpl = fetch }) {
  const id = validateAccountId(accountId);
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
    return { created: false, project: existing };
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
  return { created: true, project };
}

export async function ensureDomain({ accountId, token, fetchImpl = fetch }) {
  const id = validateAccountId(accountId);
  const domainsPath = `/accounts/${id}/pages/projects/${PROJECT_NAME}/domains`;
  const domains = await apiRequest(domainsPath, { token, fetchImpl });
  const existing = Array.isArray(domains)
    ? domains.find((domain) => domain?.name === BETA_DOMAIN)
    : null;
  if (existing) return { created: false, domain: existing };

  const domain = await apiRequest(domainsPath, {
    token,
    method: "POST",
    body: { name: BETA_DOMAIN },
    fetchImpl,
  });
  return { created: true, domain };
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
    return;
  }
  if (phase === "domain") {
    const result = await ensureDomain(options);
    console.log(
      result.created
        ? `Attached ${BETA_DOMAIN} to ${PROJECT_NAME}`
        : `${BETA_DOMAIN} is already attached to ${PROJECT_NAME}`,
    );
    return;
  }
  throw new Error("usage: ensure_beta_pages.mjs <project|domain>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
