import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  civicInstitutionIdForPartyValue,
  isReviewedPartySpelling,
} from "../site/civic_institution_party_spellings.mjs";
import {
  NYCEDC_CANONICAL_ID,
  NYCEDC_ZAP_APPLICANT_SPELLING,
  SBS_CANONICAL_ID,
  SBS_MASTER_EPIN,
  SBS_MASTER_PROCUREMENT_ID,
  SBS_MASTER_SOURCE_REF,
  WILLETS_POINT_PROJECT_ID,
  developmentRolesForInstitution,
} from "../site/civic_institution_development_roles.mjs";
import {
  buildInstitutionRecordCapacityView,
  capacityForRecordRef,
  institutionCapacityGroups,
  institutionRecordCapacities,
  institutionRecordCapacityIndex,
} from "../site/civic_institution_record_capacity.mjs";
import { renderAgencyRecordCapacitySection } from "../site/agency_constellation_sections/record_capacity.mjs";
import { renderAgencyCategorySection } from "../site/agency_constellation_sections/category_section.mjs";
import { renderProcurementInstitutionRoles } from "../site/procurement_document.mjs";
import { buildBrowseView } from "../site/browse_view.mjs";
import { buildAgencyCapacityBrowseContract } from "../site/agency_browse_contract.mjs";
import { readProcurementBrowsePopulation } from "../tools/lib/procurement_browse_population_io.mjs";

const procurementRows = readProcurementBrowsePopulation(
  new URL("../site/data/procurement_browse_rows.json", import.meta.url),
);
const landProjects = JSON.parse(
  readFileSync(new URL("../site/data/land_default_ulurp.json", import.meta.url), "utf8"),
);

const RETAINED_PROCUREMENTS = (procurementRows.rows || []).filter((row) => (
  civicInstitutionIdForPartyValue("vendor_name", row?.vendor_name)
  && civicInstitutionIdForPartyValue("agency_name", row?.agency_name)
));
const RETAINED_PROJECTS = (landProjects.projects || []).filter((row) =>
  civicInstitutionIdForPartyValue("primary_applicant", row?.primary_applicant));

const SOURCES = Object.freeze({
  projects: RETAINED_PROJECTS,
  procurements: RETAINED_PROCUREMENTS,
});

function capacitiesFor(canonicalId, displayName) {
  return institutionRecordCapacities(
    canonicalId,
    developmentRolesForInstitution(canonicalId, SOURCES),
    { displayName },
  );
}

test("A1 the named specimen records still read as the exact capacities their sources establish", () => {
  const nycedc = capacitiesFor(NYCEDC_CANONICAL_ID, "Economic Development Corporation");
  const willets = capacityForRecordRef(nycedc, `project:${WILLETS_POINT_PROJECT_ID}`);
  assert.equal(willets.capacity_id, "applicant");
  assert.equal(willets.relation_id, "applicant_on");
  assert.equal(willets.source_field, "primary_applicant");
  assert.equal(willets.source_value, NYCEDC_ZAP_APPLICANT_SPELLING);
  assert.match(willets.sentence, /is the applicant named on this project/);

  const master = RETAINED_PROCUREMENTS.find((row) => row.pin === SBS_MASTER_EPIN);
  assert.ok(master, "the master EPIN row is still retained");
  const contractor = capacityForRecordRef(nycedc, master.procurement_id);
  assert.equal(contractor.capacity_id, "contractor");
  assert.equal(contractor.counterparty_id, SBS_CANONICAL_ID);
  assert.equal(contractor.counterparty_label, "contracting agency");
  assert.match(contractor.sentence, /is the contractor on this contract/);

  const sbs = capacitiesFor(SBS_CANONICAL_ID, "Small Business Services");
  const contracting = capacityForRecordRef(sbs, master.procurement_id);
  assert.equal(contracting.capacity_id, "contracting_agency");
  assert.equal(contracting.counterparty_id, NYCEDC_CANONICAL_ID);
  assert.match(contracting.sentence, /is the contracting agency on this contract/);
});

