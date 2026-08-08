import { asOfSection } from "./agency_constellation_sections/as_of.mjs";
import { contractsSection } from "./agency_constellation_sections/contracts.mjs";
import { meetingsSection } from "./agency_constellation_sections/meetings.mjs";
import { mandatePredictionsSection } from "./agency_constellation_sections/mandate_predictions.mjs";
import { mandateReportsSection } from "./agency_constellation_sections/mandate_reports.mjs";
import { mandateRulesSection } from "./agency_constellation_sections/mandate_rules.mjs";
import { processConformanceSection } from "./agency_constellation_sections/process_conformance.mjs";
import { provenanceSection } from "./agency_constellation_sections/provenance.mjs";
import { rulesSection } from "./agency_constellation_sections/rules.mjs";
import { staffingSection } from "./agency_constellation_sections/staffing.mjs";

const registeredSections = [
  asOfSection,
  mandatePredictionsSection,
  mandateReportsSection,
  mandateRulesSection,
  contractsSection,
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

export function renderAgencyConstellationSections(view) {
  const rendered = AGENCY_CONSTELLATION_SECTIONS.map((section) => ({
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
