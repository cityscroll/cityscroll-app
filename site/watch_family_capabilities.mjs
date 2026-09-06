/**
 * Canonical capability registry for the public Following program.
 *
 * Recovery and discovery intentionally read this same list. A capability is a
 * safe, editable watch seed; it is never a subscription by itself.
 */

export const WATCH_FAMILY_CAPABILITIES_SCHEMA = "cityscroll.watch_family_capabilities.v1";

const CAPABILITIES = [
  {
    id: "contracts-awards",
    label: "Contracts and awards",
    description: "Follow new City contracts, RFPs, and awards.",
    lens: "money",
    filter: { noticeType: "award" },
    rank: 10,
    terms: ["contract", "contracts", "award", "awards", "rfp", "procurement"],
  },
  {
    id: "rezonings-land-use",
    label: "Rezonings and land use",
    description: "Follow zoning changes and land-use review.",
    lens: "land",
    filter: { keywords: ["rezoning"], status: "all" },
    rank: 20,
    terms: ["rezone", "rezoning", "zoning", "land", "ulurp"],
  },
  {
    id: "meetings",
    label: "Meetings and hearings",
    description: "Follow public meetings, hearings, and next steps.",
    lens: "meetings",
    filter: {},
    rank: 30,
    terms: ["meeting", "meetings", "hearing", "hearings", "testimony"],
  },
  {
    id: "exams-staffing",
    label: "Exams and staffing",
    description: "Follow civil service exams, hires, and staff records.",
    lens: "people",
    filter: { view: "guide" },
    rank: 40,
    terms: ["exam", "exams", "jobs", "staffing", "hiring", "appointments"],
  },
  {
    id: "rules",
    label: "Rules",
    description: "Follow agency rules and rule changes.",
    lens: "rules",
    filter: {},
    rank: 50,
    terms: ["rule", "rules", "regulation", "regulations", "comment"],
  },
  {
    id: "property",
    label: "Property",
    description: "Follow property sales, transfers, and notices.",
    lens: "property",
    filter: {},
    rank: 60,
    terms: ["property", "properties", "sale", "sales", "disposition", "land"],
  },
  {
    id: "procurement",
    label: "Procurement opportunities",
    description: "Follow open bids and ways to do business with the City.",
    lens: "money",
    filter: { noticeType: "solicitation" },
    rank: 70,
    terms: ["procurement", "opportunity", "opportunities", "solicitation", "bid", "bids"],
  },
  {
    id: "agency-activity",
    label: "Agency activity",
    description: "Start with one public body. Edit the institution name before you save. This is not a group follow.",
    lens: "entity",
    filter: { kind: "agency", name: "an agency" },
    rank: 80,
    terms: ["agency", "agencies", "department", "publisher"],
  },
  {
    id: "vendor-activity",
    label: "Vendor activity",
    description: "Start with vendor records. Edit the vendor name before you save.",
    lens: "entity",
    filter: { kind: "vendor", name: "a vendor" },
    rank: 90,
    terms: ["vendor", "vendors", "company", "business", "supplier"],
  },
  {
    id: "mandates",
    label: "Mandates and filings",
    description: "Follow public duties and the reports tied to them.",
    lens: "mandates",
    filter: {},
    rank: 100,
    terms: ["mandate", "mandates", "filing", "filings", "obligation", "report"],
  },
  {
    id: "geographic-scopes",
    label: "Geographic scopes",
    description: "Follow City work in a Council District or other place.",
    lens: "district",
    filter: { councilDistrict: "1" },
    rank: 110,
    terms: ["near me", "neighborhood", "borough", "district", "place", "geography"],
  },
].map((capability) => Object.freeze({
  ...capability,
  filter: Object.freeze({ ...capability.filter }),
  terms: Object.freeze([...capability.terms]),
}));

export const WATCH_FAMILY_CAPABILITIES = Object.freeze(CAPABILITIES);

/** Return a fresh capability list so callers cannot mutate the registry. */
export function watchFamilyCapabilities() {
  return WATCH_FAMILY_CAPABILITIES.map((capability) => ({
    ...capability,
    filter: { ...capability.filter },
    terms: [...capability.terms],
  }));
}

/**
 * Rank the full-span suggestions for a piece of user input.
 * Exact family terms rise to the top; an empty or ambiguous query keeps the
 * complete registry in stable editorial order.
 */
export function rankWatchFamilySuggestions(input = "") {
  const query = String(input || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = new Set(query.split(/\s+/).filter(Boolean));
  return watchFamilyCapabilities()
    .map((capability) => {
      const matches = capability.terms.reduce((count, term) => count + (tokens.has(term) ? 1 : 0), 0);
      return { ...capability, relevance: matches, rank: capability.rank - matches * 20 };
    })
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    .map((capability, index) => ({ ...capability, rank: index + 1 }));
}

export function isWatchFamilyCapability(value) {
  return WATCH_FAMILY_CAPABILITIES.some((capability) => capability.id === String(value || ""));
}
