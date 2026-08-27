#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildAgencySearchDocuments } from "../site/agency_search_producer.mjs";
import { buildCommitteeSearchDocuments } from "../site/committee_search_producer.mjs";
import { buildExamSearchDocuments } from "../site/exam_search_producer.mjs";
import { buildLandSearchDocuments } from "../site/land_search_producer.mjs";
import { buildBoardSearchDocuments } from "../site/board_search_producer.mjs";
import { buildMeetingSearchDocuments } from "../site/meeting_search_producer.mjs";
import { buildParcelSearchDocuments } from "../site/parcel_search_producer.mjs";
import { buildPeopleSearchDocuments } from "../site/people_search_producer.mjs";
import { buildCommunityBoardPersonSearchDocuments } from "../site/community_board_people_search_producer.mjs";
import { buildCommunityBoardCommitteeSearchDocuments } from "../site/board_search_producer.mjs";
import { buildVendorSearchDocuments } from "../site/vendor_search_producer.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { readSharedProcurementReadModel } from "./lib/procurement_read_model_io.mjs";
import {
  attachKeywordCoherenceReceipt,
  checkProcurementIndexCoherence,
  formatCoherenceFindings,
} from "./lib/procurement_index_coherence.mjs";

const ROOT = new URL("../", import.meta.url);
const OUTPUT = new URL("../worker/src/data/keyword_search_index.json", import.meta.url);

function json(relative) {
  return JSON.parse(readFileSync(new URL(relative, ROOT), "utf8"));
}