test("A1 the record page names both parties in plain language and in different capacities", () => {
  const master = RETAINED_PROCUREMENTS.find((row) => row.pin === SBS_MASTER_EPIN);
  const html = renderProcurementInstitutionRoles(master, [{
    source_observation_ref: SBS_MASTER_SOURCE_REF,
    source_system: "passport_public_contracts",
    ingested_at: master.start_date,
    snapshot: {
      epin: master.pin,
      agency: master.agency_name,
      vendor: master.vendor_name,
      title: master.short_title,
    },
  }]);
  assert.match(html, /id="procurement-institution-roles"/);
  assert.match(html, /data-record-capacity="contractor"[^>]*data-institution="economic-development-corporation"/);
  assert.match(html, /data-record-capacity="contracting_agency"[^>]*data-institution="small-business-services"/);
  assert.match(html, /Economic Development Corporation is the contractor on this contract/);
  assert.match(html, /Small Business Services is the contracting agency on this contract/);
  assert.match(html, /Receiving this contract is not authority to award one/);
});

test("A2 the mapping is keyed on reviewed party fields, so retained non-canary records carry it too", () => {
  const nonCanary = RETAINED_PROCUREMENTS.filter((row) => row.pin !== SBS_MASTER_EPIN);
  assert.ok(
    nonCanary.length >= 1,
    "at least one retained contract other than the named specimen carries the reviewed party fields",
  );
  const nycedc = capacitiesFor(NYCEDC_CANONICAL_ID, "Economic Development Corporation");
  const proven = nonCanary
    .map((row) => capacityForRecordRef(nycedc, row.procurement_id))
    .filter(Boolean);
  assert.equal(
    proven.length,
    nonCanary.length,
    "every retained non-specimen row with reviewed party fields gets the same capacity",
  );
  // The proof that the gate is the field and not the identifier: these rows
  // carry a different EPIN, a different contract id, and a different source
  // system from the named specimen.
  const other = proven[0];
  const otherRow = nonCanary.find((row) => row.procurement_id === other.record_ref);
  assert.notEqual(otherRow.pin, SBS_MASTER_EPIN);
  assert.notEqual(otherRow.procurement_id, SBS_MASTER_PROCUREMENT_ID);
  assert.equal(other.capacity_id, "contractor");
  assert.equal(other.counterparty_id, SBS_CANONICAL_ID);
});

test("A2 an unreviewed spelling, a wrong field, and a missing party all stay non-linking", () => {
  assert.equal(civicInstitutionIdForPartyValue("vendor_name", "Economic Development Corporation"), null);
  assert.equal(civicInstitutionIdForPartyValue("agency_name", "New York City Economic Development Corporation"), null);
  assert.equal(civicInstitutionIdForPartyValue("vendor_name", ""), null);
  assert.equal(isReviewedPartySpelling(SBS_CANONICAL_ID, "vendor_name", "Small Business Services"), false);

  const halfParty = developmentRolesForInstitution(NYCEDC_CANONICAL_ID, {
    procurements: [{
      procurement_id: "procurement:contract:NO-AGENCY-PARTY",
      pin: "80125S0000001",
      agency_name: "Some Unreviewed Agency",
      vendor_name: "NEW YORK CITY ECONOMIC DEVELOPMENT CORPORATION",
      source_observation_refs: ["checkbook_contracts:contract:registered:NO-AGENCY-PARTY"],
    }],
  });
  assert.equal(halfParty.accepted.length, 0, "a contract with only one reviewed party mints no edge");

  const noRef = developmentRolesForInstitution(NYCEDC_CANONICAL_ID, {
    procurements: [{
      procurement_id: "procurement:contract:NO-SOURCE-REF",
      agency_name: "Small Business Services",
      vendor_name: "New York City Economic Development Corporation",
    }],
  });
  assert.equal(noRef.accepted.length, 0, "a row with no retained source reference mints no edge");
});

