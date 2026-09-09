import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { primaryDocumentOutputs } from "../tools/build_primary_documents.mjs";
import { ROUTE_INVENTORY } from "../tools/pages_route_parity.mjs";
import { handleFollowing } from "../worker/src/following.mjs";
import { handleNearYou } from "../worker/src/near_you.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PLACEHOLDER = /__[A-Za-z0-9_]+__/;

test("Worker-owned inventory routes serve HTML without build placeholders", async () => {
  const handlers = new Map([["following", handleFollowing], ["near-you", handleNearYou]]);
  for (const route of ROUTE_INVENTORY.filter((entry) => handlers.has(entry.id))) {
    const response = await handlers.get(route.id)(new Request(`https://cityscroll.org${route.path}`));
    assert.equal(response.status, 200, route.path);
    assert.match(response.headers.get("content-type"), /text\/html/, route.path);
    assert.equal((await response.text()).match(PLACEHOLDER), null, route.path);
  }
});

test("served Following HTML has no build placeholders in any document response", async () => {
  for (const revision of [undefined, "a".repeat(40)]) {
    for (const path of ["/following", "/following/", "/following/?lens=unknown", "/following/?lens=money&step=choose"]) {
      const response = await handleFollowing(new Request(`https://cityscroll.org${path}`), {
        GIT_COMMIT_SHA: revision,
      }, {}, { fetchImpl: () => { throw new Error("unexpected network read"); } });
      assert.equal(response.status, 200, path);
      const html = await response.text();
      assert.equal(html.match(PLACEHOLDER), null, path);
      const script = html.match(/<script src="(https:\/\/cityscroll\.org\/i18n\.js[^"]*)"/);
      assert.ok(script, `${path} loads the translation runtime`);
      assert.equal(new URL(script[1]).searchParams.get("v"), revision ?? null);
    }
  }
});

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
