/**
 * The determinism contract for shipped site modules.
 *
 *   node --test test/site_production_determinism.test.mjs
 *
 * `tools/audit-test-clocks.mjs` watches test authors, and the check-mode
 * determinism lint walks outward from required `--check` commands. Neither one
 * can see a module that only the public site loads, so a production clock read
 * could be added and pass both. These tests pin the scope that closes that:
 * an inventory of everything site/ ships, an ambient-clock and implicit
 * local-time rule over it, and the narrow ways a real clock stays legal.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  SITE_INVENTORY_PATH,
  SITE_INVENTORY_SCHEMA,
  analyzeSiteSource,
  buildSiteInventory,
  discoverSiteModules,
  lintSiteProduction,
} from "../tools/determinism_lint.mjs";
import { findUninjectedClockAdditions } from "../tools/audit-test-clocks.mjs";
import { isolatedGitEnv } from "../tools/architecture_evidence_shards.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOL = path.join(ROOT, "tools", "determinism_lint.mjs");

/*
 * Fixture sources below describe ambient clock reads, they do not perform them.
 * `tools/audit-test-clocks.mjs` scans added test lines textually, so the reads
 * are spelled through these tokens rather than written out — the same idiom
 * `test/determinism_lint.test.mjs` already uses.
 */
const NEW_DATE = `new ${"Date"}()`;
const DATE_NOW = `Date.${"now"}()`;

function findings(source, filePath = "site/probe.mjs") {
  return analyzeSiteSource({ root: "/repo", filePath: `/repo/${filePath}`, source });
}

function categories(source, filePath) {
  return findings(source, filePath).map((finding) => finding.category);
}

/** A throwaway repository holding only a site tree and its inventory. */
function siteRepo(modules, { inventory = null, thirdParty = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "cityscroll-site-determinism-"));
  for (const [relative, contents] of Object.entries(modules)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  const declared = inventory ?? Object.keys(modules).filter((entry) => !thirdParty.some((row) => row.path === entry));
  mkdirSync(path.join(root, path.dirname(SITE_INVENTORY_PATH)), { recursive: true });
  writeFileSync(
    path.join(root, SITE_INVENTORY_PATH),
    `${JSON.stringify({ schema: SITE_INVENTORY_SCHEMA, modules: declared, third_party: thirdParty }, null, 2)}\n`,
  );
  return root;
}