test("A2 the preview, its count, and its Browse-all destination are one query", () => {
  const identity = { canonical_id: NYCEDC_CANONICAL_ID };
  const payload = { ...procurementRows, notices: procurementRows.rows };
  const contract = buildAgencyCapacityBrowseContract({
    identity,
    capacityId: "contractor",
    payload,
    limit: 8,
  });
  assert.equal(contract.relation, "named_vendor");
  assert.equal(contract.scope.mode, "applied");
  assert.equal(contract.total, RETAINED_PROCUREMENTS.length);

  const view = buildInstitutionRecordCapacityView({
    canonicalId: NYCEDC_CANONICAL_ID,
    displayName: "Economic Development Corporation",
    roleBag: developmentRolesForInstitution(NYCEDC_CANONICAL_ID, SOURCES),
    browseContractFor: (group, { limit }) => {
      if (group.browse_facet !== "contracts") return null;
      const scoped = buildAgencyCapacityBrowseContract({
        identity, capacityId: group.capacity_id, payload, limit: 1000,
      });
      return {
        total: scoped.total,
        record_refs: new Set(scoped.rows.map((row) => row.procurement_id)),
        asOf: scoped.asOf,
        href: `/browse/contracts/?${scoped.search.toString()}`,
      };
    },
    previewLimit: 8,
  });
  const received = view.groups.find((group) => group.group_id === "contracts_received");
  assert.equal(received.total_count, contract.total);
  assert.equal(received.count_basis, "browse_scope_total");
  assert.ok(received.shown_count <= received.total_count, "a preview never claims more than its scope holds");

  // Every previewed record is reachable at the Browse destination the group links to.
  const destination = new URLSearchParams(received.view_all_href.split("?")[1]);
  const browsed = buildBrowseView("contracts", payload, destination, { limit: 1000 });
  const browsedRefs = new Set(browsed.rows.map((row) => row.procurement_id));
  for (const item of received.items) {
    assert.ok(browsedRefs.has(item.record_ref), `${item.record_ref} is in the Browse-all result`);
  }
});

test("A3 contracts received are never counted or scoped as procurements issued", () => {
  const payload = { ...procurementRows, notices: procurementRows.rows };
  const scope = (relation) => new URLSearchParams({
    facet: JSON.stringify({
      entity_refs_all: [`agency:id:${NYCEDC_CANONICAL_ID}`],
      connection_relation: relation,
    }),
  });
  const issued = buildBrowseView("contracts", payload, scope("published_by_agency"), { limit: 1000 });
  const received = buildBrowseView("contracts", payload, scope("named_vendor"), { limit: 1000 });
  assert.equal(issued.total, 0, "this institution publishes no contracts in the retained corpus");
  assert.equal(received.total, RETAINED_PROCUREMENTS.length);

  // The unqualified institution scope keeps its previous meaning exactly: it
  // reads the publishing agency, so a party mapping can never widen it.
  const unqualified = buildBrowseView("contracts", payload, new URLSearchParams({
    facet: JSON.stringify({ entity_refs_all: [`agency:id:${NYCEDC_CANONICAL_ID}`] }),
  }), { limit: 1000 });
  assert.equal(unqualified.total, 0);

  const groups = institutionCapacityGroups(capacitiesFor(NYCEDC_CANONICAL_ID, "Economic Development Corporation"));
  assert.deepEqual(
    groups.map((group) => group.group_id),
    ["projects", "contracts_received"],
    "no group claims issued procurements from received ones",
  );
  assert.equal(groups.some((group) => group.group_id === "contracts_issued"), false);
});

test("A3 applicant status asserts no approval authority and defers to the procedure panel", () => {
  const nycedc = capacitiesFor(NYCEDC_CANONICAL_ID, "Economic Development Corporation");
  const willets = capacityForRecordRef(nycedc, `project:${WILLETS_POINT_PROJECT_ID}`);
  assert.match(willets.boundary, /Applying is not deciding/);
  assert.match(willets.boundary, /land-use authority panel/);
  const serialized = JSON.stringify(nycedc);
  assert.doesNotMatch(serialized, /approv(e|es|al) authority/i);
  assert.doesNotMatch(serialized, /nonbinding|non-binding/i);
  assert.doesNotMatch(serialized, /decides|decision-maker/i);
});

