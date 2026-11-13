// Exact-record withholding for one published organization name.
// Identity is the publisher allowance: publisher, dataset, account, name field, sha256
// of that field's exact published string. A different account, field, or value is kept.
// The withheld string is omitted. It is never replaced with another name.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ORGANIZATION_NAME_FIELDS = Object.freeze(["vendor_formal_name", "name_stem"]);
export const SBS_NAME_PUBLISHER = "nyc-open-data";
export const SBS_NAME_DATASET = "ci93-uc8s";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

/** Name-field rows only. Description and website allowances are not name withholdings. */
export function organizationNameWithholdings(allowanceDoc) {
  const rows = Array.isArray(allowanceDoc?.allowances) ? allowanceDoc.allowances : [];
  return rows.filter((row) => ORGANIZATION_NAME_FIELDS.includes(row.field));
}

export function loadOrganizationNameWithholdings(root = ROOT) {
  const path = join(root, "architecture/private-identifier-publisher-allowances.json");
  return organizationNameWithholdings(JSON.parse(readFileSync(path, "utf8")));
}

/** True only when publisher, dataset, account, and the value's sha256 match one name-field rule. */
export function exactNameWithheld(rules, { publisher, dataset, account, value }) {
  if (value == null || value === "") return false;
  const accountNumber = String(account);
  const hash = sha256Hex(value);
  return rules.some((rule) => rule.publisher === publisher
    && rule.dataset === dataset
    && String(rule.account_number) === accountNumber
    && ORGANIZATION_NAME_FIELDS.includes(rule.field)
    && rule.value_sha256 === hash);
}

export function withheldNameNote(count) {
  if (!count) return [];
  if (count === 1) return ["1 published record name is withheld for a privacy rule."];
  return [`${count} published record names are withheld for a privacy rule.`];
}
