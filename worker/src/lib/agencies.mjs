// Agency-name reconciliation for the City Record's historical spelling conventions.
//
// The source publishes agency_name as free text. Older rows are commonly ALL-CAPS and
// abbreviated; newer rows generally use Title Case. This module gives each known spelling a
// stable site id without replacing the source string. Unknown strings remain visible under
// their own deterministic id until a reviewed alias connects them.

const GROUPS = {
  "Administration for Children's Services": [
    "ADMIN FOR CHILDREN'S SERVICES", "ADMIN FOR CHILDRENS SERVICES",
    "ADMIN FOR CHILDREN'S SVCS", "ADMIN FOR CHILDRENS SVCS", "ADMIN FOR CHILDREN' SVCS",
  ],
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
  "City Planning": ["DEPARTMENT OF CITY PLANNING"],
  "Citywide Administrative Services": ["DEPT OF CITYWIDE ADMIN SVCS"],
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
  "Design and Construction": ["DESIGN AND CONSTRUCTION", "DEPT. OF DESIGN & CONSTRUCTION"],
  "District Attorney - Kings County": [
    "DISTRICT ATTORNEY KINGS COUNTY",
    "Brooklyn District Attorney's Office",
  ],
  "District Attorney - New York County": [
    "DISTRICT ATTORNEY-MANHATTAN",
    "Manhattan District Attorney's Office",
  ],
  "District Attorney - Queens County": [
    "DISTRICT ATTORNEY QNS COUNTY",
    "Queens District Attorney's Office",
  ],
  "District Attorney - Richmond County": [
    "DISTRICT ATTORNEY RICHMOND COU",
    "Staten Island District Attorney's Office",
  ],
  "District Attorney - Bronx County": [
    "BRONX DISTRICT ATTORNEY",
    "Bronx District Attorney's Office",
  ],
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
  "Housing Preservation and Development": ["HOUSING PRESERVATION & DVLPMNT"],
  "Human Resources Administration": [
    "HRA/DEPT OF SOCIAL SERVICES",
    "Dept. of Social Svcs/Human Resources Administration",
  ],
  "Independent Budget Office": ["INDEPENDENT BUDGET OFFICE"],
  // DoITT was folded into the Office of Technology and Innovation; keep the site
  // canonical_id stable (information-technology-and-telecommunications) so the
  // precompiled identity crosswalk continues to key the same enrichment card.
  "Information Technology and Telecommunications": [
    "DEPT OF INFO TECH & TELECOMM",
    "TECHNOLOGY & INNOVATION",
    "Office of Technology and Innovation",
    "Office of Technology & Innovation",
  ],
  "Investigation": ["DEPARTMENT OF INVESTIGATION"],
  "Juvenile Justice": ["DEPARTMENT OF JUVENILE JUSTICE"],
  "Landmarks Preservation Commission": ["LANDMARKS PRESERVATION COMM"],
  "Law Department": ["LAW DEPARTMENT"],
  "Management and Budget": ["OFFICE OF MANAGEMENT AND BUDGET", "OFFICE OF MANAGEMENT & BUDGET"],
  "Mayor's Office of Contract Services": ["MAYORS OFFICE OF CONTRACT SVCS"],
  "New York City Fire Pension Fund": ["NYC FIRE PENSION FUND"],
  "NYC Department of Veterans' Services": [
    "NYC DEPT OF VETERANS SERVICES", "NYC DEPT OF VETERANS' SERVICES", "Veterans' Services",
  ],
  "Office of Collective Bargaining": ["OFFICE OF COLLECTIVE BARGAININ"],
  "Office of Labor Relations": ["OFFICE OF LABOR RELATIONS"],
  "Office of Special Narcotics Prosecutor": [
    "DISTRICT ATTORNEY-SPECIAL NARC", "Office of Special Narcotics Prose",
    "Office of the Special Narcotics Prosecutor",
  ],
  "Office of The Actuary": ["OFFICE OF THE ACTUARY"],
  "Office of the Mayor": ["OFFICE OF THE MAYOR"],
  "Payroll Administration": ["OFF OF PAYROLL ADMINISTRATION"],
  "Parks and Recreation": ["DEPT OF PARKS & RECREATION"],
  "Police Department": ["POLICE DEPARTMENT"],
  "Probation": ["DEPARTMENT OF PROBATION"],
  "Public Advocate": ["PUBLIC ADVOCATE"],
  "Records and Information Services": ["DEPT OF RECORDS & INFO SERVICE"],
  "Sanitation": ["DEPARTMENT OF SANITATION"],
  "Small Business Services": [
    "DEPARTMENT OF BUSINESS SERV.",
    "Department of Business Services",
    "Department of Small Business Services",
    "DEPARTMENT OF SMALL BUSINESS SERVICES",
  ],
  "Tax Commission": ["TAX COMMISSION"],
  "Taxi and Limousine Commission": ["TAXI & LIMOUSINE COMMISSION"],
  "Teachers' Retirement System": ["TEACHERS RETIREMENT SYSTEM"],
  "Transportation": ["DEPARTMENT OF TRANSPORTATION"],
  "Youth and Community Development": ["DEPT OF YOUTH & COMM DEV SRVS"],
};