test("optional empty capacity sections are omitted, never rendered as a zero", () => {
  const none = buildInstitutionRecordCapacityView({
    canonicalId: "parks-and-recreation",
    displayName: "Parks and Recreation",
    roleBag: developmentRolesForInstitution("parks-and-recreation", SOURCES),
  });
  assert.equal(none, null, "an institution with no accepted capacity gets no view at all");
  assert.equal(renderAgencyRecordCapacitySection({ record_capacities: null }), "");
  assert.equal(renderAgencyRecordCapacitySection({}), "");
  assert.equal(renderAgencyRecordCapacitySection({ record_capacities: { groups: [] } }), "");
});

test("a capacity whose Browse payload is unavailable reports that, not a zero", () => {
  const view = buildInstitutionRecordCapacityView({
    canonicalId: NYCEDC_CANONICAL_ID,
    displayName: "Economic Development Corporation",
    roleBag: developmentRolesForInstitution(NYCEDC_CANONICAL_ID, SOURCES),
    browseContractFor: () => null,
  });
  const received = view.groups.find((group) => group.group_id === "contracts_received");
  assert.equal(received.availability, "scope_payload_unavailable");
  assert.equal(received.count_basis, "profile_resolved_roles");
  assert.ok(received.total_count > 0, "an unavailable scope never reports a zero it did not measure");
  const html = renderAgencyRecordCapacitySection({ record_capacities: view });
  assert.match(html, /data-capacity-availability="scope_payload_unavailable"/);
  assert.match(html, /this is not a count of zero elsewhere/);
});

test("the rendered profile section states capacity, evidence, and the other party", () => {
  const view = buildInstitutionRecordCapacityView({
    canonicalId: NYCEDC_CANONICAL_ID,
    displayName: "Economic Development Corporation",
    roleBag: developmentRolesForInstitution(NYCEDC_CANONICAL_ID, SOURCES),
    browseContractFor: () => null,
    previewLimit: 40,
  });
  const html = renderAgencyRecordCapacitySection({ record_capacities: view });
  assert.match(html, /id="agency-record-capacity"/);
  assert.match(html, /What this institution did in each record/);
  assert.match(html, /data-record-capacity="applicant"/);
  assert.match(html, /data-record-capacity="contractor"/);
  assert.match(html, /Willets Point Phase II Mapping Actions/);
  assert.match(html, /EDC - Economic Development Corporation for NYC/);
  assert.match(html, /Other party:/);
  assert.match(html, /Small Business Services/);
  assert.match(html, /a contract received is not a procurement issued/);
  // Every capacity row is addressable and carries its own browse predicate.
  assert.match(html, /data-browse-relation="named_vendor"/);
  assert.match(html, /data-browse-relation="applicant_agency"/);
});

test("a category record row states the capacity when the record has an accepted role", () => {
  const master = RETAINED_PROCUREMENTS.find((row) => row.pin === SBS_MASTER_EPIN);
  const capacities = institutionRecordCapacityIndex(
    capacitiesFor(SBS_CANONICAL_ID, "Small Business Services"),
  );
  const category = {
    id: "contracts",
    label: "Contracts",
    status: "matched",
    count: 1,
    total_count: 1,
    universe: "open",
    items: [{
      id: master.contract_id,
      subject_ref: master.procurement_id,
      label: master.short_title,
      href: master.canonical_href,
      date: master.start_date,
      source: "passport_public_contracts",
    }],
  };
  const html = renderAgencyCategorySection(category, { kind: "agency", id: SBS_CANONICAL_ID }, capacities);
  assert.match(html, /node-record-capacity-line/);
  assert.match(html, /data-record-capacity="contracting_agency"/);
  assert.match(html, /Small Business Services is the contracting agency on this contract/);

  // A row with no accepted role still renders and makes no capacity claim.
  const unrelated = renderAgencyCategorySection({
    ...category,
    items: [{ id: "other", subject_ref: "contract:unrelated", label: "Unrelated contract", href: "/x" }],
  }, { kind: "agency", id: SBS_CANONICAL_ID }, capacities);
  assert.match(unrelated, /Unrelated contract/);
  assert.doesNotMatch(unrelated, /node-record-capacity-line/);
});
