// Shared browser/Worker agency-name reconciliation.
//
// City Record publishes agency_name as free text. These reviewed groups keep a
// stable route id while preserving every source spelling for exact source queries.
//
// OTI former-name densify (tools/build_agency_successors.mjs) stamps publisher
// former_names onto worker/src/data/agency_crosswalk.json and measures the kill
// sample. Residual renames that must share a route id are folded into
// AGENCY_GROUPS / ROUTE_ALIAS_TARGETS here so the home cold path stays free of
// a bulk alias module (home.cold wireBytes budget).

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
  "Consumer and Worker Protection": ["CONSUMER AFFAIRS", "CONSUMER AND WORKER PROTECTION", "Department of Consumer Affairs", "Department of Consumer and Worker Protection"],
  "Correction": ["DEPARTMENT OF CORRECTION"],
  "Criminal Justice Coordinator": ["CRIMINAL JUSTICE COORDINATOR", "OFFICE OF CRIMINAL JUSTICE"],
  "Cultural Affairs": ["CULTURAL AFFAIRS"],
  "Department Of Employment": ["DEPARTMENT OF EMPLOYMENT"],
  "Design and Construction": ["DESIGN AND CONSTRUCTION", "DESIGN & CONSTRUCTION", "DEPT. OF DESIGN & CONSTRUCTION", "Department of Design and Construction"],
  "District Attorney - Kings County": ["DISTRICT ATTORNEY KINGS COUNTY", "Brooklyn District Attorney's Office", "Kings County District Attorney's Office"],
  "District Attorney - New York County": ["DISTRICT ATTORNEY-MANHATTAN", "Manhattan District Attorney's Office", "New York County District Attorney's Office"],
  "District Attorney - Queens County": ["DISTRICT ATTORNEY QNS COUNTY", "Queens District Attorney's Office", "Queens County District Attorney's Office"],
  "District Attorney - Richmond County": ["DISTRICT ATTORNEY RICHMOND COU", "Staten Island District Attorney's Office", "Richmond County District Attorney's Office"],
  "District Attorney - Bronx County": ["BRONX DISTRICT ATTORNEY", "Bronx District Attorney's Office", "Bronx County District Attorney's Office"],
  "Districting Commission": ["DISTRICTING COMMISSION"],
  "Education": ["DEPARTMENT OF EDUCATION ADMIN", "Department of Education", "New York City Public Schools", "NYC Public Schools"],
  "Emergency Management": ["OFFICE OF EMERGENCY MANAGEMENT", "Office of Emergency Management", "New York City Emergency Management", "NYC Emergency Management"],
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
  "Information Technology and Telecommunications": ["DEPT OF INFO TECH & TELECOMM", "TECHNOLOGY & INNOVATION", "Office of Technology and Innovation", "Office of Technology & Innovation", "Department of Information Technology and Telecommunications"],
  "Investigation": ["DEPARTMENT OF INVESTIGATION"],
  "Juvenile Justice": ["DEPARTMENT OF JUVENILE JUSTICE"],
  "Landmarks Preservation Commission": ["LANDMARKS PRESERVATION COMM", "LPC - NYC Landmarks Preservation Commission"],
  "Law Department": ["LAW DEPARTMENT"],
  "Management and Budget": ["OFFICE OF MANAGEMENT AND BUDGET", "OFFICE OF MANAGEMENT & BUDGET"],
  "Mayor's Office of Contract Services": ["MAYORS OFFICE OF CONTRACT SVCS"],
  "Mayor's Office to End Domestic and Gender-Based Violence": ["Mayor's Office to Combat Domestic Violence"],
  "New York City Fire Pension Fund": ["NYC FIRE PENSION FUND"],
  "NYC Department of Veterans' Services": ["NYC DEPT OF VETERANS SERVICES", "NYC DEPT OF VETERANS' SERVICES", "Veterans' Services"],
  "Office of Collective Bargaining": ["OFFICE OF COLLECTIVE BARGAININ"],
  "Office of Labor Relations": ["OFFICE OF LABOR RELATIONS"],
  "Office of Special Narcotics Prosecutor": ["DISTRICT ATTORNEY-SPECIAL NARC", "Office of Special Narcotics Prose", "Office of the Special Narcotics Prosecutor"],
  "Office of The Actuary": ["OFFICE OF THE ACTUARY"],
  "Office of the Mayor": ["OFFICE OF THE MAYOR", "Mayor's Office"],
  "Payroll Administration": ["OFF OF PAYROLL ADMINISTRATION"],
  "Parks and Recreation": ["DEPT OF PARKS & RECREATION", "Department of Parks and Recreation", "DPR - Department of Parks & Recreation NYC", "DPR - Department of Parks and Recreation NYC"],
  "Police Department": ["POLICE DEPARTMENT"],
  "Probation": ["DEPARTMENT OF PROBATION"],
  "Public Advocate": ["PUBLIC ADVOCATE"],
  "Public Design Commission": ["Art Commission"],
  "Records and Information Services": ["DEPT OF RECORDS & INFO SERVICE"],
  "Sanitation": ["DEPARTMENT OF SANITATION"],
  "Small Business Services": ["DEPARTMENT OF BUSINESS SERV.", "Department of Business Services", "Department of Small Business Services", "DEPARTMENT OF SMALL BUSINESS SERVICES"],
  "Tax Commission": ["TAX COMMISSION"],
  "Taxi and Limousine Commission": ["TAXI & LIMOUSINE COMMISSION"],
  "Teachers' Retirement System": ["TEACHERS RETIREMENT SYSTEM"],
  "Transportation": [
    "DEPARTMENT OF TRANSPORTATION",
    "NYC DOT Department of Transportation",
    "NYC Department of Transportation",
    "New York City Department of Transportation",
  ],
  "Youth and Community Development": ["DEPT OF YOUTH & COMM DEV SRVS"],
});

