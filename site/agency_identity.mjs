// Shared browser/Worker agency-name reconciliation.
//
// City Record publishes agency_name as free text. These reviewed groups keep a
// stable route id while preserving every source spelling for exact source queries.

export const AGENCY_GROUPS = Object.freeze({
  "Administration for Children's Services": ["ADMIN FOR CHILDREN'S SERVICES", "ADMIN FOR CHILDRENS SERVICES", "ADMIN FOR CHILDREN'S SVCS", "ADMIN FOR CHILDRENS SVCS", "ADMIN FOR CHILDREN' SVCS"],
  "Administrative Trials and Hearings": ["ADMIN TRIALS AND HEARINGS"],
  "Aging": ["DEPARTMENT FOR THE AGING"],
  "Board of Correction": ["BOARD OF CORRECTION"],
  "Board of Elections": ["BOARD OF ELECTION"],
  "Borough President - Bronx": ["BOROUGH PRESIDENT-BRONX"],
  "Borough President - Brooklyn": ["BOROUGH PRESIDENT-BROOKLYN"],
  "Borough President - Manhattan": ["PRESIDENT BOROUGH OF MANHATTAN"],
  "Borough President - Queens": ["BOROUGH PRESIDENT-QUEENS"],
  "Borough President - Staten Island": ["BOROUGH PRESIDENT-STATEN IS"],
  "Buildings": ["DEPARTMENT OF BUILDINGS"],
  "Business Integrity Commission": ["BUSINESS INTEGRITY COMMISSION"],
  "Campaign Finance Board": ["CAMPAIGN FINANCE BOARD"],
  "City Clerk": ["CITY CLERK"],
  "City Council": ["CITY COUNCIL"],
  "City Planning": ["DEPARTMENT OF CITY PLANNING", "Department of City Planning", "DCP Department of City Planning"],
  "Citywide Administrative Services": ["DEPT OF CITYWIDE ADMIN SVCS", "Department of Citywide Administrative Services"],
  "Civilian Complaint Review Board": ["CIVILIAN COMPLAINT REVIEW BD"],
  "Civil Service Commission": ["CIVIL SERVICE COMMISSION"],
  "Commission on Human Rights": ["HUMAN RIGHTS COMMISSION"],
  "Commission on Racial Equity": ["COMMISSION ON RACIAL EQUITY", "OFFICE OF RACIAL EQUITY"],
  "Comptroller": ["OFFICE OF THE COMPTROLLER"],
  "Consumer and Worker Protection": ["CONSUMER AFFAIRS", "CONSUMER AND WORKER PROTECTION"],
  "Correction": ["DEPARTMENT OF CORRECTION"],
  "Criminal Justice Coordinator": ["CRIMINAL JUSTICE COORDINATOR", "OFFICE OF CRIMINAL JUSTICE"],
  "Cultural Affairs": ["CULTURAL AFFAIRS"],
  "Department Of Employment": ["DEPARTMENT OF EMPLOYMENT"],
  "Design and Construction": ["DESIGN AND CONSTRUCTION", "DESIGN & CONSTRUCTION", "DEPT. OF DESIGN & CONSTRUCTION", "Department of Design and Construction"],
  "District Attorney - Kings County": ["DISTRICT ATTORNEY KINGS COUNTY", "Brooklyn District Attorney's Office"],
  "District Attorney - New York County": ["DISTRICT ATTORNEY-MANHATTAN", "Manhattan District Attorney's Office"],
  "District Attorney - Queens County": ["DISTRICT ATTORNEY QNS COUNTY", "Queens District Attorney's Office"],
  "District Attorney - Richmond County": ["DISTRICT ATTORNEY RICHMOND COU", "Staten Island District Attorney's Office"],
  "District Attorney - Bronx County": ["BRONX DISTRICT ATTORNEY", "Bronx District Attorney's Office"],
  "Districting Commission": ["DISTRICTING COMMISSION"],
  "Education": ["DEPARTMENT OF EDUCATION ADMIN"],
  "Emergency Management": ["OFFICE OF EMERGENCY MANAGEMENT"],
  "Employees' Retirement System": ["NYC EMPLOYEES RETIREMENT SYS"],
  "Environmental Protection": ["DEPT OF ENVIRONMENT PROTECTION"],
  "Finance": ["DEPARTMENT OF FINANCE"],
  "Financial Information Services Agency": ["FINANCIAL INFO SVCS AGENCY"],
  "Fire Department": ["FIRE DEPARTMENT"],
  "Health and Mental Hygiene": ["DEPT OF HEALTH/MENTAL HYGIENE", "DEPT OF MH MR AND ALC SVCS"],
  "Homeless Services": ["DEPT. OF HOMELESS SERVICES"],
  "Housing Authority": ["NYCHA", "N.Y.C. HOUSING AUTHORITY", "NYC HOUSING AUTHORITY", "NEW YORK CITY HOUSING AUTHORITY"],
  "Housing Preservation and Development": ["HOUSING PRESERVATION & DVLPMNT", "Department of Housing Preservation and Development", "HPD - NYC Dept of Housing Preservation & Development", "HPD - NYC Dept of Housing Preservation and Development"],
  "Human Resources Administration": ["HRA/DEPT OF SOCIAL SERVICES", "Dept. of Social Svcs/Human Resources Administration"],
  "Independent Budget Office": ["INDEPENDENT BUDGET OFFICE"],
  "Information Technology and Telecommunications": ["DEPT OF INFO TECH & TELECOMM", "TECHNOLOGY & INNOVATION", "Office of Technology and Innovation", "Office of Technology & Innovation"],
  "Investigation": ["DEPARTMENT OF INVESTIGATION"],
  "Juvenile Justice": ["DEPARTMENT OF JUVENILE JUSTICE"],
  "Landmarks Preservation Commission": ["LANDMARKS PRESERVATION COMM", "LPC - NYC Landmarks Preservation Commission"],
  "Law Department": ["LAW DEPARTMENT"],
  "Management and Budget": ["OFFICE OF MANAGEMENT AND BUDGET", "OFFICE OF MANAGEMENT & BUDGET"],
  "Mayor's Office of Contract Services": ["MAYORS OFFICE OF CONTRACT SVCS"],
  "New York City Fire Pension Fund": ["NYC FIRE PENSION FUND"],
  "NYC Department of Veterans' Services": ["NYC DEPT OF VETERANS SERVICES", "NYC DEPT OF VETERANS' SERVICES", "Veterans' Services"],
  "Office of Collective Bargaining": ["OFFICE OF COLLECTIVE BARGAININ"],
  "Office of Labor Relations": ["OFFICE OF LABOR RELATIONS"],
  "Office of Special Narcotics Prosecutor": ["DISTRICT ATTORNEY-SPECIAL NARC", "Office of Special Narcotics Prose", "Office of the Special Narcotics Prosecutor"],
  "Office of The Actuary": ["OFFICE OF THE ACTUARY"],
  "Office of the Mayor": ["OFFICE OF THE MAYOR"],
  "Payroll Administration": ["OFF OF PAYROLL ADMINISTRATION"],
  "Parks and Recreation": ["DEPT OF PARKS & RECREATION", "Department of Parks and Recreation", "DPR - Department of Parks & Recreation NYC", "DPR - Department of Parks and Recreation NYC"],
  "Police Department": ["POLICE DEPARTMENT"],
  "Probation": ["DEPARTMENT OF PROBATION"],
  "Public Advocate": ["PUBLIC ADVOCATE"],
  "Records and Information Services": ["DEPT OF RECORDS & INFO SERVICE"],
  "Sanitation": ["DEPARTMENT OF SANITATION"],
  "Small Business Services": ["DEPARTMENT OF BUSINESS SERV.", "Department of Business Services", "Department of Small Business Services", "DEPARTMENT OF SMALL BUSINESS SERVICES"],
  "Tax Commission": ["TAX COMMISSION"],
  "Taxi and Limousine Commission": ["TAXI & LIMOUSINE COMMISSION"],
  "Teachers' Retirement System": ["TEACHERS RETIREMENT SYSTEM"],
  "Transportation": ["DEPARTMENT OF TRANSPORTATION"],
  "Youth and Community Development": ["DEPT OF YOUTH & COMM DEV SRVS"],
});

