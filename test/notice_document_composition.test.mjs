import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import edgeWorker from "../site/pages_edge.mjs";
import { renderNoticeRouteChrome } from "../site/notice_document_composition.mjs";
import {
  NOTICE_PRIMARY_COMPONENT_ID,
  NOTICE_PRIMARY_METRIC_ID,
  NOTICE_PRIMARY_SURFACE_ID,
  validateNoticePrimaryReadinessEvidence,
} from "../site/notice_primary_readiness.mjs";
import { measureNoticeEdgeTerminals } from "../tools/measure_notice_edge_response.mjs";
import { todayISO, withPinnedClock } from "./helpers/test_clock.mjs";

const harnessSource = readFileSync(
  new URL("./functional/resident_document_presentation.py", import.meta.url),
  "utf8",
);
const captureManifest = JSON.parse(readFileSync(
  new URL("../docs/evidence/notice-shell/capture-manifest.json", import.meta.url),
  "utf8",
));

const shell = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const ceilings = JSON.parse(readFileSync(
  new URL("../architecture/notice-edge-response-budget.json", import.meta.url),
  "utf8",
));
const primaryReadiness = JSON.parse(readFileSync(
  new URL("../docs/evidence/notice-primary-readiness/read-back.json", import.meta.url),
  "utf8",
));

class FixtureHTMLRewriter {
  constructor(response) { this.response = response; this.handlers = []; }
  on(selector, handlers) { this.handlers.push({ selector, handlers }); return this; }
  async transform(response = this.response) {
    let html = await response.text();
    for (const { selector, handlers } of this.handlers) {
      if (selector === "body") {
        html = html.replace(/<body([^>]*)>/i, (_match, attrs) => {
          const element = {
            setAttribute(name, value) { attrs = `${attrs} ${name}="${value}"`; },
          };
          handlers.element(element);
          return `<body${attrs}>`;
        });
      } else if (selector === "#notice-route-chrome") {
        html = html.replace(/<div id="notice-route-chrome"[^>]*><\/div>/i, (match) => {
          const element = {
            content: "",
            setInnerContent(value) { element.content = value; },
            removeAttribute() { match = match.replace(/ hidden/, ""); },
          };
          handlers.element(element);
          return match.replace(/><\/div>$/, `>${element.content}</div>`);
        });
      } else if (selector === "#noticeview") {
        html = html.replace(/<div id="noticeview"[^>]*>.*?<\/div>/is, (match) => {
          const element = { content: "", setInnerContent(value) { element.content = value; } };
          handlers.element(element);
          return match.replace(/>.*<\/div>$/is, `>${element.content}</div>`);
        });
      }
    }
    return new Response(html, { status: response.status, headers: response.headers });
  }
}

function environment() {
  return {
    ASSETS: { fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/") return new Response(shell, { headers: { "Content-Type": "text/html" } });
      if (path.endsWith("notice_mandate_backlinks_lookup.json")) return new Response("{}");
      if (path.endsWith("meeting_outcomes_snapshot.json")) return new Response("{}");
      return new Response("", { status: 404 });
    } },
  };
}

test("notice route composition uses the shared mast and removes homepage promotion from the reading path", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", async () => {
    const fixtureDay = todayISO();
    assert.match(renderNoticeRouteChrome(), /render|document-mast|notice-document-mast/);
    const priorRewriter = globalThis.HTMLRewriter;
    const priorFetch = globalThis.fetch;
    globalThis.HTMLRewriter = FixtureHTMLRewriter;
    globalThis.fetch = async (request) => {
      const url = new URL(request.url || request);
      if (url.hostname === "api.cityscroll.org") {
        return new Response(JSON.stringify({ row: {
          request_id: "20260915001",
          short_title: "A readable public notice",
          type_of_notice_description: "Public Hearings",
          agency_name: "Example Agency",
          start_date: fixtureDay,
        }, civic_time: null }));
      }
      throw new Error(`unexpected request ${url}`);
    };
    try {
      const response = await edgeWorker.fetch(new Request("https://cityscroll.org/notices/20260915001/"), environment());
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /class="notice-route"/);
      assert.match(html, /class="document-mast notice-document-mast"/);
      assert.match(html, /data-edge-rendered="notice"/);
      assert.match(html, /<h2 class="rolename"[^>]*>A readable public notice<\/h2>/);
      assert.match(html, /notice-route \.masthead \.wrap>:not\(#langSwitcher\)\{display:none!important\}/);
      assert.match(html, new RegExp(fixtureDay));
    } finally {
      globalThis.fetch = priorFetch;
      globalThis.HTMLRewriter = priorRewriter;
    }
  });
});

