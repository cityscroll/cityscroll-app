import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { execFile, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  ASSISTANT_SETUP_CAPTURE_ROUTES,
  ASSISTANT_SETUP_VIEWPORTS,
  CAPABILITY_DISCOVERY_MATRIX,
  copyEndpointAddress,
  installEndpointCopyControl,
  renderAskWithAiLink,
  renderEndpointControl,
} from "../site/ai_discovery.mjs";
import {
  CAPABILITY_TASK_DISPOSITIONS,
  CAPABILITY_TASK_BINDINGS,
  CAPABILITY_TASK_PLACEMENTS,
  DISCOVERY_ANALYTICS_ALLOWLIST,
  DISCOVERY_CONTRACT_ID,
  DISCOVERY_REQUIREMENTS,
  GENERIC_AI_INTRODUCTION_PATH,
  INTRODUCTION_FAMILY,
  PAGE_FAMILY_DISCOVERY,
  pageFamilyCensusFromPublishedSurfaces,
  PRIVATE_DISCOVERY_BANLIST,
  pageFamilySurfaceIds,
  validateDiscoveryContract,
  validateMutatedDiscovery,
} from "../site/capability_discovery_contract.mjs";
import { AFFORDANCE_ACTION_ROLES } from "../site/affordance_grammar.mjs";
import { renderCivicDocumentMast } from "../site/civic_document_chrome.mjs";
import { GUIDE_HELP } from "../site/guide_contextual_links.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";
import { mountDocument } from "./helpers/preview_dom.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const siteRoot = new URL("../site/", import.meta.url);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const CAPTURE_MANIFEST = new URL("../docs/evidence/assistant-setup/capture-manifest.json", import.meta.url);
const PRODUCTION_CAPTURE_MANIFEST = new URL("../docs/evidence/assistant-setup-served/capture-manifest.json", import.meta.url);
const CAPTURE_SCRIPT = new URL("../tools/capture_assistant_setup_evidence.py", import.meta.url);
const SETUP_SOURCE_PATHS = Object.freeze([
  "site/near-you/index.html",
  "site/pages_edge.mjs",
  "tools/local_site_server.py",
  "worker/wrangler.toml",
  "site/use-with-ai/index.html",
  "site/api.html",
  "site/ai_discovery.mjs",
  "site/data/assistant_setup_sources.json",
]);

function read(rel) {
  return readFileSync(resolve(root, rel), "utf8");
}

/** Soft-depend helper: import a sibling surface module only when it exists on this tree. */
async function importIfPresent(relPath) {
  const absolute = resolve(root, relPath);
  try {
    accessSync(absolute);
  } catch {
    return null;
  }
  return import(pathToFileURL(absolute).href);
}

function publishedSurfaceIds() {
  const manifest = JSON.parse(read("site/data/performance-classification-manifest.v1.json"));
  return manifest.surfaces.map((surface) => surface.surface_id);
}

function mcpToolNames() {
  const catalog = JSON.parse(read("site/data/mcp_tool_catalog.json"));
  return catalog.tools.map((tool) => tool.name);
}