// Reviewed route dispositions for the constellation sources that do not use a
// publisher-crosswalk id. These are exact aliases or explicit non-merges, not
// fuzzy name guesses. Keep the full residual classified so a new source id
// cannot silently become a public route.
export const AGENCY_ROUTE_CLASSIFICATIONS = Object.freeze([
  { source_id: "board-meetings", source_name: "Board Meetings", classification: "unresolved", canonical_id: "board-meetings", canonical_name: "Board Meetings", basis: "generic publisher label does not identify one agency" },
  { source_id: "board-of-corrections", source_name: "Board Of Corrections", classification: "alias_to_canonical", canonical_id: "board-of-correction", canonical_name: "Board of Correction", basis: "punctuation-insensitive singular/plural publisher alias" },
  { source_id: "dcasdivision-of-municipal-supply-service", source_name: "DCASDIVISION OF MUNICIPAL SUPPLY SERVICE", classification: "alias_to_canonical", canonical_id: "citywide-administrative-services", canonical_name: "Citywide Administrative Services", basis: "named DCAS division" },
  { source_id: "department-of-social-services", source_name: "Department of Social Services", classification: "legitimate_non_crosswalk_entity", canonical_id: "department-of-social-services", canonical_name: "Department of Social Services", basis: "publisher body retained separately from its HRA and Homeless Services components" },
  { source_id: "district-attorney-special-narcotics", source_name: "District Attorney - Special Narcotics", classification: "alias_to_canonical", canonical_id: "office-of-special-narcotics-prosecutor", canonical_name: "Office of Special Narcotics Prosecutor", basis: "reviewed publisher rename" },
  { source_id: "hra-department-of-social-services", source_name: "HRA/Department Of Social Services", classification: "alias_to_canonical", canonical_id: "human-resources-administration", canonical_name: "Human Resources Administration", basis: "publisher crosswalk variant" },
  { source_id: "mayoralty", source_name: "Mayoralty", classification: "alias_to_canonical", canonical_id: "office-of-the-mayor", canonical_name: "Office of the Mayor", basis: "publisher budget-code identity" },
  { source_id: "n-y-c-housing-authority", source_name: "N.Y.C. Housing Authority", classification: "alias_to_canonical", canonical_id: "housing-authority", canonical_name: "Housing Authority", basis: "punctuation-only publisher alias" },
  { source_id: "n-y-c-transit-authority", source_name: "N.Y.C. Transit Authority", classification: "legitimate_non_crosswalk_entity", canonical_id: "n-y-c-transit-authority", canonical_name: "N.Y.C. Transit Authority", basis: "distinct MTA operating authority; no parent merge" },
  { source_id: "new-york-city-fire-pension-fund", source_name: "New York City Fire Pension Fund", classification: "legitimate_non_crosswalk_entity", canonical_id: "new-york-city-fire-pension-fund", canonical_name: "New York City Fire Pension Fund", basis: "distinct pension fund absent from the publisher identity set" },
  { source_id: "new-york-city-police-department", source_name: "New York City Police Department", classification: "alias_to_canonical", canonical_id: "police-department", canonical_name: "Police Department", basis: "publisher crosswalk canonical name" },
  { source_id: "nyc-employees-retirement-system", source_name: "NYC Employees' Retirement System", classification: "alias_to_canonical", canonical_id: "employees-retirement-system", canonical_name: "Employees' Retirement System", basis: "punctuation and city-prefix publisher alias" },
  { source_id: "nyc-health-and-hospitals-corporation", source_name: "NYC Health And Hospitals Corporation", classification: "alias_to_canonical", canonical_id: "nyc-health-hospitals", canonical_name: "NYC Health + Hospitals", basis: "reviewed publisher former-name alias" },
  { source_id: "nyc-police-pension-fund", source_name: "NYC Police Pension Fund", classification: "alias_to_canonical", canonical_id: "new-york-city-police-pension-fund", canonical_name: "New York City Police Pension Fund", basis: "publisher crosswalk canonical name" },
  { source_id: "office-of-administrative-trials-and-hearings", source_name: "Office Of Administrative Trials And Hearings", classification: "alias_to_canonical", canonical_id: "administrative-trials-and-hearings", canonical_name: "Administrative Trials and Hearings", basis: "department-prefix publisher alias" },
  { source_id: "office-of-contract-services", source_name: "Office Of Contract Services", classification: "alias_to_canonical", canonical_id: "mayors-office-of-contract-services", canonical_name: "Mayor's Office of Contract Services", basis: "publisher crosswalk canonical office" },
  { source_id: "office-of-criminal-justice-002", source_name: "Office Of Criminal Justice (002)", classification: "alias_to_canonical", canonical_id: "mayors-office-of-criminal-justice", canonical_name: "Mayor's Office of Criminal Justice", basis: "publisher budget-code identity" },
  { source_id: "office-of-payroll-administration", source_name: "Office Of Payroll Administration", classification: "alias_to_canonical", canonical_id: "payroll-administration", canonical_name: "Payroll Administration", basis: "department-prefix publisher alias" },
  { source_id: "office-of-the-chief-medical-examiner", source_name: "Office Of The Chief Medical Examiner", classification: "alias_to_canonical", canonical_id: "chief-medical-examiner", canonical_name: "Office of the Chief Medical Examiner", basis: "department-prefix publisher alias" },
  { source_id: "triborough-bridge-and-tunnel-authority", source_name: "Triborough Bridge And Tunnel Authority", classification: "legitimate_non_crosswalk_entity", canonical_id: "triborough-bridge-and-tunnel-authority", canonical_name: "Triborough Bridge and Tunnel Authority", basis: "distinct MTA operating authority; no parent merge" },
].map((row) => Object.freeze(row)));

