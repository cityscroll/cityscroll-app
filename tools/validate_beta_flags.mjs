#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const valueAfter = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const registryPath = resolve(valueAfter("--registry", "site/beta-flags.json"));
const today = valueAfter("--today", new Date().toISOString().slice(0, 10));
const errors = [];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FORBIDDEN_KEYS = new Set(["access", "authorization", "entitlements", "permissions", "roles"]);

function validDate(value) {
  return typeof value === "string"
    && DATE_RE.test(value)
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, "utf8"));
} catch (error) {
  console.error(`beta flag registry could not be read: ${error.message}`);
  process.exit(1);
}

if (registry.schema_version !== 1) errors.push("schema_version must equal 1");
if (!Array.isArray(registry.flags)) errors.push("flags must be an array");

const slugs = new Set();
for (const [index, flag] of (registry.flags || []).entries()) {
  const label = `flags[${index}]`;
  if (!SLUG_RE.test(flag.slug || "")) errors.push(`${label}.slug must be a lowercase kebab-case slug`);
  if (slugs.has(flag.slug)) errors.push(`${label}.slug duplicates ${flag.slug}`);
  slugs.add(flag.slug);
  if (flag.default_off !== true) errors.push(`${label}.default_off must be true`);
  if (typeof flag.owner !== "string" || !flag.owner.trim()) errors.push(`${label}.owner is required`);
  if (!validDate(flag.introduced_on)) errors.push(`${label}.introduced_on must be a real YYYY-MM-DD date`);
  if (!validDate(flag.removal_date)) errors.push(`${label}.removal_date must be a real YYYY-MM-DD date`);
  if (validDate(flag.removal_date) && flag.removal_date < today) {
    errors.push(`${label} expired on ${flag.removal_date}; remove it or renew it explicitly`);
  }
  if (validDate(flag.introduced_on) && validDate(flag.removal_date)) {
    const lifespanDays = (
      Date.parse(`${flag.removal_date}T00:00:00Z`)
      - Date.parse(`${flag.introduced_on}T00:00:00Z`)
    ) / 86400000;
    if (lifespanDays < 0 || lifespanDays > 90) {
      errors.push(`${label} must have a removal date within 90 days of introduction`);
    }
  }
  if (!Array.isArray(flag.affected_surfaces) || flag.affected_surfaces.length === 0
      || flag.affected_surfaces.some((surface) => typeof surface !== "string" || !surface.trim())) {
    errors.push(`${label}.affected_surfaces must name at least one surface`);
  }
  for (const state of ["on", "off"]) {
    const tests = flag.tests?.[state];
    if (!Array.isArray(tests) || tests.length === 0) {
      errors.push(`${label}.tests.${state} must name at least one test`);
      continue;
    }
    for (const testPath of tests) {
      if (typeof testPath !== "string" || !existsSync(resolve(testPath))) {
        errors.push(`${label}.tests.${state} references missing test ${String(testPath)}`);
      }
    }
  }
  for (const key of Object.keys(flag)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`${label}.${key} is forbidden; public flags never grant access`);
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(`beta flag contract: ${error}`);
  process.exit(1);
}
console.log(`beta flag contract valid: ${registry.flags.length} registered flag(s)`);