function discoveryRenderOwnerSources() {
  const paths = new Set([
    ...PAGE_FAMILY_DISCOVERY.map((row) => row.render_owner),
    ...CAPABILITY_TASK_BINDINGS.map((row) => row.render_owner),
  ]);
  return Object.fromEntries([...paths].map((path) => [path, read(path)]));
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Match tools/capture_assistant_setup_evidence.py canonical_json(). */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function contentRevision() {
  const lines = [];
  for (const relative of SETUP_SOURCE_PATHS) {
    const bytes = await readFile(new URL(`../${relative}`, import.meta.url));
    lines.push(`${relative}:${createHash("sha256").update(bytes).digest("hex")}`);
  }
  return digest(`${lines.join("\n")}\n`);
}

function witnessDigest(capture) {
  const witness = {
    observed: capture.observed,
    route: capture.route,
    source_path: capture.source_path,
    source_sha256: capture.source_sha256,
    viewport: capture.viewport,
    viewport_height: capture.viewport_height,
    viewport_width: capture.viewport_width,
  };
  return digest(stableStringify(witness));
}

function assertionHolds(route, html) {
  if (route === "/") {
    assert.match(html, /data-near-you-root/);
    assert.match(html, /use-with-ai\//);
    assert.match(html, /Ask with AI/);
    assert.match(html, /href="\/browse\/"/);
    assert.match(html, /href="\/following\/"/);
    return;
  }
  if (route === "/use-with-ai/") {
    for (const token of [
      "mcp-endpoint",
      "data-copy-endpoint",
      "connect-first",
      "id=\"connect\"",
      "id=\"claude-web\"",
      "id=\"claude\"",
      "id=\"other\"",
      "id=\"try\"",
      "id=\"next\"",
      "CT107120258801626",
      "2024Q0356",
      "/api.html#mcp",
      "no account",
      "installEndpointCopyControl",
      "/ai_discovery.mjs",
    ]) {
      assert.match(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), token);
    }
    return;
  }
  if (route === "/api.html#mcp") {
    assert.match(html, /id="mcp"/);
    assert.match(html, /use-with-ai\//);
    return;
  }
  assert.fail(`unexpected capture route: ${route}`);
}

function pythonPlaywrightImportable() {
  const probe = spawnSync("python3", ["-c", "import playwright"], {
    encoding: "utf8",
    env: process.env,
  });
  return probe.status === 0;
}

test("the public discovery projection covers the declared utility families", () => {
  const names = CAPABILITY_DISCOVERY_MATRIX.map(([name]) => name);
  for (const name of ["MCP", "Follow", "Calendar", "Feeds", "Saved searches", "Collection/export", "Evidence", "As-of", "Comparative analysis"]) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(names.length, CAPABILITY_TASK_BINDINGS.length);
});

test("shared and standalone public surfaces link to the static introduction", async () => {
  const pages = ["index.html", "about.html", "api.html", "stats.html", "guide/index.html", "use-with-ai/index.html"];
  for (const page of pages) {
    const html = await readFile(new URL(page, siteRoot), "utf8");
    assert.match(html, /use-with-ai\//, page);
  }
  const escaped = renderAskWithAiLink({ href: "/use-with-ai/?q=a&amp;b=1", translate: () => "<Ask>" });
  assert.match(escaped, /&lt;Ask&gt;/);
  assert.match(escaped, /use-with-ai\/\?q=a&amp;amp;b=1/);
});

test("introduction keeps primary recovery and copy fallback visible", async () => {
  const html = await readFile(new URL("use-with-ai/index.html", siteRoot), "utf8");
  for (const token of [
    "mcp-endpoint",
    "data-copy-endpoint",
    "Claude Code",
    "get_contract",
    "get_land_decision_path",
    "CT107120258801626",
    "2024Q0356",
    "/api.html#mcp",
    "no account",
  ]) {
    assert.match(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), token);
  }
  assert.match(renderEndpointControl(), /data-copy-endpoint/);
});

test("A6: endpoint copy control exercises clipboard success and focus-select fallback", async () => {
  await withPinnedClock("2026-09-16T12:00:00.000Z", async () => {
    const markup = renderEndpointControl();
    const { container } = mountDocument(markup);
    const input = container.querySelector("#mcp-endpoint");
    Object.defineProperty(input, "value", {
      configurable: true,
      get() { return this.getAttribute("value") || ""; },
      set(value) { this.setAttribute("value", String(value)); },
    });
    input.selectCount = 0;
    input.select = function selectEndpoint() { this.selectCount += 1; };

    const writes = [];
    const onClick = installEndpointCopyControl(container, {
      writeText: async (text) => { writes.push(text); },
    });
    assert.equal(typeof onClick, "function");
    await onClick();
    assert.deepEqual(writes, ["https://api.cityscroll.org/mcp"]);

    const fallback = await copyEndpointAddress(input, {
      writeText: async () => { throw new Error("clipboard blocked"); },
    });
    assert.equal(fallback, "fallback");
    assert.ok(input.focusCount >= 1);
    assert.ok(input.selectCount >= 1);

    const unavailable = await copyEndpointAddress(input, { writeText: undefined });
    assert.equal(unavailable, "fallback");
    assert.ok(input.selectCount >= 2);
  });
});

test("A6: retained capture manifest anchors viewport-witnessed renders and a source-tied revision", async () => {
  const manifest = JSON.parse(await readFile(CAPTURE_MANIFEST, "utf8"));
  await withPinnedClock(manifest.capture_clock, async () => {
    assert.equal(manifest.schema, "cityscroll.assistant_setup_capture_manifest.v2");
    assert.equal(manifest.image_binaries_committed, false);
    assert.equal(manifest.capture_mode, "headless-playwright-loopback-static-render");
    assert.equal(manifest.captures.length, 6);
    assert.deepEqual(
      ASSISTANT_SETUP_VIEWPORTS.map((item) => item.viewport).sort(),
      ["1440x1000", "390x844"],
    );

    const expectedRevision = await contentRevision();
    assert.equal(manifest.revision, expectedRevision, "manifest revision must track setup sources");

    const viewports = new Set(manifest.captures.map((capture) => capture.viewport));
    assert.deepEqual([...viewports].sort(), ["1440x1000", "390x844"]);
    const routes = new Set(manifest.captures.map((capture) => capture.route));
    assert.deepEqual([...routes].sort(), ["/", "/api.html#mcp", "/use-with-ai/"]);
    assert.equal(ASSISTANT_SETUP_CAPTURE_ROUTES.length, 3);

    for (const capture of manifest.captures) {
      assert.match(capture.sha256, /^[a-f0-9]{64}$/, capture.route);
      assert.notEqual(capture.sha256, "local-headless-capture", capture.route);
      assert.equal(capture.revision, expectedRevision, capture.route);
      assert.equal(capture.data_vintage, manifest.data_vintage, capture.route);
      assert.ok(capture.assertion.length > 20, capture.route);
      assert.equal(capture.observed.inner_width, capture.viewport_width, capture.route);
      assert.equal(capture.observed.horizontal_overflow, false, capture.route);
      assert.equal(capture.source_sha256, digest(await readFile(new URL(`../${capture.source_path}`, import.meta.url), "utf8")));
      assert.equal(capture.sha256, witnessDigest(capture), `${capture.route} ${capture.viewport}`);

      const html = await readFile(new URL(`../${capture.source_path}`, import.meta.url), "utf8");
      assertionHolds(capture.route, html);
    }

    for (const route of routes) {
      const digests = new Set(
        manifest.captures.filter((capture) => capture.route === route).map((capture) => capture.sha256),
      );
      assert.equal(digests.size, 2, `${route} must witness distinct desktop and mobile hashes`);
    }

    const intro = manifest.captures.find((capture) => capture.route === "/use-with-ai/" && capture.viewport === "390x844");
    assert.equal(intro.observed.copy_clipboard_write, "https://api.cityscroll.org/mcp");
    assert.ok(intro.observed.copy_fallback.focus_count >= 1);
    assert.ok(intro.observed.copy_fallback.select_count >= 1);
    assert.equal(intro.observed.translated.translated_label_visible, true);
    assert.equal(intro.observed.configured_success.tool, "get_notice");
    assert.deepEqual(intro.observed.configured_success.arguments, { request_id: "20260824035" });
    assert.equal(intro.observed.configured_success.public_notice_id, "20260824035");
    assert.equal(intro.observed.unconfigured_refusal.cityscroll_page_reads, 0);
    assert.equal(intro.observed.unconfigured_refusal.guessed_rest_requests, 0);
    assert.equal(intro.observed.unconfigured_refusal.watch_calls, 0);
    assert.equal(intro.observed.unconfigured_refusal.emails, 0);
    assert.equal(intro.observed.browser_get_recovery.expected_status, 405);
    assert.deepEqual(
      intro.observed.setup_order.map((entry) => entry.id),
      ["connect-first", "connect", "claude-web", "claude", "other", "data-ai-context-mount"],
    );
    assert.ok(intro.observed.setup_order.every((entry, index, entries) => (
      index === 0 || entry.index > entries[index - 1].index
    )));

    const translated = renderAskWithAiLink({ translate: (value) => (value === "Ask with AI" ? "Preguntar con IA" : value) });
    assert.match(translated, /Preguntar con IA/);
    assert.doesNotMatch(translated, /Ask with AI/);
  });
});

test("A5: retained served-site manifest identifies production captures and deployed build", async () => {
  const manifest = JSON.parse(await readFile(PRODUCTION_CAPTURE_MANIFEST, "utf8"));
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.base, "https://cityscroll.org/");
  assert.equal(manifest.capture_mode, "headless-playwright-production-served-site");
  assert.equal(manifest.revision_format, "served artifact-manifest source_commit_sha");
  assert.match(manifest.revision, /^[a-f0-9]{40}$/);
  assert.match(manifest.data_vintage, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(manifest.image_binaries_committed, false);
  assert.equal(manifest.captures.length, 6);

  const routes = new Set(manifest.captures.map((capture) => capture.route));
  assert.deepEqual([...routes].sort(), ["/", "/api.html#mcp", "/use-with-ai/"]);
  const viewports = new Set(manifest.captures.map((capture) => `${capture.viewport.width}x${capture.viewport.height}`));
  assert.deepEqual([...viewports].sort(), ["1440x1000", "390x844"]);
  for (const capture of manifest.captures) {
    assert.ok(capture.assertion.length > 20, capture.route);
    assert.match(capture.render_sha256, /^[a-f0-9]{64}$/, capture.route);
  }
});

test("A6: capture harness re-renders both viewports against the retained manifest", async (t) => {
  await access(fileURLToPath(CAPTURE_SCRIPT), fsConstants.R_OK);
  if (!pythonPlaywrightImportable()) {
    t.skip("Python playwright is not importable in this lane");
    return;
  }
  const manifest = JSON.parse(await readFile(CAPTURE_MANIFEST, "utf8"));
  await withPinnedClock(manifest.capture_clock, async () => {
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => (
        key !== "CITYSCROLL_TEST_TIME_SHIFT_DAYS" && key !== "CITYSCROLL_TEST_TIME_PIN"
      )),
    );
    childEnv.CITYSCROLL_TEST_TIME_PIN = manifest.capture_clock;
    try {
      const { stdout, stderr } = await execFileAsync("python3", [fileURLToPath(CAPTURE_SCRIPT), "--verify-only"], {
        cwd: repoRoot,
        env: childEnv,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 120_000,
      });
      const output = `${stdout}\n${stderr}`;
      assert.match(output, /OK assistant-setup capture manifest verifies at both viewports/);
      assert.doesNotMatch(output, /^FAIL /m);
    } catch (error) {
      const output = `${error?.stdout || ""}\n${error?.stderr || ""}`.trim();
      throw new Error(`${error?.message || error}\n${output}`.trim());
    }
  });
});

