/**
 * Warehouse catalog seam (WH-01).
 * Resolves paths and dataset registry for local/ops SQL — not an edge Worker path.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WAREHOUSE_DIR = resolve(HERE, "..");
export const REPO_ROOT = resolve(WAREHOUSE_DIR, "..");
export const DATASETS_PATH = join(WAREHOUSE_DIR, "datasets.v0.json");

export function warehouseRoot() {
  const env = (process.env.CITYSCROLL_WAREHOUSE_ROOT || "").trim();
  if (env) return resolve(env);
  return WAREHOUSE_DIR;
}

export function duckdbPath() {
  return join(warehouseRoot(), "duckdb", "cityscroll.duckdb");
}

export function loadRegistry() {
  return JSON.parse(readFileSync(DATASETS_PATH, "utf8"));
}

export function listDatasets() {
  const reg = loadRegistry();
  return Object.values(reg.datasets || {});
}

export function getDataset(id) {
  const reg = loadRegistry();
  const ds = reg.datasets?.[id];
  if (!ds) {
    const known = Object.keys(reg.datasets || {}).join(", ");
    throw new Error(`Unknown dataset ${id}. Known: ${known}`);
  }
  return ds;
}

export function catalogExists() {
  return existsSync(duckdbPath());
}
