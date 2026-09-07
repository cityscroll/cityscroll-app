import { asOfSection } from "./agency_constellation_sections/as_of.mjs";
import { contractsSection } from "./agency_constellation_sections/contracts.mjs";
import { fiscalContextSection } from "./agency_constellation_sections/fiscal_context.mjs";
import { agencyLifecycleConformanceSection } from "./agency_constellation_sections/agency_lifecycle_conformance.mjs";
import { budgetRequestsSection } from "./agency_constellation_sections/budget_requests.mjs";
import { meetingsSection } from "./agency_constellation_sections/meetings.mjs";
import { mandateContractsSection } from "./agency_constellation_sections/mandate_contracts.mjs";
import { mandatePredictionsSection } from "./agency_constellation_sections/mandate_predictions.mjs";
import { mandateReportsSection } from "./agency_constellation_sections/mandate_reports.mjs";
import { mandateRulesSection } from "./agency_constellation_sections/mandate_rules.mjs";
import { mandateMeetingsSection } from "./agency_constellation_sections/mandate_meetings.mjs";
import { mandateLandUseSection } from "./agency_constellation_sections/mandate_land_use.mjs";
import { processConformanceSection } from "./agency_constellation_sections/process_conformance.mjs";
import { provenanceSection } from "./agency_constellation_sections/provenance.mjs";
import { rulesSection } from "./agency_constellation_sections/rules.mjs";
import { staffingSection } from "./agency_constellation_sections/staffing.mjs";
import { vendorsSection } from "./agency_constellation_sections/vendors.mjs";
import { identitySection } from "./agency_constellation_sections/identity.mjs";
import { institutionNavigationSection } from "./agency_constellation_sections/institution_navigation.mjs";
import { recordCapacitySection } from "./agency_constellation_sections/record_capacity.mjs";

const registeredSections = [
  asOfSection,
  institutionNavigationSection,
  identitySection,
  recordCapacitySection,
  mandatePredictionsSection,
  mandateReportsSection,
  mandateRulesSection,
  mandateMeetingsSection,
  mandateContractsSection,
  mandateLandUseSection,
  fiscalContextSection,
  contractsSection,
  vendorsSection,
  agencyLifecycleConformanceSection,
  budgetRequestsSection,
  meetingsSection,
  rulesSection,
  processConformanceSection,
  staffingSection,
  provenanceSection,
];

function validateRegistry(sections) {
  const ids = new Set();
  const orders = new Set();
  for (const section of sections) {
    if (!section?.id || !Number.isFinite(section.order) || typeof section.render !== "function") {
      throw new TypeError("Agency constellation sections require { id, order, render(view) }");
    }
    if (ids.has(section.id)) throw new Error(`Duplicate agency constellation section id: ${section.id}`);
    if (orders.has(section.order)) throw new Error(`Duplicate agency constellation section order: ${section.order}`);
    ids.add(section.id);
    orders.add(section.order);
  }
}

validateRegistry(registeredSections);

export const AGENCY_CONSTELLATION_SECTIONS = Object.freeze(
  [...registeredSections].sort((left, right) => left.order - right.order),
);

/**
 * Sections the agency document renders itself, ahead of the reader.
 *
 * Most of an agency profile's relationship sections arrive in a deferred
 * fragment the page fetches after load. A section marked static opts out of
 * that: it is written into the document, so it is there with scripting off and
 * it stays out of the committed relationship artifacts.
 */
export const AGENCY_CONSTELLATION_STATIC_SECTION_IDS = Object.freeze(
  AGENCY_CONSTELLATION_SECTIONS.filter((section) => section.static === true).map((section) => section.id),
);

export function renderAgencyConstellationStaticSections(view) {
  return AGENCY_CONSTELLATION_SECTIONS
    .filter((section) => section.static === true)
    .map((section) => section.render(view))
    .filter(Boolean)
    .join("");
}

export function renderAgencyConstellationSections(view, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  const rendered = AGENCY_CONSTELLATION_SECTIONS.filter((section) => !excluded.has(section.id)).map((section) => ({
    html: section.render(view),
    region: section.region || "main",
  }));
  const region = (name) => rendered
    .filter((section) => section.region === name)
    .map((section) => section.html)
    .filter(Boolean)
    .join("");
  return `${region("before")}\n    ${region("main")}\n    ${region("after")}`;
}

export function agencyConstellationSectionStyles() {
  return AGENCY_CONSTELLATION_SECTIONS
    .filter((section) => section.style)
    .sort((left, right) => left.styleOrder - right.styleOrder)
    .map((section) => section.style)
    .join("");
}

export function agencyConstellationSectionScripts(view) {
  return AGENCY_CONSTELLATION_SECTIONS.map((section) => section.script?.(view) || "").join("");
}
