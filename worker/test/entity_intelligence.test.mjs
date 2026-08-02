/**
 * Worker entity-intelligence route + materialization serve path.
 *
 * verify:
 *   node --test worker/test/entity_intelligence.test.mjs
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleEntityIntelligence, getEntityIntelligenceMaterialization } from "../src/entity_intelligence.mjs";
import { lookupEntityIntelligence } from "../../entity_resolution/cross_domain/index.mjs";

function req(path, headers = {}) {
  return new Request(`https://cityscroll.org${path}`, {
    method: "GET",
    headers: { Accept: "application/json", ...headers },
  });
}

describe("GET /entity-intelligence", () => {
  it("serves demo Parks multi-domain view with provenance", async () => {
    const res = await handleEntityIntelligence(req("/entity-intelligence?demo=1"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.demo, true);
    assert.equal(body.root.ref, "agency:id:parks-and-recreation");
    assert.ok(body.metrics.domains_matched >= 3);
    assert.equal(body.domains.money.status, "matched");
    assert.equal(body.domains.land.status, "matched");
    assert.equal(body.domains.people.status, "not_yet_ingested");
    assert.ok(body.links.every((l) => l.provenance?.source_system));
  });

  it("resolves agency by name and by id", async () => {
    const byName = await handleEntityIntelligence(
      req("/entity-intelligence?kind=agency&name=Department%20of%20Parks%20and%20Recreation"),
    );
    const byId = await handleEntityIntelligence(
      req("/entity-intelligence?kind=agency&id=parks-and-recreation"),
    );
    assert.equal(byName.status, 200);
    assert.equal(byId.status, 200);
    const a = await byName.json();
    const b = await byId.json();
    assert.equal(a.root.ref, b.root.ref);
    assert.equal(a.root.ref, "agency:id:parks-and-recreation");
  });

  it("lists multi-domain entities", async () => {
    const res = await handleEntityIntelligence(req("/entity-intelligence?list=1"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.multi_domain_count >= 1);
    assert.ok(Array.isArray(body.entities));
    assert.ok(body.entities.some((e) => e.ref === "agency:id:parks-and-recreation"));
  });

  it("400 on missing query; 400 on unresolved root", async () => {
    const missing = await handleEntityIntelligence(req("/entity-intelligence"));
    assert.equal(missing.status, 400);
    // Empty kind without name
    const bad = await handleEntityIntelligence(req("/entity-intelligence?kind=agency"));
    assert.equal(bad.status, 400);
  });

  it("materialization miss is honest empty (not fabricated)", async () => {
    const mat = getEntityIntelligenceMaterialization();
    const miss = lookupEntityIntelligence(mat, {
      kind: "vendor",
      name: "Completely Unknown Vendor XYZ Inc",
    });
    assert.equal(miss.ok, true);
    assert.equal(miss.serve, "materialization_miss");
    assert.equal(miss.metrics.link_count, 0);
    assert.equal(miss.domains.money.count, 0);
  });
});