function comparisonKey(value) {
  return String(value || "")
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
for (const [canonical, variants] of Object.entries(GROUPS)) {
  for (const value of [canonical, ...variants]) PREFERRED_BY_KEY.set(comparisonKey(value), canonical);
}

function patternCanonical(raw, key) {
  if (/\bCOMMUNITY B(?:OAR)?D\b/.test(key)) return "Community Boards";
  if (key.includes("COMMUNITY COLLEGE") || key === "CUNY CENTRAL OFFICE" || key === "HUNTER COLLEGE HIGH SCHOOL") {
    return "City University";
  }
  if (key === "BOARD OF ELECTION POLL WORKERS") return "Board of Elections";
  if (key === "PUBLIC SERVICE CORPS") return "Citywide Administrative Services";
  // Bronx DA is also in GROUPS; pattern remains a safety net for spelling drift.
  if (key === "BRONX DISTRICT ATTORNEY") return "District Attorney - Bronx County";
  if (key === "PUBLIC ADMINISTRATOR BRONX") return "Public Administrator - Bronx County";
  if (key === "PUBLIC ADMINISTRATOR KINGS") return "Public Administrator - Kings County";
  if (key === "PUBLIC ADMINISTRATOR NEW YORK") return "Public Administrator - New York County";
  if (key === "PUBLIC ADMINISTRATOR QUEENS") return "Public Administrator - Queens County";
  if (key === "PUBLIC ADMINISTRATOR RICHMOND") return "Public Administrator - Richmond County";
  return raw;
}

function fallbackName(raw) {
  if (raw !== raw.toUpperCase()) return raw;
  return raw.toLowerCase().replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

function canonicalId(name) {
  return comparisonKey(name).toLowerCase().replace(/\s+/g, "-");
}

export function canonicalAgency(value) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  const key = comparisonKey(raw);
  const preferred = PREFERRED_BY_KEY.get(key);
  const canonical_name = preferred || fallbackName(patternCanonical(raw, key));
  return { canonical_id: canonicalId(canonical_name), canonical_name };
}

function rawSort(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildAgencyCrosswalk(sourceRows) {
  const rawRows = new Set();
  for (const source of Array.isArray(sourceRows) ? sourceRows : []) {
    const raw = String(source?.agency_name || "").replace(/\s+/g, " ").trim();
    if (!raw) continue;
    rawRows.add(raw);
  }

  const base = [...rawRows].map((raw_string) => ({
    raw_string,
    ...canonicalAgency(raw_string),
  }));
  const variantsById = new Map();
  for (const row of base) {
    if (!variantsById.has(row.canonical_id)) variantsById.set(row.canonical_id, []);
    variantsById.get(row.canonical_id).push(row.raw_string);
  }
  for (const variants of variantsById.values()) variants.sort(rawSort);

  const rows = base
    .sort((a, b) => rawSort(a.raw_string, b.raw_string))
    .map((row) => ({ ...row, variants: variantsById.get(row.canonical_id) }));
  return {
    row_count: rows.length,
    canonical_count: variantsById.size,
    rows,
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function crosswalkCSV(rows) {
  const header = ["raw_string", "canonical_id", "canonical_name", "variants"];
  const lines = (Array.isArray(rows) ? rows : []).map((row) => [
    row.raw_string,
    row.canonical_id,
    row.canonical_name,
    JSON.stringify(row.variants || []),
  ].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\n") + "\n";
}