test("A1: discovery contract states requirements and censes every published page family", () => {
  for (const key of ["task", "eligibility", "placement", "exact_context", "recovery", "evidence"]) {
    assert.equal(typeof DISCOVERY_REQUIREMENTS[key], "string");
    assert.ok(DISCOVERY_REQUIREMENTS[key].length > 20, key);
  }
  assert.equal(INTRODUCTION_FAMILY.path, GENERIC_AI_INTRODUCTION_PATH);
  assert.equal(INTRODUCTION_FAMILY.disposition, "introduction");

  const published = publishedSurfaceIds();
  const result = validateDiscoveryContract({
    publishedSurfaceIds: published,
    mcpToolNames: mcpToolNames(),
    chromeSource: read("site/civic_document_chrome.mjs"),
    analyticsSource: read("site/analytics.js"),
    renderOwnerSources: discoveryRenderOwnerSources(),
  });
  assert.equal(result.contract_id, DISCOVERY_CONTRACT_ID);
  assert.deepEqual(result.problems, [], result.problems.join("\n"));
  assert.equal(result.ok, true);
  assert.equal(pageFamilySurfaceIds().sort().join(","), published.slice().sort().join(","));
  assert.equal(PAGE_FAMILY_DISCOVERY.filter((row) => row.disposition === "justified_omission").length, 0);
});