const ROUTE_ALIAS_TARGETS = new Map([
  ["board-of-corrections", "board-of-correction"],
  ["dcasdivision-of-municipal-supply-service", "citywide-administrative-services"],
  ["district-attorney-special-narcotics", "office-of-special-narcotics-prosecutor"],
  ["hra-department-of-social-services", "human-resources-administration"],
  ["mayoralty", "office-of-the-mayor"],
  ["n-y-c-housing-authority", "housing-authority"],
  ["new-york-city-emergency-management", "emergency-management"],
  ["new-york-city-police-department", "police-department"],
  ["new-york-city-public-schools", "education"],
  ["nyc-employees-retirement-system", "employees-retirement-system"],
  ["nyc-health-and-hospitals-corporation", "nyc-health-hospitals"],
  ["nyc-police-pension-fund", "new-york-city-police-pension-fund"],
  ["office-of-administrative-trials-and-hearings", "administrative-trials-and-hearings"],
  ["office-of-contract-services", "mayors-office-of-contract-services"],
  ["office-of-criminal-justice-002", "mayors-office-of-criminal-justice"],
  ["office-of-payroll-administration", "payroll-administration"],
  ["office-of-the-chief-medical-examiner", "chief-medical-examiner"],
]);
const STANDALONE_ROUTES = new Map([
  ["board-meetings", ["Board Meetings", "unresolved"]],
  ["department-of-social-services", ["Department of Social Services", "legitimate_non_crosswalk_entity"]],
  ["n-y-c-transit-authority", ["N.Y.C. Transit Authority", "legitimate_non_crosswalk_entity"]],
  ["new-york-city-fire-pension-fund", ["New York City Fire Pension Fund", "legitimate_non_crosswalk_entity"]],
  ["triborough-bridge-and-tunnel-authority", ["Triborough Bridge and Tunnel Authority", "legitimate_non_crosswalk_entity", "Triborough Bridge And Tunnel Authority"]],
]);

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
  const aliasTarget = ROUTE_ALIAS_TARGETS.get(sourceId);
  const standalone = STANDALONE_ROUTES.get(sourceId);
  const isCanonicalTarget = [...ROUTE_ALIAS_TARGETS.values()].includes(sourceId);
  if ((!includeSuperseded || !aliasTarget) && !standalone && !isCanonicalTarget) return null;
  const canonical_id = aliasTarget || sourceId;
  const canonical_name = standalone?.[0]
    || GROUP_BY_ID.get(canonical_id)?.canonical_name
    || fallbackName(canonical_id.replace(/-/g, " "));
  const classification = aliasTarget ? "alias_to_canonical" : (standalone?.[1] || "canonical_route");
  return Object.freeze({
    canonical_id,
    canonical_name,
    variants: Object.freeze(uniqueStrings([canonical_name, standalone?.[2], value])),
    matched: classification !== "unresolved",
    route_classification: classification,
    superseded_id: aliasTarget ? sourceId : null,
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

/** Reconcile a routed identity while preserving publisher source spellings. */
export function reconcileAgencyIdentity(value, rows) {
  const local = classifiedRouteIdentity(value, { includeSuperseded: true })
    || resolveAgencyIdentity(value);
  const list = Array.isArray(rows) ? rows : [];
  const inputKey = agencyComparisonKey(value);
  const exactIds = new Set(list.filter((row) => [row?.canonical_id, row?.canonical_name, row?.raw_string, ...(row?.variants || [])]
    .some((surface) => agencyComparisonKey(surface) === inputKey)).map((row) => row.canonical_id));
  const directPublisherId = String(value || "").trim().toLowerCase();
  const directPublisher = list.some((row) => row?.canonical_id === directPublisherId) ? directPublisherId : null;
  if (!directPublisher && exactIds.size > 1) {
    return Object.freeze({
      ...local,
      matched: false,
      route_classification: "publisher_collision",
      collision_ids: Object.freeze([...exactIds].sort()),
    });
  }
  const exactId = directPublisher || (exactIds.size === 1 ? [...exactIds][0] : null);
  const aliasTarget = ROUTE_ALIAS_TARGETS.get(agencyCanonicalId(value));
  const canonical_id = String(
    aliasTarget
      || exactId
      || (list.some((row) => row?.canonical_id === local.canonical_id) ? local.canonical_id : "")
      || local.canonical_id
      || "",
  ).trim();
  const publisher = list.find((row) => row?.canonical_id === canonical_id);
  if (!publisher) return local;
  const canonical_name = String(publisher.canonical_name || local.canonical_name).trim();
  // Preserve every publisher spelling for exact source queries.
  const variants = uniqueStrings([
    publisher.raw_string,
    ...(publisher.variants || []),
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
  return ROUTE_ALIAS_TARGETS.get(agencyCanonicalId(value)) || null;
}

export function canonicalAgency(value) {
  const { canonical_id, canonical_name } = resolveAgencyIdentity(value);
  return { canonical_id, canonical_name };
}
