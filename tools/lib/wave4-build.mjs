import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));
}

export function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

export function sha256(value) {
  return createHash("sha256").update(JSON.stringify(stableJson(value))).digest("hex");
}

export function jsonText(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

export function writeOrCheck(relativePath, value, check) {
  const path = join(ROOT, relativePath);
  const next = jsonText(value);
  if (check) {
    const current = readFileSync(path, "utf8");
    if (current !== next) throw new Error(`${relativePath} is stale; rebuild without --check`);
    return;
  }
  writeFileSync(path, next);
}