test("A1: the published route-family census, not a hand-picked sample, owns every entry", () => {
  const manifest = JSON.parse(read("site/data/performance-classification-manifest.v1.json"));
  const census = pageFamilyCensusFromPublishedSurfaces(manifest.surfaces);
  assert.equal(census.length, manifest.surfaces.length);
  assert.equal(census.some((row) => row.census_declaration_missing), false, "every published family needs a declaration");

  const standalone = census.filter((row) => row.disposition === "standalone_link");
  assert.ok(standalone.some((row) => row.surface_id === "home"));
  assert.ok(standalone.some((row) => row.surface_id === "about"));
  assert.ok(standalone.some((row) => row.surface_id === "api-guide"));
  assert.ok(standalone.some((row) => row.surface_id === "public-stats"));
  assert.ok(census.some((row) => row.surface_id === "guide"));
  for (const family of standalone) {
    const source = read(family.render_owner);
    assert.match(source, /use-with-ai\//, family.surface_id);
    assert.match(source, /Ask with AI/, family.surface_id);
  }

  const inherited = census.filter((row) => row.disposition === "inherited_chrome");
  assert.ok(inherited.length > 0, "the census must include generated document families");
  assert.match(read("site/civic_document_chrome.mjs"), /renderAskWithAiLink/);
  const mast = renderCivicDocumentMast({ current: "guide" });
  assert.equal((mast.match(/class="ask-with-ai-link"/g) || []).length, 1, "shared chrome mounts one secondary Ask with AI entry");
  for (const family of census) {
    if (family.disposition === "justified_omission") {
      assert.ok(family.omission_reason, family.surface_id);
      continue;
    }
    assert.ok(family.ai_entry, family.surface_id);
    assert.ok(family.render_owner, family.surface_id);
  }
});

test("A2: topology-style discovery checks reject unknown bindings and dangling guides", () => {
  const healthy = validateDiscoveryContract({ mcpToolNames: mcpToolNames() });
  assert.equal(healthy.ok, true, healthy.problems.join("\n"));

  const matrixByName = new Map(CAPABILITY_DISCOVERY_MATRIX.map((row) => [row[0], row]));
  assert.equal(matrixByName.size, CAPABILITY_TASK_BINDINGS.length);
  for (const binding of CAPABILITY_TASK_BINDINGS) {
    const row = matrixByName.get(binding.name);
    assert.ok(row, binding.name);
    assert.equal(row[1], binding.task, binding.name);
    assert.equal(row[3], binding.render_owner, binding.name);
    assert.ok(CAPABILITY_TASK_DISPOSITIONS.includes(row[4]), `${binding.name}: disposition`);
    assert.equal(row[5], binding.placement, binding.name);
    assert.ok(discoveryRenderOwnerSources()[binding.render_owner], binding.name);
  }

  const home = read("site/index.html");
  assert.equal((home.match(/<form\s+class="home-topic-form"/g) || []).length, 1, "homepage keeps one primary topic search");
  assert.ok(home.indexOf('class="home-topic-form"') < home.indexOf("Ask with AI"), "assistant entry remains secondary to search");
  assert.match(read("site/notice_reader_presentation.mjs"), /<details[^>]+notice-more-tools/, "record tools remain folded");

  const unknown = validateDiscoveryContract({
    mcpToolNames: mcpToolNames(),
    taskBindings: CAPABILITY_TASK_BINDINGS.map((row) => (
      row.name === "MCP" ? { ...row, mcp_tools: ["not_registered_tool"] } : row
    )),
  });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.problems.some((problem) => problem.includes("unknown MCP binding")));

  const dangling = validateDiscoveryContract({
    mcpToolNames: mcpToolNames(),
    taskBindings: CAPABILITY_TASK_BINDINGS.map((row) => (
      row.name === "Evidence" ? { ...row, guide_topic: "no-such-guide" } : row
    )),
  });
  assert.equal(dangling.ok, false);
  assert.ok(dangling.problems.some((problem) => problem.includes("dangling guide topic")));

  const missingOwner = validateDiscoveryContract({
    mcpToolNames: mcpToolNames(),
    pageFamilies: PAGE_FAMILY_DISCOVERY.map((row) => (
      row.surface_id === "notice" ? { ...row, render_owner: "" } : row
    )),
  });
  assert.equal(missingOwner.ok, false);
  assert.ok(missingOwner.problems.some((problem) => problem.includes("absent render owner")));

  const unmapped = validateDiscoveryContract({
    mcpToolNames: mcpToolNames(),
    taskBindings: CAPABILITY_TASK_BINDINGS.map((row) => (
      row.name === "Calendar" ? { ...row, placement: "row_toolbar" } : row
    )),
  });
  assert.equal(unmapped.ok, false);
  assert.ok(unmapped.problems.some((problem) => problem.includes("unsupported task mapping for Calendar: row_toolbar")));
});

