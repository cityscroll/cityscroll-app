import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { primaryDocumentOutputs } from "../tools/build_primary_documents.mjs";
import { ROUTE_INVENTORY } from "../tools/pages_route_parity.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PLACEHOLDER = /__[A-Za-z0-9_]+__/;

test("every HTML route is placeholder-free after the production asset stamping step", (t) => {
  // Build only the HTML and translation assets needed by this contract; never copy
  // warehouse products or reach a publisher during the unit family.
  const artifact = mkdtempSync(join(tmpdir(), "served-route-html-"));
  t.after(() => rmSync(artifact, { recursive: true, force: true }));
  const generated = new Map(primaryDocumentOutputs());
  for (const route of ROUTE_INVENTORY.filter((entry) => entry.kind === "html")) {
    const path = route.path.endsWith("/") ? `${route.path}index.html` : route.path;
    const source = join(ROOT, "site", path);
    const html = generated.get(source) ?? readFileSync(source, "utf8");
    const destination = join(artifact, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, html);
  }
  cpSync(join(ROOT, "site/i18n.js"), join(artifact, "i18n.js"));
  cpSync(join(ROOT, "site/i18n/lang"), join(artifact, "i18n/lang"), { recursive: true });
  execFileSync("python3", [join(ROOT, "tools/stamp_i18n_assets.py"), "--site-root", artifact, "--stamp"]);
  execFileSync("python3", [join(ROOT, "tools/stamp_i18n_assets.py"), "--site-root", artifact, "--verify-built"]);
  for (const route of ROUTE_INVENTORY.filter((entry) => entry.kind === "html")) {
    const path = route.path.endsWith("/") ? `${route.path}index.html` : route.path;
    assert.equal(readFileSync(join(artifact, path), "utf8").match(PLACEHOLDER), null, route.path);
  }
});
