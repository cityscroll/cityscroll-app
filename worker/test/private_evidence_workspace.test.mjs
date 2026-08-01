import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  handleAdminPossiblySame,
  renderInvestigationWorkspacePage,
} from "../src/admin.mjs";
import {
  INVESTIGATION_WORKSPACE_VERSION,
  buildInvestigationWorkspace,
} from "../../entity_resolution/review/index.mjs";

function side(id, name, source, amount) {
  return {
    id,
    name,
    source,
    source_record_key: id.split(":")[1],
    source_url: `https://example.test/${source}/${id.split(":")[1]}`,
    observed_at: "2026-08-01T12:00:00.000Z",
    observed_fields: { vendor_name: name, contract_amount: amount },
  };
}

function conflict(left, right) {
  return {
    assertion_interpretation: {
      conflicts: [{
        fact: "contract_amount",
        label: "Contract amount",
        kind: "amount",
        assertions: [left, right].map((record) => ({
          classification: "source_assertion",
          source_system: record.source,
          source_system_id: record.source_record_key,
          source_record_id: record.id,
          source_url: record.source_url,
          source_field: "contract_amount",
          value: record.observed_fields.contract_amount,
          recorded_at: record.observed_at,
        })),
        interpretation: {
          classification: "cityscroll_interpretation",
          status: "conflict",
          resolution: "unresolved",
          summary: "The publisher values differ; neither is selected.",
        },
      }],
    },
  };
}

const cityRecord = side("city_record:notice-1:hash-a", "Acme Construction LLC", "city_record", "$100");
const checkbook = side("checkbook:contract-1:hash-b", "Acme Builders Inc", "checkbook", "$125");
const passport = side("passport:vendor-1:hash-c", "Builders Group LLC", "passport", "$150");
const reviewItems = [
  {
    id: "pair-a",
    entity_type: "vendor",
    method: "token_v0",
    matcher_version: "token_v0_v0",
    left: cityRecord,
    right: checkbook,
    evidence: { shared_keys: ["tok:ACME"], ...conflict(cityRecord, checkbook) },
  },
  {
    id: "pair-b",
    entity_type: "vendor",
    method: "token_v0",
    matcher_version: "token_v0_v0",
    left: checkbook,
    right: passport,
    evidence: { shared_keys: ["tok:BUILDERS"], ...conflict(checkbook, passport) },
  },
];

test("connected candidate evidence becomes separate multi-source rails", () => {
  const workspace = buildInvestigationWorkspace("pair-a", reviewItems);
  assert.equal(workspace.version, INVESTIGATION_WORKSPACE_VERSION);
  assert.deepEqual(workspace.scope, {
    candidate_pairs: 2,
    source_rails: 3,
    source_records: 3,
    note: "This case contains connected review leads only. It does not establish identity or select a canonical assertion.",
  });
  assert.deepEqual(workspace.sources.map((rail) => rail.source), ["checkbook", "city_record", "passport"]);
  assert.equal(workspace.sources.flatMap((rail) => rail.records).length, 3);
  assert.equal(workspace.assertions[0].assertions.length, 3);
  assert.equal(workspace.assertions[0].interpretations.length, 2);
  assert.ok(workspace.assertions[0].interpretations.every((entry) => entry.resolution === "unresolved"));
  assert.equal(buildInvestigationWorkspace("missing", reviewItems), null);
});

test("private workspace renderer keeps assertions and interpretations visibly separate", () => {
  const html = renderInvestigationWorkspacePage(
    buildInvestigationWorkspace("pair-a", reviewItems),
    { "pair-a": [], "pair-b": [] },
    "https://worker.test/admin/possibly-same?key=secret&pair=pair-a",
  );
  assert.match(html, /Authenticated desk/);
  assert.match(html, /3 source rails/);
  assert.match(html, /Publisher evidence rails/);
  assert.match(html, /city_record/);
  assert.match(html, /checkbook/);
  assert.match(html, /passport/);
  assert.match(html, /Source assertion/);
  assert.match(html, /CityScroll interpretation/);
  assert.match(html, /Conflict · unresolved/);
  assert.match(html, /does not change entity links or source assertions/);
  assert.doesNotMatch(html, /selected canonical/i);
});

function d1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...args) {
          return {
            async all() { return { results: statement.all(...args) }; },
            async run() { return statement.run(...args); },
          };
        },
      };
    },
  };
}

function routeFixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of ["0008_source_records.sql", "0009_entity_link.sql", "0010_false_split_disposition.sql"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const insert = sqlite.prepare(
    `INSERT INTO source_records
       (source_system, source_system_id, content_hash, raw_snapshot, normalized_snapshot, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  insert.run("city_record", "notice-1", "hash-a", JSON.stringify({ contract_amount: "$100" }), JSON.stringify({ vendor_name: "Acme Construction LLC" }), now);
  insert.run("checkbook", "contract-1", "hash-b", JSON.stringify({ contract_amount: "$125" }), JSON.stringify({ vendor_name: "Acme Builders Inc" }), now);
  insert.run("passport", "vendor-1", "hash-c", JSON.stringify({ contract_amount: "$150" }), JSON.stringify({ vendor_name: "Builders Group LLC" }), now);
  return { sqlite, env: { ADMIN_KEY: "secret", DB: d1(sqlite) } };
}

test("workspace route is desk-authenticated and has a private JSON representation", async () => {
  const { sqlite, env } = routeFixture();
  try {
    const trayResponse = await handleAdminPossiblySame(new Request(
      "https://worker.test/admin/possibly-same?key=secret",
      { headers: { Accept: "application/json" } },
    ), env);
    const tray = await trayResponse.json();
    const pairId = tray.items[0].id;
    const workspaceUrl = `https://worker.test/admin/possibly-same?pair=${encodeURIComponent(pairId)}`;
    assert.equal((await handleAdminPossiblySame(new Request(workspaceUrl), env)).status, 401);

    const response = await handleAdminPossiblySame(new Request(
      `${workspaceUrl}&key=secret`,
      { headers: { Accept: "application/json" } },
    ), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.workspace.version, INVESTIGATION_WORKSPACE_VERSION);
    assert.equal(body.workspace.scope.source_rails, 3);
    assert.deepEqual(Object.keys(body.dispositions).sort(), body.workspace.comparisons.map((item) => item.id).sort());

    const missing = await handleAdminPossiblySame(new Request(
      "https://worker.test/admin/possibly-same?pair=missing&key=secret",
      { headers: { Accept: "application/json" } },
    ), env);
    assert.equal(missing.status, 404);
  } finally {
    sqlite.close();
  }
});