test("the client route exposes one main notice heading while keeping the language binding movable", () => {
  const core = readFileSync(new URL("../site/app/core.mjs", import.meta.url), "utf8");
  assert.match(core, /applyNoticeRouteState\?\.\(name === "notice"\)/);
  assert.match(readFileSync(new URL("../site/index.html", import.meta.url), "utf8"), /id="langSwitcher"/);
  assert.match(readFileSync(new URL("../site/index.html", import.meta.url), "utf8"), /id="notice-route-chrome"/);
});

test("A6: notice response budgets and primary-readiness semantics remain satisfied", async () => {
  const terminals = await measureNoticeEdgeTerminals();
  for (const [name, ceiling] of Object.entries(ceilings.terminals)) {
    const measured = terminals[name];
    assert.ok(measured, `A6: ${name} terminal is measured`);
    assert.equal(measured.status, ceiling.status, `A6: ${name} status`);
    assert.ok(
      measured.subrequests <= ceiling.maxSubrequests,
      `A6: ${name} makes ${measured.subrequests} subrequests, ceiling ${ceiling.maxSubrequests}`,
    );
    assert.ok(
      measured.dependentStages <= ceiling.maxDependentStages,
      `A6: ${name} walks ${measured.dependentStages} dependent stages, ceiling ${ceiling.maxDependentStages}`,
    );
  }

  const validated = validateNoticePrimaryReadinessEvidence(primaryReadiness);
  assert.equal(validated.ok, true, `A6: primary readiness evidence invalid: ${validated.errors?.join("; ")}`);
  assert.equal(primaryReadiness.identity.metric_id, NOTICE_PRIMARY_METRIC_ID);
  assert.equal(primaryReadiness.identity.surface_id, NOTICE_PRIMARY_SURFACE_ID);
  assert.equal(primaryReadiness.identity.component_id, NOTICE_PRIMARY_COMPONENT_ID);
  assert.equal(primaryReadiness.identity.new_rum_identity, false);
});

test("A5: skip navigation requires focus on the main region", () => {
  assert.match(
    harnessSource,
    /location\.hash === '#main' && document\.activeElement === document\.getElementById\('main'\)/,
  );
  assert.match(harnessSource, /document\.activeElement === document\.getElementById\('main'\)/);
  assert.doesNotMatch(
    harnessSource,
    /location\.hash === '#main' \|\| document\.activeElement === document\.getElementById\('main'\)/,
  );
});

test("A9 writer: capture-manifest condition and revision derive from the served base", () => {
  assert.match(harnessSource, /def manifest_condition\(/);
  assert.match(harnessSource, /def resolve_manifest_revision\(/);
  assert.match(harnessSource, /artifact-manifest\.json/);
  assert.match(harnessSource, /Production base/);
  assert.match(harnessSource, /"condition": manifest_condition\(base\)/);
  assert.doesNotMatch(
    harnessSource,
    /"condition": \(\s*"Local Wrangler Worker with HTMLRewriter/,
  );
  const result = spawnSync(
    "python3",
    ["test/functional/resident_document_presentation.py", "--case", "notice-shell", "--self-test"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /OK notice-shell capture-manifest writer self-test/);
});

test("A9 writer: retained capture manifest records honest local condition and viewport hash invariance", async () => {
  await withPinnedClock("2026-09-16T12:00:00.000Z", async () => {
    assert.equal(todayISO(), "2026-09-16");
    assert.equal(captureManifest.render_hash_viewport_invariant, true);
    assert.match(String(captureManifest.condition || ""), /Local Wrangler Worker/);
    assert.doesNotMatch(String(captureManifest.condition || ""), /^Production base/);
    assert.match(String(captureManifest.revision || ""), /^[0-9a-f]{9}$/);
    assert.equal(captureManifest.image_binaries_committed, false);

    const byCase = new Map();
    for (const capture of captureManifest.captures || []) {
      const widths = byCase.get(capture.case) || {};
      widths[capture.viewport?.name] = capture.render_sha256;
      byCase.set(capture.case, widths);
    }
    assert.ok(byCase.size >= 1, "A9 writer: retained manifest has captures");
    for (const [caseName, widths] of byCase) {
      assert.equal(
        widths.desktop,
        widths.narrow,
        `A9 writer: ${caseName} render hash must match across viewports`,
      );
    }
  });
});
