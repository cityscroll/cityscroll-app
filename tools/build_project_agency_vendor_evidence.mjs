#!/usr/bin/env node
/**
 * Materialize reviewed project × agency × vendor evidence without rebuilding
 * the independently bounded entity corpus.
 *
 * Usage:
 *   node tools/build_project_agency_vendor_evidence.mjs
 *   node tools/build_project_agency_vendor_evidence.mjs --check
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  attachProjectAgencyVendorBrowseRefs,
  buildProjectAgencyVendorEvidence,
  mergeProjectAgencyVendorSubjectIndex,
} from "../entity_resolution/cross_domain/index.mjs";
import { buildPropertyResidentSnapshot } from "./build_property_resident_snapshot.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATHS = {
  registry: join(ROOT, "entity_resolution/cross_domain/project_agency_vendor_evidence.json"),
  property: join(ROOT, "site/data/property_domain_observations.json"),
  propertyResident: join(ROOT, "site/data/property_resident_snapshot.json"),
  propertyCrossDomain: join(ROOT, "site/data/property_cross_domain_lookup.json"),
  siteIntelligence: join(ROOT, "site/data/entity_intelligence_lookup.json"),
  workerIntelligence: join(ROOT, "worker/src/data/entity_intelligence_lookup.json"),
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const unique = (values) => [...new Set(values)];

function materialized() {
  for (const path of Object.values(PATHS)) {
    if (!existsSync(path)) throw new Error(`missing materialization input: ${path}`);
  }
  const registry = readJson(PATHS.registry);
  const property = readJson(PATHS.property);
  const propertyCrossDomain = readJson(PATHS.propertyCrossDomain);
  const siteIntelligence = readJson(PATHS.siteIntelligence);
  const workerIntelligence = readJson(PATHS.workerIntelligence);
  const previousEvidence = siteIntelligence.project_agency_vendor || {};
  const evidence = buildProjectAgencyVendorEvidence({
    registry,
    propertyRows: property.property_rows || [],
    propertyCrossDomain,
  });
  const propertyOut = {
    ...property,
    property_rows: attachProjectAgencyVendorBrowseRefs(
      property.property_rows || [],
      evidence,
      previousEvidence,
    ),
  };
  const propertyResident = buildPropertyResidentSnapshot(propertyOut);

  const updateIntelligence = (doc) => ({
    ...doc,
    by_subject_ref: mergeProjectAgencyVendorSubjectIndex(
      doc.by_subject_ref || {},
      evidence,
      doc.project_agency_vendor || {},
    ),
    project_agency_vendor: evidence,
    provenance: {
      ...(doc.provenance || {}),
      sources: unique([
        ...(doc.provenance?.sources || []),
        "site/data/property_cross_domain_lookup.json",
        "entity_resolution/cross_domain/project_agency_vendor_evidence.json",
      ]),
      methods: unique([
        ...(doc.provenance?.methods || []),
        "reviewed_publisher_role_v1",
      ]),
    },
  });

  return {
    evidence,
    property: propertyOut,
    propertyResident,
    siteIntelligence: updateIntelligence(siteIntelligence),
    workerIntelligence: updateIntelligence(workerIntelligence),
  };
}

function stableEvidenceShape(doc) {
  const subject = doc.evidence.bundles[0]?.subject_ref;
  return {
    evidence: doc.evidence,
    subject_pivots: subject ? doc.siteIntelligence.by_subject_ref?.[subject] || [] : [],
    property_refs: subject
      ? doc.property.property_rows.find((row) => `notice:${row.request_id}` === subject)?.entity_refs_all || []
      : [],
    resident_property_refs: subject
      ? doc.propertyResident.properties.find((row) => `notice:${row.request_id}` === subject)?.entity_refs_all || []
      : [],
    site_worker_equal: JSON.stringify(doc.siteIntelligence) === JSON.stringify(doc.workerIntelligence),
  };
}

function main() {
  const check = process.argv.includes("--check");
  const expected = materialized();
  if (check) {
    const committed = {
      evidence: readJson(PATHS.siteIntelligence).project_agency_vendor,
      property: readJson(PATHS.property),
      propertyResident: readJson(PATHS.propertyResident),
      siteIntelligence: readJson(PATHS.siteIntelligence),
      workerIntelligence: readJson(PATHS.workerIntelligence),
    };
    if (JSON.stringify(stableEvidenceShape(committed)) !== JSON.stringify(stableEvidenceShape(expected))) {
      console.error("project-agency-vendor evidence drift — rebuild with tools/build_project_agency_vendor_evidence.mjs");
      process.exit(1);
    }
    console.log(`project-agency-vendor evidence ok: bundles=${expected.evidence.public_bundle_count}`);
    return;
  }

  writeFileSync(PATHS.property, `${JSON.stringify(expected.property, null, 2)}\n`);
  writeFileSync(PATHS.propertyResident, `${JSON.stringify(expected.propertyResident, null, 2)}\n`);
  writeFileSync(PATHS.siteIntelligence, `${JSON.stringify(expected.siteIntelligence, null, 2)}\n`);
  writeFileSync(PATHS.workerIntelligence, `${JSON.stringify(expected.workerIntelligence, null, 2)}\n`);
  console.log(`wrote reviewed project-agency-vendor evidence: bundles=${expected.evidence.public_bundle_count}`);
}

main();
