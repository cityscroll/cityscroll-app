/**
 * Desk navigation and access boundary.
 *
 * The repair queue is a THIRD view on a desk that already had two. That makes
 * two things worth holding still. The first is navigation: the new view has to
 * join the existing toggle rather than replace it, the graph has to stay the
 * desk's home, and every view the toggle names has to exist. The second is the
 * boundary the desk inherits rather than declares — the artifact is derived,
 * untracked and never served, the Worker bundle never reaches it, and nothing
 * it renders is a link only its author can open.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

import {
  DATA_SOURCE_GRAPH_SCHEMA_VERSION,
  DESK_CONSUMER_CONTRACT_PATH,
  HTML_OUTPUT,
  JSON_OUTPUT,
  ROOT,
  generatedGraphFiles,
} from "../tools/data_source_graph.mjs";
import { REPAIR_QUEUE_SCHEMA, REPAIR_QUEUE_STATES } from "../tools/repair_queue.mjs";

const files = generatedGraphFiles();
const html = files[HTML_OUTPUT];
const graph = JSON.parse(files[JSON_OUTPUT]);

/** The desk's view toggle, as the document declares it. */
const VIEWS = [
  { toggle: "graphToggle", section: "graphView", label: "Graph view", home: true },
  { toggle: "tableToggle", section: "tableView", label: "Table view", home: false },
  { toggle: "repairToggle", section: "repairView", label: "Repair queue", home: false },
];

test("the desk keeps one view toggle and the repair queue joins it", () => {
  const toggles = [...html.matchAll(/<button id="(\w+Toggle)" type="button" aria-pressed="(true|false)">([^<]+)<\/button>/g)]
    .map(([, id, pressed, label]) => ({ id, pressed, label }));
  assert.equal(toggles.length, VIEWS.length, "one toggle per view, and no second navigation");
  assert.deepEqual(toggles.map((row) => row.id), VIEWS.map((row) => row.toggle));
  assert.deepEqual(toggles.map((row) => row.label), VIEWS.map((row) => row.label));
  // Exactly one view is pressed on load, and it is the graph the desk opened
  // with before this view existed.
  assert.deepEqual(toggles.map((row) => row.pressed === "true"), VIEWS.map((row) => row.home));
  assert.equal([...html.matchAll(/aria-pressed="true"/g)].length, 1);
});

test("every named view exists, and only the home view is visible on load", () => {
  for (const view of VIEWS) {
    assert.ok(html.includes(`id="${view.section}"`), `${view.section} must exist for its toggle`);
    const section = html.slice(html.indexOf(`id="${view.section}"`));
    const openTag = section.slice(0, section.indexOf(">"));
    assert.equal(/\bhidden\b/.test(openTag), !view.home, `${view.section} default visibility`);
  }
  // The switch names the same three views the toggle does, so a toggle can
  // never point at a section that was renamed or removed.
  const switching = html.match(/const views=\{([^}]+)\}/);
  assert.ok(switching, "the view switch is present");
  for (const view of VIEWS) assert.ok(switching[1].includes(view.section), `${view.section} is switchable`);
});

