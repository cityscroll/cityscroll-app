import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import {
  PAGES_FUNCTION_JSON_HEADROOM_BYTES,
  PAGES_FUNCTION_RAW_LIMIT_BYTES,
  measurePagesFunctionsBundle,
} from "../tools/measure_pages_functions_bundle.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const ADMIN_CODE_SOURCE = readFileSync(join(ROOT, "site/admin_code.mjs"), "utf8");

test("the Pages Function does not statically import the Admin Code search index", () => {
  assert.doesNotMatch(
    ADMIN_CODE_SOURCE,
    /import\s+[^;]*legal_code\/search\.json/,
    "search.json belongs on the ASSETS / Worker fetch path; bundling it trips Cloudflare's 25 MiB Function ceiling",
  );
  assert.match(ADMIN_CODE_SOURCE, /ADMIN_CODE_SEARCH_INDEX_PATH\s*=\s*"data\/legal_code\/search\.json"/);
});

test("Pages Functions static JSON stays under the deploy headroom mark", () => {
  const report = measurePagesFunctionsBundle({ root: ROOT, entry: join(ROOT, "site/_worker.js") });
  assert.deepEqual(report.missing, [], `graph paths missing from the checkout: ${report.missing.join(", ")}`);
  assert.equal(
    report.json_imports.some((row) => row.path === "site/data/legal_code/search.json"),
    false,
    "Admin Code search index must stay out of the Functions graph",
  );
  assert.ok(
    report.json_import_bytes <= PAGES_FUNCTION_JSON_HEADROOM_BYTES,
    `static JSON in the Functions graph is ${(report.json_import_bytes / (1024 * 1024)).toFixed(2)} MiB; `
    + `keep it at or below ${(PAGES_FUNCTION_JSON_HEADROOM_BYTES / (1024 * 1024)).toFixed(0)} MiB so bundling cannot cross 25 MiB`,
  );
  assert.ok(
    report.module_bytes <= PAGES_FUNCTION_RAW_LIMIT_BYTES,
    `Functions graph ${(report.module_bytes / (1024 * 1024)).toFixed(2)} MiB exceeds the 25 MiB uncompressed ceiling`,
  );
});

test("measure_pages_functions_bundle CLI exits clean on this checkout", () => {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "tools/measure_pages_functions_bundle.mjs")],
    { encoding: "utf8", cwd: ROOT },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Pages Functions graph guard passed/);
});