test("A2 negative: remove, duplicate, and drop-scope mutations fail behaviorally", () => {
  const removed = validateMutatedDiscovery("remove_required_entry", { mcpToolNames: mcpToolNames() });
  assert.equal(removed.ok, false);
  assert.ok(removed.problems.some((problem) => problem.includes("published surface missing discovery census: home")));
  assert.match(read("site/index.html"), /use-with-ai/);

  const duplicated = validateMutatedDiscovery("duplicate_control", { mcpToolNames: mcpToolNames() });
  assert.equal(duplicated.ok, false);
  assert.ok(duplicated.problems.some((problem) => problem.includes("duplicate page family: home")));

  const dropped = validateMutatedDiscovery("drop_scope");
  assert.equal(dropped.ok, false);
  assert.ok(dropped.problems.some((problem) => problem.includes("dangling guide topic")));
  assert.ok(dropped.problems.some((problem) => problem.includes("unknown MCP binding")));
});

test("A2 negative: an unsupported task mapping fails on its own named problem", () => {
  const healthy = validateDiscoveryContract({ mcpToolNames: mcpToolNames() });
  assert.equal(healthy.ok, true, healthy.problems.join("\n"));

  const mapped = validateMutatedDiscovery("unsupported_task_mapping");
  assert.equal(mapped.ok, false);
  assert.ok(
    mapped.problems.some((problem) => problem.includes("unsupported task mapping for Calendar: row_toolbar")),
    mapped.problems.join("\n"),
  );
  // Control against passing for the wrong reason: the mutation changes only
  // the placement field, so the failure must be the mapping rejection itself —
  // not the binding, guide, and owner problems the other mutations already
  // cover recycling back in.
  assert.equal(mapped.problems.some((problem) => problem.includes("unknown MCP binding")), false, mapped.problems.join("\n"));
  assert.equal(mapped.problems.some((problem) => problem.includes("dangling guide topic")), false, mapped.problems.join("\n"));
  assert.equal(mapped.problems.some((problem) => problem.includes("absent render owner")), false, mapped.problems.join("\n"));
  // And the shipped Calendar binding still carries a supported placement, so
  // the named problem can only come from the mutation path.
  const calendar = CAPABILITY_TASK_BINDINGS.find((row) => row.name === "Calendar");
  assert.ok(CAPABILITY_TASK_PLACEMENTS.includes(calendar.placement));
  for (const binding of CAPABILITY_TASK_BINDINGS) {
    assert.ok(CAPABILITY_TASK_PLACEMENTS.includes(binding.placement), binding.name);
  }
});

