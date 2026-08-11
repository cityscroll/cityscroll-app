// Person hub (uvw5-9znb) + lobby/CFB influence gates.
//
//   node --test test/person_hub.test.mjs test/official_influence.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildPersonHubLookup,
  personHubForId,
  PERSON_HUB_SOURCE,
} from "../site/person_hub.mjs";
import { personNameKeys, resolvePersonName, buildPersonNameIndex } from "../entity_resolution/officials/person_name.mjs";
import { parseLobbyTargets, isPersonShapedLobbyTarget } from "../entity_resolution/officials/lobby_targets.mjs";
import { orgKey, consolidateOrgKeys } from "../entity_resolution/officials/org_resolve.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(root, "fixtures/person_hub/council_members.json"), "utf8"),
);
const votesPath = path.join(root, "../site/data/person_votes_lookup.json");
const hubPath = path.join(root, "../site/data/person_hub_lookup.json");

test("personNameKeys folds accents and CFB last-first order", () => {
  const keys = personNameKeys("Alexa Avilés");
  assert.ok(keys.includes("ALEXA AVILES") || keys.some((k) => k.includes("AVILES")));
  const cfb = personNameKeys("Marte, Christopher");
  assert.ok(cfb.some((k) => k === "CHRISTOPHER MARTE" || k.endsWith("MARTE")));
});

test("parseLobbyTargets strips district noise from Council Member lines", () => {
  const targets = parseLobbyTargets(
    "NYC Council Members Gale Brewer - District No. 6; NYC Council Members Simcha Felder - District No. 44",
  );
  assert.equal(targets.length, 2);
  assert.equal(targets[0].key, "GALE BREWER");
  assert.ok(isPersonShapedLobbyTarget(targets[0].display));
});

test("orgKey + consolidate merges acronym expansions conservatively", () => {
  assert.equal(orgKey("St. Vincent's Services Inc."), "ST VINCENTS SERVICES");
  const { canon, merges } = consolidateOrgKeys([
    "IBM",
    "INTERNATIONAL BUSINESS MACHINES",
    "PARKCHESTER NORTH",
    "PARKCHESTER SOUTH",
  ]);
  assert.equal(canon.get("IBM"), "INTERNATIONAL BUSINESS MACHINES");
  assert.ok(merges.some((m) => m.merged === "IBM"));
  // Discriminating North/South must not merge.
  assert.equal(canon.get("PARKCHESTER NORTH"), "PARKCHESTER NORTH");
  assert.equal(canon.get("PARKCHESTER SOUTH"), "PARKCHESTER SOUTH");
});

test("buildPersonHubLookup stamps Marte/Louis PersonIds and districts", () => {
  const votes = existsSync(votesPath)
    ? JSON.parse(readFileSync(votesPath, "utf8"))
    : { by_person_id: { "7801": {}, "7785": {} } };
  const hub = buildPersonHubLookup(fixture, { peopleDoc: votes, retrievedAt: "fixture" });
  assert.equal(hub.source_contract, PERSON_HUB_SOURCE);
  const marte = personHubForId(hub, "7801");
  const louis = personHubForId(hub, "7785");
  assert.ok(marte, "7801 present");
  assert.ok(louis, "7785 present");
  assert.match(marte.person_name, /Marte/i);
  assert.match(louis.person_name, /Louis/i);
  assert.equal(marte.district, "1");
  assert.equal(louis.district, "45");
  assert.equal(marte.official_id, "official:7801");
  assert.equal(hub.gate.demo_person_id_pass, true);
  assert.equal(hub.gate.promoted, true);
});

test("name index resolves lobby-style targets uniquely", () => {
  const hub = buildPersonHubLookup(fixture, {
    peopleDoc: { by_person_id: { "7801": {}, "5289": {} } },
  });
  const index = buildPersonNameIndex(
    Object.values(hub.by_person_id).map((p) => ({
      person_id: p.person_id,
      person_name: p.person_name,
    })),
  );
  const felder = resolvePersonName("Simcha Felder", index);
  assert.equal(felder?.person_id, "5289");
  const marte = resolvePersonName("Christopher Marte", index);
  assert.equal(marte?.person_id, "7801");
});

test("committed person_hub_lookup includes demos when present", () => {
  if (!existsSync(hubPath)) {
    // Fixture-only environments may skip the live materialization.
    return;
  }
  const hub = JSON.parse(readFileSync(hubPath, "utf8"));
  assert.ok(hub.person_count >= 50);
  assert.ok(hub.by_person_id["7801"]);
  assert.ok(hub.by_person_id["7785"]);
  assert.equal(hub.gate.promoted, true);
  if (hub.join.vote_corpus_person_ids > 0) {
    assert.ok(hub.join.vote_corpus_join_rate >= 0.3);
  }
});
