#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CARTO_BASEMAP_API_KEY as MARKER, hasConfiguredCartoBasemapKey } from "../site/carto_basemap.mjs";

/** Configure both public module layouts before the release manifest is hashed. */
export function injectCartoBasemapKey({ siteDir, apiKey, required = false }) {
  if (!apiKey && required) throw new Error("CARTO_BASEMAP_API_KEY is required for this build");
  if (apiKey && !hasConfiguredCartoBasemapKey(apiKey)) throw new Error("Invalid CARTO basemap key format (value redacted)");
  const paths = [resolve(siteDir, "carto_basemap.mjs"), resolve(siteDir, "site/carto_basemap.mjs")];
  const declaration = `export const CARTO_BASEMAP_API_KEY = ${JSON.stringify(MARKER)};`;
  // Validate all outputs before changing any of them.
  const outputs = paths.filter((path, index) => index === 0 || existsSync(path)).map((path) => {
    const source = readFileSync(path, "utf8");
    if (source.split(declaration).length !== 2) throw new Error("Expected exactly one CARTO key declaration in each output module");
    return { path, source };
  });
  if (!apiKey) return { configured: false, modules: outputs.length };
  for (const { path, source } of outputs) {
    writeFileSync(path, source.replace(declaration, `export const CARTO_BASEMAP_API_KEY = ${JSON.stringify(apiKey)};`));
  }
  return { configured: true, modules: outputs.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let siteDir = "_site";
  let required = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--require") required = true;
    else if (args[i] === "--site-dir" && args[i + 1]) siteDir = args[++i];
    else throw new Error("Invalid CARTO injection arguments");
  }
  const result = injectCartoBasemapKey({ siteDir, apiKey: process.env.CARTO_BASEMAP_API_KEY || "", required });
  console.log(`CARTO basemap configuration: ${result.configured ? "configured" : "not configured"}; ${result.modules} output modules; value redacted`);
}