test("A6: hosted-client compatibility evidence labels unverified one-click claims", () => {
  const evidence = JSON.parse(read("docs/evidence/assistant-discovery-live-proof/hosted-client-compatibility.json"));
  assert.equal(evidence.schema, "cityscroll.hosted_client_compatibility_evidence.v1");
  assert.equal(evidence.public_introduction, GENERIC_AI_INTRODUCTION_PATH);
  assert.ok(Array.isArray(evidence.claims));
  assert.ok(evidence.claims.length >= 2);
  for (const claim of evidence.claims) {
    assert.equal(claim.one_click_verified_in_hosted_client, false);
    assert.ok(["manual_instructions_only", "protocol_verified_unauthenticated"].includes(claim.compatibility_status));
  }
  for (const banned of [
    "fabricated_login_or_session_success",
    "user_interview_as_shipping_gate",
    "real_watch_creation_during_checks",
    "broad_cloudflare_protection_weakening_for_canary",
  ]) {
    assert.ok(evidence.forbidden_claims.includes(banned), banned);
  }
});

test("A5: live-proof capture manifest retains named soft-depend skips and condition cases", () => {
  const manifest = JSON.parse(read("docs/evidence/assistant-discovery-live-proof/capture-manifest.json"));
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.surface, "assistant discovery live proof");
  assert.equal(manifest.image_binaries_committed, false);
  assert.match(String(manifest.revision || ""), /^[0-9a-f]{40}$/);
  assert.ok(String(manifest.base || "").includes("cityscroll.org"));
  assert.match(String(manifest.condition || ""), /translated/i);
  assert.match(String(manifest.condition || ""), /no-JavaScript|no-javascript/i);
  assert.match(String(manifest.condition || ""), /failed-enhancement/i);
  const cases = new Set((manifest.captures || []).map((row) => row.case));
  for (const required of [
    "discovery-translated",
    "discovery-no-javascript",
    "discovery-failed-enhancement",
  ]) {
    assert.ok(cases.has(required), required);
  }
  assert.ok(Array.isArray(manifest.skips));
  assert.ok(manifest.skips.length >= 1);
  const named = manifest.skips.find((row) => row.name === "contextual AI handoff control");
  assert.ok(named, "expected named soft-depend skip for contextual AI handoff control");
  assert.match(String(named.reason || ""), /soft-depend/i);
  for (const capture of manifest.captures) {
    assert.equal(capture.passed, true, capture.case);
    assert.match(String(capture.render_sha256 || ""), /^[0-9a-f]{64}$/);
    assert.ok(capture.viewport && capture.viewport.width && capture.viewport.height, capture.case);
  }
});

