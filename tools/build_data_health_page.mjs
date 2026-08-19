#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderDataHealthPage } from "../site/data_health_page.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "site/data-health/index.html");

export function dataHealthPageHtml(root = ROOT) {
  const projection = JSON.parse(readFileSync(join(root, "site/data/source_health_public.json"), "utf8"));
  return renderDataHealthPage(projection);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const html = dataHealthPageHtml(ROOT);
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : null;
  const check = process.argv.includes("--check");

  if (current !== html) {
    if (check) {
      console.error("Data health page is stale; rebuild it from site/data/source_health_public.json");
      process.exit(1);
    }
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, html);
    console.log("wrote", OUTPUT);
  } else {
    console.log(check ? "Data health page ok" : "Data health page unchanged");
  }
}
