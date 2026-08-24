import assert from "node:assert/strict";
import test from "node:test";

import {
  lookupEntityDossierFromD1,
  lookupEntityIntelligenceFromD1,
  resetEntityIntelligenceReadModelCache,
} from "../src/lib/entity_intelligence_read_model.mjs";
import { entityIntelligenceD1 } from "./helpers/entity_intelligence_d1.mjs";

const PARKS = "agency:id:parks-and-recreation";

function miniDoc({ generatedAt = "2026-01-01T00:00:00.000Z", name = "Parks" } = {}) {
  return {
    generated_at: generatedAt,
    observation_count: 1,
    entity_count: 1,
    multi_domain_count: 1,
    by_ref: {
      [PARKS]: {
        root: { kind: "agency", ref: PARKS, display_name: name, canonical_name: name },
        domains: {
          money: { status: "matched", count: 1, objects: [] },
          land: { status: "empty", count: 0, objects: [] },
          property: { status: "empty", count: 0, objects: [] },
          rules: { status: "empty", count: 0, objects: [] },
          meetings: { status: "empty", count: 0, objects: [] },
          people: { status: "empty", count: 0, objects: [] },
          franchise: { status: "empty", count: 0, objects: [] },
        },
        links: [],
        metrics: { domains_matched: 1, link_count: 0 },
      },
    },
    by_subject_ref: {},
  };
}

test("gzip-base64 keyed rows decode to the stored dossier", async () => {
  resetEntityIntelligenceReadModelCache();
  const { sqlite, DB } = entityIntelligenceD1(miniDoc({ name: "Parks gzip" }), { encoding: "gzip-base64" });
  try {
    const dossier = await lookupEntityDossierFromD1(DB, PARKS, { generatedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(dossier.root.display_name, "Parks gzip");
  } finally {
    sqlite.close();
    resetEntityIntelligenceReadModelCache();
  }
});

test("isolate cache hits until the materialization version changes", async () => {
  resetEntityIntelligenceReadModelCache();
  const { sqlite, DB } = entityIntelligenceD1(miniDoc({ name: "Parks original" }));
  try {
    const first = await lookupEntityIntelligenceFromD1(DB, { ref: PARKS });
    assert.equal(first.root.display_name, "Parks original");
    sqlite.prepare(
      "UPDATE entity_intelligence_entities SET payload = ?, payload_encoding = 'json' WHERE entity_ref = ?",
    ).run(JSON.stringify(miniDoc({ name: "Parks mutated" }).by_ref[PARKS]), PARKS);
    const cached = await lookupEntityIntelligenceFromD1(DB, { ref: PARKS });
    assert.equal(cached.root.display_name, "Parks original", "same generated_at must reuse the isolate cache");

    sqlite.prepare("UPDATE entity_intelligence_meta SET generated_at = ? WHERE id = 'current'").run("2026-02-01T00:00:00.000Z");
    sqlite.prepare(
      "UPDATE entity_intelligence_entities SET payload = ?, payload_encoding = 'json' WHERE entity_ref = ?",
    ).run(JSON.stringify(miniDoc({ generatedAt: "2026-02-01T00:00:00.000Z", name: "Parks refreshed" }).by_ref[PARKS]), PARKS);
    const refreshed = await lookupEntityIntelligenceFromD1(DB, { ref: PARKS });
    assert.equal(refreshed.root.display_name, "Parks refreshed");
  } finally {
    sqlite.close();
    resetEntityIntelligenceReadModelCache();
  }
});

test("missing refs are materialization_miss, not a corpus fallback", async () => {
  resetEntityIntelligenceReadModelCache();
  const { sqlite, DB } = entityIntelligenceD1(miniDoc());
  try {
    const miss = await lookupEntityIntelligenceFromD1(DB, {
      kind: "vendor",
      name: "Completely Unknown Vendor XYZ Inc",
    });
    assert.equal(miss.ok, true);
    assert.equal(miss.serve, "materialization_miss");
    assert.equal(miss.metrics.link_count, 0);
  } finally {
    sqlite.close();
    resetEntityIntelligenceReadModelCache();
  }
});