test("the existing graph and table views are unchanged in kind", () => {
  assert.match(html, /<svg id="sourceGraph" role="group" aria-label="Data source topology graph">/);
  assert.match(html, /<aside class="details" id="details" aria-live="polite">/);
  assert.match(html, /<th>Source<\/th><th>Collecting body<\/th>/);
  const rows = [...html.matchAll(/data-source-row="/g)];
  assert.equal(rows.length, graph.sources.length, "every source still has a table row");
});

test("the repair view is a labelled region with one expandable row per issue", () => {
  assert.match(html, /<section class="repair-view" id="repairView" hidden aria-labelledby="repairHeading">/);
  assert.match(html, /<h2 id="repairHeading">Repair queue<\/h2>/);
  const issues = [...html.matchAll(/<details class="queue-issue"[^>]*data-repair-issue="([a-f0-9]{64})"/g)].map(([, key]) => key);
  assert.equal(issues.length, graph.repair_queue.issues.length);
  assert.deepEqual(issues, graph.repair_queue.issues.map((issue) => issue.issue_key));
  // Detail is inside the disclosure, not behind a script: the grouped rows work
  // with the keyboard and for assistive technology before anything runs.
  for (const issue of graph.repair_queue.issues) {
    assert.ok(html.includes(`data-repair-state="${issue.state}"`));
    assert.ok(html.includes(`>${issue.affected_scopes} affected scope`) || issue.affected_scopes === 0);
  }
});

test("filtering reaches the repair view from the desk's existing search box", () => {
  assert.match(html, /function filterRepairQueue\(\)/);
  assert.match(html, /function filterTable\(\)\{[^}]*filterRepairQueue\(\)/);
  assert.match(html, /repairState\.addEventListener\("change",filterRepairQueue\)/);
  assert.match(html, /<label for="repairState">Filter by state<\/label>/);
  assert.match(html, /<select id="repairState">/);
  for (const state of REPAIR_QUEUE_STATES) assert.ok(html.includes(`<option value="${state}">`), `${state} is filterable`);
  // The rows carry the haystack the shared box searches, so one control filters
  // both the source table and the queue.
  for (const issue of graph.repair_queue.issues) {
    const row = html.slice(html.indexOf(`data-repair-issue="${issue.issue_key}"`));
    const attributes = row.slice(0, row.indexOf(">"));
    assert.match(attributes, /data-search="/);
    assert.ok(attributes.includes(issue.identity.condition), "the condition is searchable");
  }
});

test("the desk renders no link that only its author can open", () => {
  for (const marker of [["backstage", "://"].join(""), "file://", "/Users/", "/var/folders/", "/private/tmp", "http://localhost", "127.0.0.1"]) {
    assert.ok(!html.includes(marker), `the desk document must not carry ${marker}`);
  }
  const repair = html.slice(html.indexOf('id="repairView"'), html.indexOf("</section>", html.indexOf('id="repairView"')));
  for (const [, href] of repair.matchAll(/href="([^"]+)"/g)) {
    assert.match(href, /^https:\/\//, "an outward link from the repair view is a stable public URL");
  }
});

test("the desk artifact stays derived, untracked and outside the served tree", () => {
  const ignored = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n").map((line) => line.trim());
  for (const output of [`docs/${JSON_OUTPUT}`, `docs/${HTML_OUTPUT}`]) {
    assert.ok(ignored.includes(output), `${output} must stay untracked`);
  }
  // The desk is not part of the site. Nothing under the served tree imports the
  // queue or its observation contract.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "data") walk(path);
        continue;
      }
      if (!/\.(mjs|js|html)$/.test(entry)) continue;
      const text = readFileSync(path, "utf8");
      if (text.includes("repair_queue.mjs") || text.includes("repair_observations.mjs")) {
        offenders.push(relative(ROOT, path));
      }
    }
  };
  walk(join(ROOT, "site"));
  assert.deepEqual(offenders, [], "the served tree must not reach the operator queue");
});

test("the Worker bundle never reaches the repair queue", () => {
  const entry = join(ROOT, "worker/src/worker.mjs");
  const seen = new Set();
  const reached = [];
  const resolveLocal = (importer, specifier) => {
    if (!specifier.startsWith(".")) return null;
    const base = resolve(dirname(importer), specifier);
    for (const candidate of [base, `${base}.mjs`, `${base}.js`, `${base}.json`, join(base, "index.mjs")]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  };
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (/tools\/repair_(queue|observations)\.mjs$/.test(file)) reached.push(relative(ROOT, file));
    for (const match of readFileSync(file, "utf8").matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      const dependency = resolveLocal(file, match[1]);
      if (dependency && dependency.endsWith(".mjs")) visit(dependency);
    }
  };
  visit(entry);
  assert.deepEqual(reached, [], "the operator queue is a build-time read model, not a served one");
});

test("the desk consumer contract stays in lockstep with the producer", () => {
  const contract = JSON.parse(readFileSync(join(ROOT, DESK_CONSUMER_CONTRACT_PATH), "utf8"));
  assert.equal(DATA_SOURCE_GRAPH_SCHEMA_VERSION, 4);
  assert.equal(graph.schema_version, DATA_SOURCE_GRAPH_SCHEMA_VERSION);
  assert.equal(contract.producer_schema_version, DATA_SOURCE_GRAPH_SCHEMA_VERSION);
  assert.ok(contract.supported_consumer_versions.includes(DATA_SOURCE_GRAPH_SCHEMA_VERSION));
  assert.equal(graph.extensions.repair_observations, contract.extensions.repair_observations.version);
  assert.equal(graph.extensions.repair_queue, contract.extensions.repair_queue.version);
  assert.ok(contract.extensions.repair_observations.graph_fields.includes("repair_observations"));
  assert.ok(contract.extensions.repair_queue.graph_fields.includes("repair_queue"));
  assert.equal(contract.extensions.repair_queue.queue_schema, REPAIR_QUEUE_SCHEMA);
  assert.deepEqual(contract.extensions.repair_queue.states, [...REPAIR_QUEUE_STATES]);
  assert.deepEqual(contract.extensions.repair_queue.status_values, ["available", "unavailable"]);
  assert.equal(graph.repair_queue.schema, REPAIR_QUEUE_SCHEMA);
  assert.equal(graph.repair_observations.schema, "cityscroll.repair_observation_set.v1");
});