test("A3: discovery reuses affordance roles and keeps analytics bounded", () => {
  for (const binding of CAPABILITY_TASK_BINDINGS) {
    assert.ok(Object.values(AFFORDANCE_ACTION_ROLES).includes(binding.action_role), binding.name);
    if (!binding.requires_mcp) {
      assert.ok(binding.render_owner.startsWith("site/") || binding.render_owner.startsWith("capabilities/"), binding.name);
    }
  }
  const analytics = read("site/analytics.js");
  for (const banned of PRIVATE_DISCOVERY_BANLIST) {
    assert.doesNotMatch(analytics, new RegExp(`discovery[^\\n]{0,80}${banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  }
  assert.doesNotMatch(analytics, /mcp[_-]?connected|assistant[_-]?connected|completed[_-]?external[_-]?connection/);
  assert.doesNotMatch(analytics, /retrieve_cited_passages|CT\d{12}|@gmail\./);
  for (const event of DISCOVERY_ANALYTICS_ALLOWLIST) {
    assert.equal(typeof event, "string");
  }
  const intro = read("site/use-with-ai/index.html");
  for (const banned of ["Desk capability", "/admin/", "watch-management token"]) {
    assert.doesNotMatch(intro, new RegExp(banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("A4: public projection refuses private Desk text, credential-bearing URLs, and script-only navigation", () => {
  const projectionPaths = [
    "site/index.html",
    "site/use-with-ai/index.html",
    "site/about.html",
    "site/api.html",
    "site/stats.html",
    "site/guide/index.html",
  ];
  const credentialAddress = /(?:[?&](?:key|token|secret|password|credential|authorization)=|Bearer\s+[A-Za-z0-9._-]+|\/admin\/)/i;
  for (const path of projectionPaths) {
    const html = read(path);
    for (const banned of PRIVATE_DISCOVERY_BANLIST) {
      const escaped = banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = banned === "Desk" ? `\\b${escaped}\\b` : escaped;
      assert.doesNotMatch(html, new RegExp(pattern, "i"), `${path}: ${banned}`);
    }
    assert.doesNotMatch(html, credentialAddress, `${path}: credential-bearing address`);
    assert.doesNotMatch(html, /href\s*=\s*["']javascript:/i, `${path}: javascript navigation`);
  }

  const chrome = read("site/civic_document_chrome.mjs");
  assert.match(chrome, /renderAskWithAiLink\(\{\s*translate\s*\}/);
  assert.doesNotMatch(chrome, /renderAskWithAiLink\([\s\S]{0,240}target=/);
  assert.doesNotMatch(chrome, /renderAskWithAiLink\([\s\S]{0,240}external/);
  assert.match(read("site/guide/es/index.html"), /href="\/use-with-ai\/\?lang=es"/);
  assert.match(read("site/guide/es/index.html"), /class="ask-with-ai-link"/);
});

/*
 * Soft-depend on sibling surfaces that may still be open.
 * Follow has landed on main; research and contextual handoff still bind only
 * when present. This card does not ship stand-in suites for those siblings.
 */

test("soft-depend: follow discovery, when present, covers censused product surfaces without MCP", async (t) => {
  for (const name of ["Follow", "Calendar", "Feeds"]) {
    const binding = CAPABILITY_TASK_BINDINGS.find((row) => row.name === name);
    assert.ok(binding, name);
    assert.equal(binding.requires_mcp, false, name);
  }
  assert.ok(GUIDE_HELP.following);
  assert.ok(GUIDE_HELP.calendar);
  for (const surfaceId of ["search", "browse", "browse-meetings", "now", "near-you", "following"]) {
    const family = PAGE_FAMILY_DISCOVERY.find((row) => row.surface_id === surfaceId);
    assert.ok(family, surfaceId);
    assert.notEqual(family.disposition, "justified_omission", surfaceId);
  }

  const mod = await importIfPresent("site/follow_discovery.mjs");
  if (!mod) {
    t.skip("site/follow_discovery.mjs not on this tree; sibling surface soft-depend");
    return;
  }
  assert.ok(Array.isArray(mod.FOLLOW_DISCOVERY_SURFACE_MATRIX));
  const surfaces = mod.FOLLOW_DISCOVERY_SURFACE_MATRIX.map((row) => row.surface);
  for (const name of ["search", "browse", "now", "near_you", "following"]) {
    assert.ok(surfaces.includes(name), name);
  }
  assert.equal(typeof mod.projectFollowDiscovery, "function");
  const projection = mod.projectFollowDiscovery({
    surface: "browse",
    scope: { lens: "meetings", agency: "City Planning" },
    lens: "meetings",
    rows: [{ event_date: "2026-09-15T11:00:00.000", title: "Hearing" }],
  });
  assert.equal(projection.creates_subscription_on_open, false);
  assert.ok(Array.isArray(projection.actions));
  assert.ok(projection.actions.length >= 1);
});

test("soft-depend: research discovery, when present, projects eligible tools under More tools", async (t) => {
  for (const name of ["Evidence", "As-of", "Comparative analysis", "Saved searches", "Collection/export"]) {
    const binding = CAPABILITY_TASK_BINDINGS.find((row) => row.name === name);
    assert.ok(binding, name);
    assert.ok(CAPABILITY_TASK_PLACEMENTS.includes(binding.placement), name);
  }
  assert.ok(GUIDE_HELP.connection);
  assert.ok(GUIDE_HELP.asOf);
  assert.ok(GUIDE_HELP.emptyCollection);

  const mod = await importIfPresent("site/research_discovery.mjs");
  if (!mod) {
    t.skip("site/research_discovery.mjs not on this tree; sibling surface soft-depend");
    return;
  }
  assert.ok(mod.RESEARCH_CAPABILITY_FAMILIES);
  assert.equal(typeof mod.projectResearchTools, "function");
  assert.equal(typeof mod.renderMoreToolsRegion, "function");
  const eligible = mod.projectResearchTools({
    surface: "notice",
    evidencePath: "/agencies/parks-and-recreation/",
    evidenceClaimId: "claim-1",
    asOfSupported: true,
    asOfPath: "/agencies/parks-and-recreation/",
    asOfDay: "2026-01-15",
    hasShareHandler: true,
    hasSaveSearchHandler: true,
    hasCollectionHandler: true,
    hasExportHandler: true,
    hasPrintHandler: true,
  });
  assert.ok(eligible.eligible.length >= 1);
  assert.ok(eligible.eligible.every((tool) => tool.href || tool.action));
  const html = mod.renderMoreToolsRegion({ tools: eligible.eligible });
  assert.match(html, new RegExp(mod.MORE_TOOLS_REGION_ATTR || "data-more-tools"));
});

test("soft-depend: contextual AI handoff, when present, keeps public context and recovery", async (t) => {
  for (const surfaceId of ["notice", "meeting", "procurement", "agency", "vendor", "search", "browse"]) {
    const family = PAGE_FAMILY_DISCOVERY.find((row) => row.surface_id === surfaceId);
    assert.ok(family, surfaceId);
    assert.notEqual(family.disposition, "justified_omission", surfaceId);
  }
  assert.equal(INTRODUCTION_FAMILY.path, GENERIC_AI_INTRODUCTION_PATH);

  const mod = await importIfPresent("site/ai_context_handoff.mjs");
  if (!mod) {
    t.skip("site/ai_context_handoff.mjs not on this tree; sibling surface soft-depend");
    return;
  }
  assert.equal(typeof mod.buildAiContextHandoff, "function");
  assert.equal(typeof mod.renderAiContextHandoffLink, "function");
  const contract = mod.buildContractAiContextHandoff?.({
    procurementId: "procurement:contract:CT107120258801626",
    path: "/procurement/CT107120258801626/",
  }) || mod.buildAiContextHandoff({
    kind: "contract",
    procurementId: "procurement:contract:CT107120258801626",
    path: "/procurement/CT107120258801626/",
  });
  assert.ok(contract);
  const serialized = JSON.stringify(contract);
  for (const banned of PRIVATE_DISCOVERY_BANLIST) {
    assert.doesNotMatch(serialized, new RegExp(banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(serialized, /watch-management|session_id|@gmail\./i);
  const href = typeof mod.aiContextHandoffHref === "function"
    ? mod.aiContextHandoffHref(contract)
    : GENERIC_AI_INTRODUCTION_PATH;
  assert.match(href, /use-with-ai/);
  const link = mod.renderAiContextHandoffLink(contract, { translate: (value) => value });
  assert.match(link, /use-with-ai/);
  assert.doesNotMatch(link, /javascript:/i);
});
