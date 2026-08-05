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
  it("serves demo with people matched when person-level votes are productized", async () => {
    const res = await handleEntityIntelligence(req("/entity-intelligence?demo=1"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.demo, true);
    assert.ok(body.root?.ref);
    assert.ok(body.metrics.domains_matched >= 2);
    // People domain is live: demo must include ≥1 official object (City Council field case).
    assert.equal(body.domains.people.status, "matched");
    assert.ok(body.domains.people.count >= 1);
    assert.ok(
      (body.domains.people.objects || []).some(
        (o) => o.subject_ref === "entity:official:7801" || /official:\d+/.test(o.subject_ref || ""),
      ),
    );
    assert.ok(body.links.every((l) => l.provenance?.source_system));
  });

  it("City Council people domain is matched; Parks remains multi-domain without inventing people", async () => {
    const councilRes = await handleEntityIntelligence(
      req("/entity-intelligence?kind=agency&name=City%20Council"),
    );
    assert.equal(councilRes.status, 200);
    const council = await councilRes.json();
    assert.equal(council.domains.people.status, "matched");
    assert.ok(council.domains.people.count >= 1);

    const parksRes = await handleEntityIntelligence(
      req("/entity-intelligence?kind=agency&name=Department%20of%20Parks%20and%20Recreation"),
    );
    assert.equal(parksRes.status, 200);
    const parks = await parksRes.json();
    assert.equal(parks.root.ref, "agency:id:parks-and-recreation");
    assert.ok(parks.metrics.domains_matched >= 3);
    assert.equal(parks.domains.money.status, "matched");
    assert.doesNotMatch(JSON.stringify(parks), /FIX\d|FIXZAP|FIXTURE VENDOR/);
    // Parks has no person-vote rows — empty, not permanent not_yet_ingested theater.
    assert.equal(parks.domains.people.status, "empty");
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

  it("serves confidence-safe connection metadata and materialization coverage framing", async () => {
    const res = await handleEntityIntelligence(
      req("/entity-intelligence?kind=agency&name=Housing%20Preservation%20and%20Development"),
    );
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.root.ref, "agency:id:housing-preservation-and-development");
    assert.equal(body.metrics.domains_matched, 5);
    assert.equal(body.coverage.eligible, null);
    assert.equal(body.coverage.linked, 18);
    assert.equal(body.coverage.rate, null);
    assert.match(body.coverage.vintage, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.domains.land.strong_count, 0);
    assert.equal(body.domains.land.tentative_count, 2);
    assert.ok(body.domains.money.strong_count > 0);

    const connections = Object.values(body.domains)
      .flatMap((domain) => domain.objects || [])
      .flatMap((object) => object.connected_entities || []);
    assert.ok(connections.some((connection) => connection.entity_ref.startsWith("vendor:stem:")));
    assert.ok(connections.every((connection) => ["strong", "tentative"].includes(connection.confidence)));
    assert.ok(connections.every((connection) => connection.confidence !== "weak"));
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

  it("attaches build-derived vendor coverage even when the bounded graph has no dossier", async () => {
    const res = await handleEntityIntelligence(
      req("/entity-intelligence?kind=vendor&name=CAMBA"),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.root.ref, "vendor:stem:CAMBA");
    assert.equal(body.vendor_footprint.qualifier_required, true);
    assert.ok(body.vendor_footprint.award_coverage.eligible > 0);
    assert.match(
      body.vendor_footprint.award_coverage.label,
      /^showing \d+ of \d+ known awards linked so far \([\d.]+%\)$/,
    );
    assert.deepEqual(body.vendor_footprint.excluded_confidence, [
      "tentative",
      "review_only",
      "not_scored",
    ]);
  });
});
