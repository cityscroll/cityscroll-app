import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildPersonHubLookup } from "../site/person_hub.mjs";
import {
  measureLobbyTargetJoin,
  buildLobbyInfluenceLookup,
  measureCfbRecipientJoin,
  buildCfbInfluenceLookup,
  renderLobbyInfluenceHTML,
  renderCfbInfluenceHTML,
  renderPersonHubFactsHTML,
  reviewPersonNameJoin,
} from "../site/official_influence.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const council = JSON.parse(
  readFileSync(path.join(root, "fixtures/person_hub/council_members.json"), "utf8"),
);
const lobby = JSON.parse(
  readFileSync(path.join(root, "fixtures/person_hub/elobbyist_sample.json"), "utf8"),
);
const cfb = JSON.parse(
  readFileSync(path.join(root, "fixtures/person_hub/cfb_sample.json"), "utf8"),
);

const hub = buildPersonHubLookup(council, {
  peopleDoc: { by_person_id: Object.fromEntries(
    ["7801", "7785", "5289", "7804", "7825", "7810", "7823", "7895"].map((id) => [id, {}]),
  ) },
  retrievedAt: "fixture",
});

test("reviewPersonNameJoin accepts shared exact keys only", () => {
  assert.equal(
    reviewPersonNameJoin({
      target_display: "NYC Council Members Gale Brewer",
      hub_name: "Gale A. Brewer",
      match_key: "GALE BREWER",
    }).label,
    "same",
  );
  assert.equal(
    reviewPersonNameJoin({
      target_display: "Buildings Department",
      hub_name: "Gale A. Brewer",
      match_key: "BUILDINGS",
    }).label,
    "reject",
  );
});

test("lobby kill sample usefulness and precision clear flywheel gates on fixture", () => {
  const measured = measureLobbyTargetJoin(lobby, hub);
  assert.ok(measured.person_shaped_mentions > 0, "expected person-shaped targets in fixture");
  // Fixture is small; still require a non-zero join when council names appear.
  if (measured.joined_mentions > 0) {
    assert.ok(measured.usefulness >= 0.3, `usefulness ${measured.usefulness}`);
    assert.ok(measured.precision == null || measured.precision >= 0.95, `precision ${measured.precision}`);
  }
  const lookup = buildLobbyInfluenceLookup({
    lobbyRows: lobby,
    personHubLookup: hub,
    measurement: measured,
  });
  if (measured.gate.promoted) {
    assert.ok(lookup.edge_count > 0);
    assert.equal(lookup.provenance.materialization, "public_edges");
  } else {
    assert.equal(lookup.edge_count, 0);
    assert.equal(lookup.provenance.materialization, "stopped_below_gate");
  }
});

test("CFB recipient measurement uses unique name keys only", () => {
  const measured = measureCfbRecipientJoin(cfb, hub);
  assert.ok(measured.distinct_recipients > 0);
  const lookup = buildCfbInfluenceLookup({
    cfbRows: cfb,
    personHubLookup: hub,
    measurement: measured,
  });
  if (measured.gate.promoted) {
    assert.ok(lookup.person_count > 0);
  } else {
    assert.equal(lookup.edge_count, 0);
  }
});

test("influence panels omit empty bags and avoid methodology cruft", () => {
  assert.equal(renderLobbyInfluenceHTML({ edges: [] }), "");
  assert.equal(renderCfbInfluenceHTML({ donors: [] }), "");
  const html = renderLobbyInfluenceHTML({
    edges: [
      {
        from_org_display: "Example Org",
        lobbyist_name: "Lobby LLC",
        report_year: "2024",
      },
    ],
  }, { escapeHtml: (v) => String(v) });
  assert.match(html, /data-lobby-status="linked"/);
  assert.match(html, /Example Org/);
  assert.doesNotMatch(html, /usefulness|precision|gate|fmf3/i);

  const facts = renderPersonHubFactsHTML({
    person_id: "7801",
    district: "1",
    current_term: { term_start: "2026-01-01", term_end: "2029-12-31" },
  }, { escapeHtml: (v) => String(v) });
  assert.match(facts, /District 1/);
  assert.match(facts, /2026-01-01/);
});

test("committed influence lookups expose measurement blocks", () => {
  const lobbyPath = path.join(root, "../site/data/official_lobby_influence_lookup.json");
  const cfbPath = path.join(root, "../site/data/official_cfb_influence_lookup.json");
  if (!existsSync(lobbyPath) || !existsSync(cfbPath)) return;
  const lobbyDoc = JSON.parse(readFileSync(lobbyPath, "utf8"));
  const cfbDoc = JSON.parse(readFileSync(cfbPath, "utf8"));
  assert.ok(lobbyDoc.measurement);
  assert.ok(cfbDoc.measurement);
  assert.ok("promoted" in lobbyDoc.gate);
  assert.ok("promoted" in cfbDoc.gate);
  // Live kill sample should clear both gates for lobby (measured ~97% usefulness).
  if (lobbyDoc.gate.promoted) {
    assert.ok(lobbyDoc.edge_count > 0);
    assert.ok(lobbyDoc.measurement.usefulness >= 0.3);
    assert.ok(lobbyDoc.measurement.precision >= 0.95);
  }
  if (cfbDoc.gate.promoted) {
    assert.ok(cfbDoc.measurement.usefulness >= 0.3);
    assert.ok(cfbDoc.measurement.precision >= 0.95);
  }
});