const ROUTE_CLASSIFICATION_BY_ID = new Map(
  AGENCY_ROUTE_CLASSIFICATIONS.map((row) => [row.source_id, row]),
);
const ROUTE_TARGET_BY_ID = new Map();
for (const row of AGENCY_ROUTE_CLASSIFICATIONS) {
  if (!ROUTE_TARGET_BY_ID.has(row.canonical_id)) ROUTE_TARGET_BY_ID.set(row.canonical_id, []);
  ROUTE_TARGET_BY_ID.get(row.canonical_id).push(row);
}

function stripDisplaySuffix(value) {
  return String(value || "")
    .replace(/\s+\([A-Z][A-Z0-9+&./-]{1,15}\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function agencyComparisonKey(value) {
  return stripDisplaySuffix(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " AND ")
    .replace(/[’']/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PREFERRED_BY_KEY = new Map();
const GROUP_BY_ID = new Map();
for (const [canonical, variants] of Object.entries(AGENCY_GROUPS)) {
  const canonical_id = agencyCanonicalId(canonical);
  const group = Object.freeze({ canonical_id, canonical_name: canonical, variants: Object.freeze([canonical, ...variants]), matched: true });
  GROUP_BY_ID.set(canonical_id, group);
  for (const value of group.variants) PREFERRED_BY_KEY.set(agencyComparisonKey(value), group);
}

function patternCanonical(raw, key) {
  if (/\bCOMMUNITY B(?:OAR)?D\b/.test(key)) return "Community Boards";
  if (key.includes("COMMUNITY COLLEGE") || key === "CUNY CENTRAL OFFICE" || key === "HUNTER COLLEGE HIGH SCHOOL") return "City University";
  if (key === "BOARD OF ELECTION POLL WORKERS") return "Board of Elections";
  if (key === "PUBLIC SERVICE CORPS") return "Citywide Administrative Services";
  if (key === "BRONX DISTRICT ATTORNEY") return "District Attorney - Bronx County";
  if (key === "PUBLIC ADMINISTRATOR BRONX") return "Public Administrator - Bronx County";
  if (key === "PUBLIC ADMINISTRATOR KINGS") return "Public Administrator - Kings County";
  if (key === "PUBLIC ADMINISTRATOR NEW YORK") return "Public Administrator - New York County";
  if (key === "PUBLIC ADMINISTRATOR QUEENS") return "Public Administrator - Queens County";
  if (key === "PUBLIC ADMINISTRATOR RICHMOND") return "Public Administrator - Richmond County";
  return raw;
}

function fallbackName(raw) {
  return raw !== raw.toUpperCase() ? raw : raw.toLowerCase().replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

export function agencyCanonicalId(name) {
  return agencyComparisonKey(name).toLowerCase().replace(/\s+/g, "-");
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function classifiedRouteIdentity(value, { includeSuperseded = false } = {}) {
  const sourceId = agencyCanonicalId(value);
  const sourceDecision = ROUTE_CLASSIFICATION_BY_ID.get(sourceId);
  const decision = sourceDecision?.classification === "alias_to_canonical"
    && sourceDecision.source_id !== sourceDecision.canonical_id
    && !includeSuperseded
    ? null
    : sourceDecision;
  const targetRows = ROUTE_TARGET_BY_ID.get(sourceId) || [];
  if (!decision && !targetRows.length) return null;
  const selected = decision || targetRows[0];
  return Object.freeze({
    canonical_id: selected.canonical_id,
    canonical_name: selected.canonical_name,
    variants: Object.freeze(uniqueStrings([
      selected.canonical_name,
      ...targetRows.map((row) => row.source_name),
      value,
    ])),
    matched: selected.classification !== "unresolved",
    route_classification: decision?.classification || "canonical_route",
    superseded_id: decision?.classification === "alias_to_canonical" ? decision.source_id : null,
  });
}

export function resolveAgencyIdentity(value) {
  const raw = stripDisplaySuffix(value);
  const classified = classifiedRouteIdentity(raw);
  if (classified) return classified;
  const routeId = raw.toLowerCase();
  if (GROUP_BY_ID.has(routeId)) return GROUP_BY_ID.get(routeId);
  const key = agencyComparisonKey(raw);
  let group = PREFERRED_BY_KEY.get(key);
  if (!group) {
    const withoutDepartment = key.replace(/^(?:NYC )?(?:DEPARTMENT|DEPT) OF /, "");
    group = PREFERRED_BY_KEY.get(withoutDepartment);
  }
  if (group) return group;
  const canonical_name = fallbackName(patternCanonical(raw, key));
  const canonical_id = agencyCanonicalId(canonical_name);
  return Object.freeze({ canonical_id, canonical_name, variants: Object.freeze([raw || canonical_name].filter(Boolean)), matched: false });
}

/** Convert the committed publisher bundle into the row shape used by reconciliation. */
export function publisherAgencyRows(crosswalk) {
  const entries = crosswalk?.entries && typeof crosswalk.entries === "object"
    ? crosswalk.entries
    : (crosswalk && !Array.isArray(crosswalk) && typeof crosswalk === "object" ? crosswalk : {});
  return Object.entries(entries).map(([canonical_id, entry]) => Object.freeze({
    canonical_id,
    canonical_name: String(entry?.canonical_name || canonical_id).trim(),
    variants: Object.freeze(uniqueStrings(entry?.variants || [])),
  }));
}

function publisherIndex(rows) {
  const byId = new Map();
  const idsByKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const canonical_id = String(row?.canonical_id || "").trim();
    if (!canonical_id) continue;
    const canonical_name = String(row?.canonical_name || canonical_id).trim();
    const variants = uniqueStrings([canonical_name, row?.raw_string, ...(Array.isArray(row?.variants) ? row.variants : [])]);
    const normalized = { canonical_id, canonical_name, variants };
    byId.set(canonical_id, normalized);
    for (const surface of [canonical_id, ...variants]) {
      const key = agencyComparisonKey(surface);
      if (!key) continue;
      if (!idsByKey.has(key)) idsByKey.set(key, new Set());
      idsByKey.get(key).add(canonical_id);
    }
  }
  return { byId, idsByKey };
}

export function agencyPublisherCollisions(rows) {
  const { byId, idsByKey } = publisherIndex(rows);
  return [...idsByKey.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([comparison_key, ids]) => ({
      comparison_key,
      canonical_ids: [...ids].sort(),
      canonical_names: [...ids].sort().map((id) => byId.get(id)?.canonical_name || id),
    }))
    .sort((left, right) => left.comparison_key.localeCompare(right.comparison_key));
}

/**
 * Expand a routed identity with the live City Record crosswalk. This is what
 * makes an id-only document route reversible even for agencies outside the
 * small reviewed alias table: every exact source spelling assigned to the id
 * comes back into the query set.
 */
export function reconcileAgencyIdentity(value, rows) {
  const local = classifiedRouteIdentity(value, { includeSuperseded: true })
    || resolveAgencyIdentity(value);
  const list = Array.isArray(rows) ? rows : publisherAgencyRows(rows);
  const { byId, idsByKey } = publisherIndex(list);
  const inputKey = agencyComparisonKey(value);
  const exactIds = idsByKey.get(inputKey) || new Set();
  const directPublisherId = String(value || "").trim().toLowerCase();
  const directPublisher = byId.has(directPublisherId) ? directPublisherId : null;
  if (!directPublisher && exactIds.size > 1) {
    return Object.freeze({
      ...local,
      matched: false,
      route_classification: "publisher_collision",
      collision_ids: Object.freeze([...exactIds].sort()),
    });
  }
  const exactId = directPublisher || (exactIds.size === 1 ? [...exactIds][0] : null);
  const decision = ROUTE_CLASSIFICATION_BY_ID.get(agencyCanonicalId(value));
  const canonical_id = String(
    decision?.canonical_id
      || exactId
      || (byId.has(local.canonical_id) ? local.canonical_id : "")
      || local.canonical_id
      || "",
  ).trim();
  const publisher = byId.get(canonical_id);
  if (!publisher) return local;
  const canonical_name = String(publisher.canonical_name || local.canonical_name).trim();
  // The crosswalk variant bag is load-bearing for exact agency-scoped source
  // queries. Reconciliation may add local spellings, but never replace it.
  const variants = uniqueStrings([
    ...publisher.variants,
    ...(Array.isArray(local.variants) ? local.variants : []),
    value,
    canonical_name,
  ]);
  return Object.freeze({
    canonical_id,
    canonical_name,
    variants: Object.freeze(variants),
    matched: true,
    route_classification: local.route_classification || "publisher_crosswalk",
    superseded_id: local.superseded_id || null,
  });
}

export function agencyRouteAliasTarget(value) {
  const decision = ROUTE_CLASSIFICATION_BY_ID.get(agencyCanonicalId(value));
  return decision?.classification === "alias_to_canonical" ? decision.canonical_id : null;
}

export function canonicalAgency(value) {
  const { canonical_id, canonical_name } = resolveAgencyIdentity(value);
  return { canonical_id, canonical_name };
}
