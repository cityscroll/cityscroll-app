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
  "Housing Authority": ["NYCHA", "N.Y.C. HOUSING AUTHORITY", "NEW YORK CITY HOUSING AUTHORITY"],
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

export function resolveAgencyIdentity(value) {
  const raw = stripDisplaySuffix(value);
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

/**
 * Expand a routed identity with the live City Record crosswalk. This is what
 * makes an id-only document route reversible even for agencies outside the
 * small reviewed alias table: every exact source spelling assigned to the id
 * comes back into the query set.
 */
export function reconcileAgencyIdentity(value, rows) {
  const local = resolveAgencyIdentity(value);
  const list = Array.isArray(rows) ? rows : [];
  const inputKey = agencyComparisonKey(value);
  const sourceMatch = list.find((row) => agencyComparisonKey(row?.raw_string) === inputKey);
  const canonical_id = String(sourceMatch?.canonical_id || local.canonical_id || "").trim();
  const grouped = list.filter((row) => String(row?.canonical_id || "").trim() === canonical_id);
  if (!grouped.length) return local;
  const canonical_name = String(grouped.find((row) => row?.canonical_name)?.canonical_name || local.canonical_name).trim();
  const variants = [...new Set(grouped.flatMap((row) => [row?.raw_string, ...(Array.isArray(row?.variants) ? row.variants : [])])
    .map((item) => String(item || "").trim()).filter(Boolean))];
  return Object.freeze({
    canonical_id,
    canonical_name,
    variants: Object.freeze(variants),
    matched: true,
  });
}

export function canonicalAgency(value) {
  const { canonical_id, canonical_name } = resolveAgencyIdentity(value);
  return { canonical_id, canonical_name };
}
