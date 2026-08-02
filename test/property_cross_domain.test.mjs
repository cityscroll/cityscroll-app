/**
 * Property cross-domain joins: BBL → ZAP, owner → contracts, agency roots.
 *
 * verify:
 *   node --test test/property_cross_domain.test.mjs test/property_phase_spine.test.mjs
 *   node tools/build_property_cross_domain.mjs --check
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  observationFromPropertyRow,
  extractDispositionOwner,
  normalizeBbl,
  bblSubjectRef,
  joinPropertyToZapByBbl,
  joinPropertyOwnerToContracts,
  buildParcelIntelligence,
  buildPropertyCrossDomainDoc,
  linkObservation,
  buildEntityIntelligence,
  observationFromMoneyRow,
  CROSS_DOMAIN_DOMAINS,
} from "../entity_resolution/cross_domain/index.mjs";
import { formatSubjectRef } from "../worker/src/lib/subject_registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(
  readFileSync(join(ROOT, "worker/test/fixtures/property-cross-domain/corpus.json"), "utf8"),
);

describe("property observation + owner extract", () => {
  it("normalizes BBL and shapes parcel subject_ref", () => {
    assert.equal(normalizeBbl("1006440001"), "1006440001");
    assert.equal(normalizeBbl("1-00644-0001"), "1006440001");
    assert.equal(normalizeBbl("short"), null);
    assert.equal(bblSubjectRef("1006440001"), "bbl:1006440001");
    assert.equal(formatSubjectRef("bbl", "1006440001"), "bbl:1006440001");
  });

  it("extracts labeled winning bidder only — not bare titles", () => {
    const owner = extractDispositionOwner({
      short_title: "Notice of tentative winning bidders",
      additional_description_1: "The property has been sold to Make it Zesty LLC for $275,000.",
    });
    assert.equal(owner.name, "Make it Zesty LLC");
    assert.equal(owner.basis, "sold_to");
    assert.equal(
      extractDispositionOwner({ short_title: "REQUEST FOR PROPOSALS - INDUSTRY ROAD" }),
      null,
    );
  });

  it("observationFromPropertyRow carries BBLs and owner", () => {
    const row = corpus.property_rows.find((r) => r.request_id === "20241112003");
    const obs = observationFromPropertyRow(row);
    assert.equal(obs.domain, "property");
    assert.equal(obs.primary_bbl, "1006440001");
    assert.equal(obs.vendor_name, "Make it Zesty LLC");
    assert.equal(obs.subject_ref, "notice:20241112003");
  });
});

describe("BBL → ZAP exact join", () => {
  it("links property notice to ZAP project on exact BBL 1006440001", () => {
    const propertyObs = corpus.property_rows.map((r) => observationFromPropertyRow(r)).filter(Boolean);
    const { links, by_bbl, metrics } = joinPropertyToZapByBbl(
      propertyObs,
      corpus.zap_bbl_rows,
      corpus.zap_projects,
    );
    assert.ok(metrics.matched_bbl_count >= 2);
    assert.equal(by_bbl["1006440001"].status, "matched");
    assert.ok(by_bbl["1006440001"].land_projects.some((p) => p.project_id === "2022M0258"));
    const edge = links.find(
      (l) => l.type === "parcel_links_project" && l.from === "notice:20241112003",
    );
    assert.ok(edge);
    assert.equal(edge.to, "project:2022M0258");
    assert.equal(edge.provenance.source_system, "zap-bbl");
    assert.ok(edge.provenance.source_record_id.includes("1006440001"));
  });

  it("does not invent a ZAP hit for Industry Road without zap-bbl row", () => {
    const propertyObs = corpus.property_rows.map((r) => observationFromPropertyRow(r)).filter(Boolean);
    // Drop 3044440001 from zap rows
    const zap = corpus.zap_bbl_rows.filter((r) => r.bbl !== "3044440001");
    const { by_bbl } = joinPropertyToZapByBbl(propertyObs, zap, corpus.zap_projects);
    // Industry Road notice still contributes the BBL with no_zap_match or empty land
    const intel = buildParcelIntelligence("3044440001", {
      propertyRows: corpus.property_rows,
      zapBblRows: zap,
      zapProjects: corpus.zap_projects,
      moneyRows: corpus.money_rows,
    });
    assert.equal(intel.land.status, "empty");
    assert.equal(intel.land.count, 0);
    assert.match(intel.land.note || "", /No ZAP project/i);
  });
});

describe("owner → contracts via vendorStem", () => {
  it("joins Make it Zesty owner to Parks money award", () => {
    const propertyObs = corpus.property_rows.map((r) => observationFromPropertyRow(r)).filter(Boolean);
    const { by_owner, metrics, links } = joinPropertyOwnerToContracts(
      propertyObs,
      corpus.money_rows,
    );
    assert.ok(metrics.owners_with_contracts >= 1);
    const stem = Object.keys(by_owner).find((s) => /zesty/i.test(s) || by_owner[s].display_name?.includes("Zesty"));
    assert.ok(stem);
    assert.equal(by_owner[stem].status, "matched");
    assert.ok(by_owner[stem].contracts.some((c) => c.request_id === "FIXZESTY1"));
    assert.ok(links.every((l) => l.provenance?.source_system));
  });
});

describe("parcel intelligence + entity property domain", () => {
  it("buildParcelIntelligence for real BBL 1006440001", () => {
    const view = buildParcelIntelligence("1006440001", {
      propertyRows: corpus.property_rows,
      zapBblRows: corpus.zap_bbl_rows,
      zapProjects: corpus.zap_projects,
      moneyRows: corpus.money_rows,
    });
    assert.equal(view.ok, true);
    assert.equal(view.bbl, "1006440001");
    assert.equal(view.property.status, "matched");
    assert.equal(view.land.status, "matched");
    assert.ok(view.owners.count >= 1);
    assert.ok(view.owners.items[0].contracts.length >= 1);
  });

  it("entity intelligence includes property domain for Parks and HPD", () => {
    assert.ok(CROSS_DOMAIN_DOMAINS.includes("property"));
    const propertyObs = corpus.property_rows.map((r) => observationFromPropertyRow(r)).filter(Boolean);
    const moneyObs = corpus.money_rows.map((r) => observationFromMoneyRow(r)).filter(Boolean);
    const parks = buildEntityIntelligence(
      { kind: "agency", name: "Department of Parks and Recreation" },
      [...propertyObs, ...moneyObs],
    );
    assert.equal(parks.ok, true);
    assert.equal(parks.domains.property.status, "matched");
    assert.ok(parks.domains.property.count >= 1);
    assert.ok(parks.links.every((l) => l.provenance?.source_record_id));

    const hpd = buildEntityIntelligence(
      { kind: "agency", name: "Housing Preservation and Development" },
      propertyObs,
    );
    assert.equal(hpd.domains.property.status, "matched");
  });

  it("linkObservation attaches named_owner for disposition grantee", () => {
    const obs = observationFromPropertyRow(
      corpus.property_rows.find((r) => r.request_id === "20241112003"),
    );
    const { links, objects } = linkObservation(obs);
    assert.ok(links.some((l) => l.type === "named_owner"));
    assert.ok(links.some((l) => l.type === "published_by_agency"));
    assert.ok(objects.some((o) => o.root_kind === "vendor"));
  });

  it("materialization artifact densifies well above fixture-scale (5 BBLs)", () => {
    const path = join(ROOT, "site/data/property_cross_domain_lookup.json");
    // Allow missing only before first build in CI of this PR — create if needed by caller.
    if (!existsSync(path)) return;
    const doc = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(doc.version, "property_cross_domain_v1");
    assert.ok(doc.demos?.["1006440001"]?.land?.status === "matched");

    const byBblCount = Object.keys(doc.by_bbl || {}).length;
    // Live property feed exposes ~320 unique BBLs; densify must leave fixture-scale (5).
    assert.ok(
      byBblCount >= 50,
      `expected by_bbl densify (≥50), got ${byBblCount}`,
    );
    assert.ok(
      (doc.coverage?.by_bbl_count || doc.metrics?.bbl_count || 0) >= 50,
      "coverage.by_bbl_count must reflect densified parcels",
    );
    assert.ok(
      (doc.metrics?.property_agency_link_count || 0) >= 20,
      "agency edges should densify from live disposition rows",
    );
    // ZAP stays sparse until Mini bulk zap-bbl — do not require high matched rate.
    assert.ok(doc.coverage, "coverage block stamped in provenance path");
    assert.equal(typeof doc.coverage.fraction_observations_with_bbl, "number");

    // Demos beyond the two hand-picked lots show property cross-domain links.
    const demoBbls = doc.demo_bbls || Object.keys(doc.demos || {});
    assert.ok(demoBbls.length >= 4, `expected extra live demo BBLs, got ${demoBbls.length}`);
    const extras = demoBbls.filter((b) => !["1006440001", "3025180036"].includes(b));
    assert.ok(extras.length >= 1, "need at least one demo BBL beyond the hand-picked pair");
    for (const bbl of extras.slice(0, 3)) {
      const demo = doc.demos?.[bbl];
      assert.ok(demo, `missing demo for ${bbl}`);
      assert.equal(demo.property?.status, "matched", `demo ${bbl} should have property notices`);
      assert.ok(
        (demo.agencies || []).length >= 1 || (demo.property?.count || 0) >= 1,
        `demo ${bbl} should carry agency or property links`,
      );
    }
  });

  it("committed property domain observations feed densify", () => {
    const path = join(ROOT, "site/data/property_domain_observations.json");
    if (!existsSync(path)) return;
    const obs = JSON.parse(readFileSync(path, "utf8"));
    assert.ok((obs.property_rows || []).length >= 50);
    assert.ok((obs.bbl_count || 0) >= 50);
  });

  it("buildPropertyCrossDomainDoc is provenance-complete", () => {
    const doc = buildPropertyCrossDomainDoc({
      propertyRows: corpus.property_rows,
      zapBblRows: corpus.zap_bbl_rows,
      zapProjects: corpus.zap_projects,
      moneyRows: corpus.money_rows,
    });
    assert.ok(doc.metrics.matched_bbl_count >= 1);
    assert.ok(doc.links.length >= 1);
    assert.ok(doc.links.every((l) => l.provenance?.source_system && l.provenance?.source_record_id));
    assert.ok(doc.coverage?.by_bbl_count >= 1);
    assert.ok(doc.provenance?.coverage?.by_bbl_count >= 1);
  });

  it("extractDispositionOwner reads labeled language through HTML bodies", () => {
    const owner = extractDispositionOwner({
      short_title: "Notice of tentative winning bidders",
      additional_description_1:
        "<p>The property has been <strong>sold to</strong> Make it Zesty LLC for $275,000.</p>",
    });
    assert.equal(owner?.name, "Make it Zesty LLC");
    assert.equal(owner?.basis, "sold_to");
  });
});
