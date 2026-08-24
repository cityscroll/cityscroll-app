#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildFollowingViewModel, renderFollowingDocument } from "../site/following_view.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(ROOT, "site/following/index.html");
const suggestedTemplates = JSON.parse(readFileSync(join(ROOT, "site/data/following_procurement_suggestions.json"), "utf8"));
const html = renderFollowingDocument(buildFollowingViewModel({}, suggestedTemplates));
const current = existsSync(output) ? readFileSync(output, "utf8") : null;
const check = process.argv.includes("--check");

if (current !== html) {
  if (check) {
    console.error("Following build document is stale");
    process.exit(1);
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, html);
  console.log("wrote", output);
} else {
  console.log(check ? "Following page ok" : "Following page unchanged");
}