test("A1 the committed inventory covers every JavaScript module site/ ships", () => {
  const report = lintSiteProduction({ root: ROOT });
  assert.deepEqual(report.issues, [], report.issues.join("\n"));

  const inventory = JSON.parse(readFileSync(path.join(ROOT, SITE_INVENTORY_PATH), "utf8"));
  assert.equal(inventory.schema, SITE_INVENTORY_SCHEMA);
  const declared = new Set([...inventory.modules, ...inventory.third_party.map((entry) => entry.path)]);
  for (const module of discoverSiteModules({ root: ROOT })) {
    assert.ok(declared.has(module), `${module} ships from site/ but is not inventoried`);
  }
  // The two surfaces the card names explicitly: app controllers and the
  // site-owned helpers they import.
  assert.ok(inventory.modules.includes("site/app/core.mjs"));
  assert.ok(inventory.modules.includes("site/app/money-list.mjs"));
  assert.ok(inventory.modules.includes("site/pages_edge.mjs"));
  assert.ok(inventory.modules.length > 400, `only ${inventory.modules.length} modules inventoried`);
  // Anything held outside the scan is named one path at a time, with a reason.
  for (const entry of inventory.third_party) {
    assert.match(entry.path, /^site\//);
    assert.ok(String(entry.reason || "").trim().length > 20, `${entry.path} has no recorded reason`);
  }
});

test("A1 a newly added covered site module cannot stay outside the scan", () => {
  const root = siteRepo({ "site/known.mjs": "export const KNOWN = true;\n" });
  try {
    assert.deepEqual(lintSiteProduction({ root }).issues, []);

    writeFileSync(path.join(root, "site/added.mjs"), `export const day = () => ${NEW_DATE};\n`);
    const withAddition = lintSiteProduction({ root });
    assert.equal(withAddition.findings.length, 0, "an uninventoried module must not be silently scanned");
    assert.ok(
      withAddition.issues.some((issue) => issue.startsWith("site/added.mjs ships from site/")),
      withAddition.issues.join("\n"),
    );

    // Inventorying it is the only way to make the omission go away, and doing so
    // brings its clock read into the scan.
    const rebuilt = buildSiteInventory({ root });
    writeFileSync(path.join(root, SITE_INVENTORY_PATH), `${JSON.stringify(rebuilt, null, 2)}\n`);
    const inventoried = lintSiteProduction({ root });
    assert.deepEqual(inventoried.issues, []);
    assert.deepEqual(inventoried.findings.map((finding) => [finding.path, finding.category]), [["site/added.mjs", "clock"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A1 the inventory cannot name a module the site no longer ships", () => {
  const root = siteRepo({ "site/known.mjs": "export const KNOWN = true;\n" }, {
    inventory: ["site/known.mjs", "site/deleted.mjs"],
  });
  try {
    assert.ok(
      lintSiteProduction({ root }).issues.some((issue) => issue.includes("site/deleted.mjs")),
      "a stale inventory entry must be reported",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A1 a module held outside the scan needs a recorded reason", () => {
  const root = siteRepo({ "site/vendored.mjs": `export const t = ${DATE_NOW};\n` }, {
    inventory: [],
    thirdParty: [{ path: "site/vendored.mjs" }],
  });
  try {
    const report = lintSiteProduction({ root });
    assert.equal(report.findings.length, 0);
    assert.ok(report.issues.some((issue) => issue.includes("no recorded reason")), report.issues.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A1 a reduced working copy still covers a module it did not materialise", () => {
  // Card work runs in a sparse checkout, where a tracked module can be absent
  // from disk. Coverage must follow what ships, not what this clone happens to
  // hold, or the reduced profile becomes a way to hide a production clock.
  const root = mkdtempSync(path.join(tmpdir(), "cityscroll-site-reduced-"));
  // Stripped Git bindings, not inherited ones: `tools/git-hooks/pre-push` runs
  // this suite with GIT_DIR exported, and an inherited binding would send this
  // fixture's `add -A` and `commit` to the repository being pushed.
  const git = (...args) => spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: isolatedGitEnv(),
  });
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    mkdirSync(path.join(root, "site"), { recursive: true });
    writeFileSync(path.join(root, "site/present.mjs"), "export const PRESENT = true;\n");
    writeFileSync(path.join(root, "site/omitted.mjs"), `export const stamp = () => ${DATE_NOW};\n`);
    mkdirSync(path.join(root, path.dirname(SITE_INVENTORY_PATH)), { recursive: true });
    writeFileSync(
      path.join(root, SITE_INVENTORY_PATH),
      `${JSON.stringify(buildSiteInventory({ root }), null, 2)}\n`,
    );
    git("add", "-A");
    const committed = git("commit", "-qm", "site");
    assert.equal(committed.status, 0, committed.stderr);

    rmSync(path.join(root, "site/omitted.mjs"));
    assert.ok(discoverSiteModules({ root }).includes("site/omitted.mjs"), "a tracked module must stay inventoried");

    const report = lintSiteProduction({ root });
    assert.deepEqual(report.issues, [], report.issues.join("\n"));
    assert.deepEqual(report.unmaterialised, ["site/omitted.mjs"]);
    assert.deepEqual(report.findings.map((finding) => [finding.path, finding.category]), [["site/omitted.mjs", "clock"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A2 rejects ambient current-time reads with file, line, category and remediation", () => {
  const source = [
    "export function openToday(rows) {",
    "  const stamp = " + DATE_NOW + ";",
    "  const day = " + NEW_DATE + ";",
    "  const instant = Temporal.Now.instant();",
    "  return [rows, stamp, day, instant];",
    "}",
  ].join("\n");
  const reported = findings(source, "site/app/probe.mjs");
  assert.deepEqual(reported.map((finding) => [finding.category, finding.line]), [
    ["clock", 2], ["clock", 3], ["clock", 4],
  ]);
  for (const finding of reported) {
    assert.equal(finding.path, "site/app/probe.mjs");
    assert.ok(finding.source.length > 0);
    assert.match(finding.remediation, /take the instant from the caller|determinism-lint: allow clock/);
  }
});

test("A2 rejects implicit local-time reads and accepts explicit zones", () => {
  assert.deepEqual(categories("export const d = (v) => new Date(v).getHours();"), ["timezone"]);
  assert.deepEqual(categories("export const d = (v) => new Date(v).getTimezoneOffset();"), ["timezone"]);
  assert.deepEqual(categories('export const d = (v) => new Date(v).toLocaleDateString("en-US");'), ["timezone"]);
  assert.deepEqual(
    categories('export const d = (v) => new Intl.DateTimeFormat("en-US", { day: "numeric" }).format(v);'),
    ["timezone"],
  );

  assert.deepEqual(categories("export const d = (v) => new Date(v).getUTCHours();"), []);
  assert.deepEqual(
    categories('export const d = (v) => new Date(v).toLocaleDateString("en-US", { timeZone: "America/New_York" });'),
    [],
  );
  assert.deepEqual(
    categories('export const d = (v) => new Date(v).toLocaleString("en-US", { day: "numeric", timeZone: "UTC" });'),
    [],
  );
  // Number and currency formatting share the method name and are not a clock.
  assert.deepEqual(categories('export const m = (v) => Number(v).toLocaleString("en-US");'), []);
  assert.deepEqual(
    categories('export const m = (v) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });'),
    [],
  );
});

test("A2 leaves fixed-date parsing and Date.UTC alone", () => {
  const source = [
    'export const CHARTER = new Date("2019-11-05T00:00:00Z");',
    "export const FY = Date.UTC(2026, 6, 1);",
    'export const parse = (v) => Date.parse(`${String(v).slice(0, 10)}T00:00:00Z`);',
    'export const noon = (day) => new Date(`${day}T12:00:00Z`);',
  ].join("\n");
  assert.deepEqual(findings(source), []);
});

test("A2 accepts a clock the caller supplies at the boundary", () => {
  const source = [
    "export function openOn(rows, today = " + NEW_DATE + ".toISOString().slice(0, 10)) {",
    "  return rows.filter((row) => row.due_date > today);",
    "}",
    "export function floorFor({ asOf } = {}) {",
    "  const day = asOf || " + NEW_DATE + ".toISOString().slice(0, 10);",
    "  return `${day}T00:00:00Z`;",
    "}",
    "export function ageOf(row, now) {",
    "  const instant = row.observed_at ?? now ?? " + DATE_NOW + ";",
    "  return Number(instant);",
    "}",
    "export function stampedAt(options) {",
    "  const retrievedAt =",
    "    (options && options.retrieved_at)",
    "    || " + NEW_DATE + ".toISOString();",
    "  return retrievedAt;",
    "}",
  ].join("\n");
  assert.deepEqual(findings(source), []);
});

test("A2 an unsupplied read stays a finding even beside a clock parameter", () => {
  const source = [
    "export function ageOf(row, now) {",
    "  const measured = " + DATE_NOW + ";",
    "  return measured - Number(now);",
    "}",
  ].join("\n");
  assert.deepEqual(findings(source).map((finding) => [finding.category, finding.line]), [["clock", 2]]);
});

test("A2 an annotation alone is not an injected clock", () => {
  const claimed = [
    "export function todayISO() {",
    "  // determinism-lint: inject clock the caller passes the day in.",
    "  return " + NEW_DATE + ".toISOString().slice(0, 10);",
    "}",
  ].join("\n");
  const [claim] = findings(claimed);
  assert.equal(claim.category, "clock");
  assert.equal(claim.line, 3);
  assert.match(claim.remediation, /requires the instant to arrive from the caller/);

  // A reasoned allowance is the reviewed way to keep a deliberate clock.
  const declared = [
    "export function exportName(lens) {",
    "  // determinism-lint: allow clock the filename records the day the reader exported the file.",
    "  return `${lens}-${" + NEW_DATE + ".toISOString().slice(0, 10)}.csv`;",
    "}",
  ].join("\n");
  assert.deepEqual(findings(declared), []);

  // An annotation with no reason declares nothing.
  const bare = [
    "export function exportName(lens) {",
    "  // determinism-lint: allow clock",
    "  return `${lens}-${" + NEW_DATE + ".toISOString().slice(0, 10)}.csv`;",
    "}",
  ].join("\n");
  assert.deepEqual(findings(bare).map((finding) => finding.category), ["clock"]);

  // A declaration answers for one category only.
  const wrongCategory = [
    "// determinism-lint: allow timezone the reader's own zone is intended here.",
    "export const stamp = () => " + DATE_NOW + ";",
  ].join("\n");
  assert.deepEqual(findings(wrongCategory).map((finding) => finding.category), ["clock"]);
});

test("A2 the browser-harness day pin is not production clock injection", () => {
  // `CROL_PINNED_TODAY` is set by browser checks and never by the shipped
  // product, so the production arm of this expression is still the real clock.
  const source = [
    "const pinnedTodayISO = () => globalThis.CROL_PINNED_TODAY || null;",
    `const todayISO = () => (pinnedTodayISO() || ${NEW_DATE}.toISOString().slice(0,10)) + "T00:00:00";`,
  ].join("\n");
  assert.deepEqual(findings(source).map((finding) => [finding.category, finding.line]), [["clock", 2]]);

  // The seam as it actually landed still carries its own reasoned declaration.
  const core = readFileSync(path.join(ROOT, "site/app/core.mjs"), "utf8");
  assert.match(core, /globalThis\.CROL_PINNED_TODAY/, "core.mjs no longer reads the harness pin");
  assert.match(core, /determinism-lint: allow clock this is the civic day itself/);
  assert.doesNotMatch(core, /CROL_PINNED_TODAY\s*=/, "a shipped module must never set the harness pin");
});

test("A3 the test-clock auditor stays test-scoped and does not stand in for site coverage", () => {
  const clockLine = `const day = ${NEW_DATE};`;
  const diffFor = (file) => ["diff --git a/x b/x", `+++ b/${file}`, "@@ -0,0 +1 @@", `+${clockLine}`].join("\n");

  // The auditor sees a new test clock, which is what it exists for.
  assert.deepEqual(
    findUninjectedClockAdditions(diffFor("test/example.test.mjs")).map((finding) => finding.path),
    ["test/example.test.mjs"],
  );
  // It is deliberately blind to the product, so it can never be read as
  // production coverage. The site scope is what covers the same line there.
  assert.deepEqual(findUninjectedClockAdditions(diffFor("site/app/example.mjs")), []);
  assert.deepEqual(
    findings(clockLine, "site/app/example.mjs").map((finding) => finding.category),
    ["clock"],
  );

  const audit = spawnSync(process.execPath, [path.join(ROOT, "tools/audit-test-clocks.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(audit.status, 0, audit.stderr);
});

test("A4 the required static-standards check runs the production site scope", () => {
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const events = workflow.match(/^on:\n(?:[ \t].*\n)+/m)?.[0] || "";
  assert.match(events, /pull_request:/);
  assert.match(events, /merge_group:/);
  const step = workflow.match(/- name: Check-mode determinism lint\n(?:.*\n)*?(?=\n? {6}- name: )/)?.[0] || "";
  assert.match(step, /if: matrix\.family == 'static-standards'/);
  assert.match(step, /node tools\/determinism_lint\.mjs --check\n/);

  const preflight = readFileSync(path.join(ROOT, "tools/preflight-required-checks.sh"), "utf8");
  assert.match(preflight, /node tools\/determinism_lint\.mjs --check/);
});

test("A4 the site scope is not scoped to changed files and reports its coverage", () => {
  const tool = readFileSync(TOOL, "utf8");
  // The gate traversal is changed-file scoped; the site scope must not be, or
  // a branch that touches nothing under site/ would skip the whole product.
  assert.match(tool, /report\.site = lintSiteProduction\(\{ root \}\);/);
  assert.doesNotMatch(tool, /lintSiteProduction\(\{[^}]*changedOnly/);

  const result = spawnSync(process.execPath, [TOOL, "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /production site modules covered/);
  const covered = Number(result.stdout.match(/(\d+) production site modules covered/)?.[1]);
  const inventory = JSON.parse(readFileSync(path.join(ROOT, SITE_INVENTORY_PATH), "utf8"));
  assert.equal(covered, inventory.modules.length, "the run must cover the whole inventory");
  assert.equal(covered, discoverSiteModules({ root: ROOT }).length - inventory.third_party.length);
});

test("A4 a new production clock turns the required check red end to end", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "cityscroll-site-gate-"));
  const repo = path.join(fixture, "repo");
  try {
    mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(
      path.join(repo, ".github", "workflows", "required.yml"),
      ["name: required", "on:", "  pull_request:", "jobs:", "  gate:", "    steps:", "      - run: node tools/gate.mjs --check", ""].join("\n"),
    );
    mkdirSync(path.join(repo, "tools"), { recursive: true });
    writeFileSync(path.join(repo, "tools", "gate.mjs"), "export const gate = () => true;\n");
    mkdirSync(path.join(repo, "site", "app"), { recursive: true });
    writeFileSync(path.join(repo, "site", "app", "list.mjs"), "export const openOn = (rows, today) => rows.filter((r) => r.due > today);\n");
    mkdirSync(path.join(repo, "architecture"), { recursive: true });
    writeFileSync(
      path.join(repo, SITE_INVENTORY_PATH),
      `${JSON.stringify(buildSiteInventory({ root: repo }), null, 2)}\n`,
    );

    const green = spawnSync(process.execPath, [TOOL, "--write-receipt", "--fixture", fixture], { cwd: ROOT, encoding: "utf8" });
    assert.equal(green.status, 0, green.stderr);
    const clean = spawnSync(process.execPath, [TOOL, "--check", "--fixture", fixture], { cwd: ROOT, encoding: "utf8" });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /1 production site modules covered/);

    // The change a reviewer must not be able to miss.
    writeFileSync(
      path.join(repo, "site", "app", "list.mjs"),
      `export const openOn = (rows) => rows.filter((r) => r.due > ${NEW_DATE}.toISOString().slice(0, 10));\n`,
    );
    const red = spawnSync(process.execPath, [TOOL, "--check", "--fixture", fixture], { cwd: ROOT, encoding: "utf8" });
    assert.equal(red.status, 1, red.stdout);
    assert.match(red.stderr, /determinism lint fixture receipt drifted/);

    const report = lintSiteProduction({ root: repo });
    assert.deepEqual(report.findings.map((finding) => [finding.path, finding.line, finding.category]), [
      ["site/app/list.mjs", 1, "clock"],
    ]);
    assert.match(report.findings[0].remediation, /determinism-lint: allow clock/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("A4 a missing or malformed inventory fails rather than skipping the scan", () => {
  const root = siteRepo({ "site/known.mjs": `export const stamp = () => ${DATE_NOW};\n` });
  try {
    rmSync(path.join(root, SITE_INVENTORY_PATH));
    const missing = lintSiteProduction({ root });
    assert.equal(missing.findings.length, 0);
    assert.ok(missing.issues.some((issue) => issue.includes("is missing")), missing.issues.join("\n"));

    writeFileSync(path.join(root, SITE_INVENTORY_PATH), "{ not json\n");
    const malformed = lintSiteProduction({ root });
    assert.ok(malformed.issues.some((issue) => issue.includes("not a valid")), malformed.issues.join("\n"));

    writeFileSync(path.join(root, SITE_INVENTORY_PATH), `${JSON.stringify({ schema: "other", modules: [] })}\n`);
    assert.ok(lintSiteProduction({ root }).issues.some((issue) => issue.includes("not a valid")));
  } finally {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});