function latestClock(...values) {
  return values
    .flatMap((value) => String(value || "").split("|"))
    .map((value) => value.trim())
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function compactDocument(document) {
  const provenance = document?.provenance || {};
  const communityBoardContext = provenance.board_id
    ? {
      board_id: provenance.board_id,
      board_name: provenance.board_name || null,
      borough: provenance.borough || null,
      district: provenance.district || null,
      publisher_name: provenance.publisher_name || null,
      publisher_identifier: provenance.publisher_identifier || null,
      publisher_person_id: provenance.publisher_person_id || null,
      publisher_committee_names: provenance.publisher_committee_names || [],
      reviewed_aliases: provenance.reviewed_aliases || [],
      topic_facets: provenance.topic_facets || [],
      role_keys: provenance.role_keys || [],
      role_labels: provenance.role_labels || [],
      institution_label: provenance.institution_label || null,
      institution_context: provenance.institution_context || null,
    }
    : null;
  return {
    schema: document.schema,
    object_ref: document.object_ref,
    object_type: document.object_type,
    domain: document.domain,
    canonical_href: document.canonical_href,
    title: document.title,
    summary: document.summary,
    search_text: document.search_text,
    source_family: document.source_family,
    source_observation_refs: document.source_observation_refs,
    process_role: document.process_role,
    classification: document.classification,
    provenance: {
      producer: provenance.producer,
      source_system: provenance.source_system || provenance.source_contract || null,
      source_freshness: provenance.source_freshness || {
        generated_at: provenance.read_model_generated_at
          || provenance.materialized_at
          || provenance.source_retrieved_at
          || null,
      },
      browse_record: provenance.browse_record || null,
      notice_evidence: provenance.notice_evidence || [],
      alias_object_refs: provenance.alias_object_refs || [],
      ...(communityBoardContext ? { community_board_context: communityBoardContext } : {}),
    },
    outcome: document.outcome || "indexed",
    coverage_state: document.coverage_state || "matched",
  };
}

function family(source, asOf, corpora) {
  const documents = corpora.flatMap((corpus) => corpus.documents || []).map(compactDocument);
  return {
    source,
    as_of: asOf || null,
    source_row_count: corpora.reduce((sum, corpus) => (
      sum + Number(corpus.coverage?.source_count ?? corpus.coverage?.total_count ?? corpus.counts?.total ?? 0)
    ), 0),
    indexed_count: documents.length,
    coverage: corpora.map((corpus) => corpus.coverage || corpus.counts || null),
    documents,
  };
}

const people = json("site/data/person_hub_lookup.json");
const agencies = json("site/data/agency_constellation_lookup.json");
const vendors = json("site/data/entity_intelligence_lookup.json");
const vendorAliases = json("entity_resolution/review/alias_registry.json");
const communityBoards = json("site/data/community_board_constellation_lookup.json");
const agencyIdentityReport = json("site/data/agency_route_identity_report.json");
const land = json("site/data/zap_projects_warehouse_lookup.json");
const meetings = json("site/data/shared_meeting_read_model.json");
const exams = json("site/data/staffing_exams.json");
const parcels = json("site/data/property_cross_domain_lookup.json");
const propertyResidents = json("site/data/property_resident_snapshot.json");
const committees = json("site/data/committee_graph_lookup.json");
const communityBoardPeople = json("site/data/community_board_people.json");
const communityBoardCommittees = json("site/data/non_council_outcome_sources/community_board_committees.json");
const procurements = readSharedProcurementReadModel(new URL("../site/data/shared_procurement_read_model.json", import.meta.url));
const peopleCorpus = buildPeopleSearchDocuments(people);
const agencyCorpus = buildAgencySearchDocuments(agencies, { identityReport: agencyIdentityReport });
const vendorCorpus = buildVendorSearchDocuments(vendors, { aliasRegistry: vendorAliases });
// Production completeness is over currently eligible Vendor documents. Tentative
// or unpublished roots stay outside the indexed family and are receipted below.
const eligibleVendorCorpus = {
  documents: vendorCorpus.documents,
  coverage: {
    ...vendorCorpus.coverage,
    state: vendorCorpus.documents.length ? "matched" : "empty",
    reason: vendorCorpus.documents.length
      ? "eligible_vendor_read_model_indexed"
      : "vendor_read_model_has_no_entries",
    source_count: vendorCorpus.documents.length,
    total_count: vendorCorpus.documents.length,
    indexed_count: vendorCorpus.documents.length,
    not_indexed_count: 0,
  },
};
const excludedVendorRoots = (Array.isArray(vendorCorpus.outcomes) ? vendorCorpus.outcomes : [])
  .filter((row) => row?.outcome && row.outcome !== "indexed")
  .map((row) => ({
    entity_ref: row.entity_ref || null,
    outcome: row.outcome,
    reason: row.reason || null,
  }));
const parcelCorpus = buildParcelSearchDocuments(parcels, {
  residentSnapshot: propertyResidents,
});
const communityBoardCorpus = buildBoardSearchDocuments(communityBoards);
const communityBoardPeopleCorpus = buildCommunityBoardPersonSearchDocuments(communityBoardPeople, {
  boardLookup: communityBoards,
  committeeRegistry: communityBoardCommittees,
});
const communityBoardCommitteeCorpus = buildCommunityBoardCommitteeSearchDocuments(communityBoardCommittees, {
  boardLookup: communityBoards,
});
const committeeCorpus = buildCommitteeSearchDocuments(committees);
const procurementCorpus = buildProcurementSearchDocuments(procurements);

const output = {
  schema: "cityscroll.keyword_search_index.v1",
  generated_at: latestClock(
    people.retrieved_at,
    communityBoardPeople.observed_on,
    agencies.generated_at,
    vendors.generated_at,
    communityBoards.generated_at,
    land.materialized_at,
    meetings.generated_at,
    exams.generated_at,
    parcels.generated_at,
    propertyResidents.generated_at,
    committees.generated_at,
    communityBoardCommittees.observed_on,
    procurements.generated_at,
  ),
  match_mode: "keyword",
  families: {
    people: family(
      "NYC Council and Community Board people",
      latestClock(people.retrieved_at, communityBoardPeople.observed_on),
      [peopleCorpus, communityBoardPeopleCorpus],
    ),
    agencies: family(
      "CityScroll agency profiles",
      agencies.generated_at,
      [agencyCorpus],
    ),
    "people-organizations": family(
      "CityScroll agency profiles",
      agencies.generated_at,
      [agencyCorpus],
    ),
    vendors: family(
      "CityScroll vendor profiles from cross-domain entity intelligence",
      vendors.generated_at,
      [eligibleVendorCorpus],
    ),
    community_boards: family(
      "NYC Community Board institutions",
      communityBoards.generated_at,
      [communityBoardCorpus],
    ),
    land: family(
      "NYC Open Data Zoning Application Portal projects",
      land.materialized_at,
      [buildLandSearchDocuments(land)],
    ),
    meetings: family(
      "City Record and official community-board meeting snapshots",
      meetings.generated_at,
      [buildMeetingSearchDocuments(meetings)],
    ),
    exams: family(
      "Department of Citywide Administrative Services exam schedule",
      exams.data_current_as_of || exams.generated_at,
      [buildExamSearchDocuments(exams)],
    ),
    parcels: family(
      "City property parcels by exact BBL",
      parcels.generated_at,
      [parcelCorpus],
    ),
    committees: family(
      "New York City Council and Community Board committees",
      latestClock(committees.generated_at, communityBoardCommittees.observed_on),
      [committeeCorpus, communityBoardCommitteeCorpus],
    ),
    procurements: family(
      "PASSPort, Checkbook NYC, and City Record procurement observations",
      procurements.generated_at,
      [procurementCorpus],
    ),
  },
  build_receipt: {
    source_artifacts: {
      people: "site/data/person_hub_lookup.json",
      agencies: "site/data/agency_constellation_lookup.json",
      vendors: "site/data/entity_intelligence_lookup.json",
      vendor_aliases: "entity_resolution/review/alias_registry.json",
      community_boards: "site/data/community_board_constellation_lookup.json",
      land: "site/data/zap_projects_warehouse_lookup.json",
      meetings: "site/data/shared_meeting_read_model.json",
      exams: "site/data/staffing_exams.json",
      parcels: "site/data/property_cross_domain_lookup.json",
      property_residents: "site/data/property_resident_snapshot.json",
      committees: "site/data/committee_graph_lookup.json",
      community_board_people: "site/data/community_board_people.json",
      community_board_committees: "site/data/non_council_outcome_sources/community_board_committees.json",
      procurements: "site/data/shared_procurement_read_model.json",
    },
    excluded_artifacts: ["worker/src/data/ocp_awards_warehouse_lookup.json"],
    excluded_vendor_roots: excludedVendorRoots,
    vendor_root_counts: {
      source_roots: Number(vendorCorpus.coverage?.total_count ?? 0),
      eligible_indexed: eligibleVendorCorpus.documents.length,
      excluded: excludedVendorRoots.length,
    },
  },
};
const stamped = attachKeywordCoherenceReceipt({
  readModel: procurements,
  keywordIndex: output,
});
const coherence = checkProcurementIndexCoherence({
  readModel: procurements,
  keywordIndex: stamped,
});
if (!coherence.ok) {
  console.error(formatCoherenceFindings(coherence.findings));
  process.exit(1);
}
const serialized = `${JSON.stringify(stamped, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(OUTPUT, "utf8") !== serialized) {
    console.error(`stale keyword search index: ${fileURLToPath(OUTPUT)}`);
    process.exit(1);
  }
  console.log(`keyword search index current (${serialized.length} bytes)`);
} else {
  writeFileSync(OUTPUT, serialized);
  console.log(`wrote ${fileURLToPath(OUTPUT)} (${serialized.length} bytes)`);
}
