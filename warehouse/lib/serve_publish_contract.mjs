/**
 * Shared refresh-to-publish Done contract for committed warehouse serve lookups.
 *
 * A serve is publishable only while its materialization timestamp is inside the
 * declared age window and every named field-case canary remains present.
 */

export const SERVE_LOOKUP_CONTRACTS = Object.freeze({
  ocp_awards: Object.freeze({
    id: "ocp_awards",
    label: "OCP awards",
    timestamp_field: "materialized_at",
    max_age_days: 30,
    canaries: Object.freeze([
      Object.freeze({ field: "request_id", value: "20260723031" }),
    ]),
  }),
  zap_projects: Object.freeze({
    id: "zap_projects",
    label: "ZAP projects",
    timestamp_field: "materialized_at",
    max_age_days: 7,
    canaries: Object.freeze([
      Object.freeze({ field: "project_id", value: "2025Q0331" }),
      Object.freeze({ field: "project_id", value: "2026K0123" }),
    ]),
  }),
  zap_bbl: Object.freeze({
    id: "zap_bbl",
    label: "ZAP BBL",
    timestamp_field: "materialized_at",
    max_age_days: 30,
    canaries: Object.freeze([
      Object.freeze({ field: "project_id", value: "2022M0258" }),
    ]),
  }),
  doing_business: Object.freeze({
    id: "doing_business",
    label: "Doing Business",
    timestamp_field: "materialized_at",
    max_age_days: 180,
    canaries: Object.freeze([
      Object.freeze({ field: "organization_name", value: "CAMBA  INC" }),
    ]),
  }),
  city_record_pin_chain: Object.freeze({
    id: "city_record_pin_chain",
    label: "City Record PIN-chain",
    timestamp_field: "materialized_at",
    // No daily refresh workflow yet — match Doing Business until a publish loop lands.
    max_age_days: 180,
    canaries: Object.freeze([
      Object.freeze({ field: "pin", value: "07219P0148001R004" }),
      Object.freeze({ field: "request_id", value: "20260723031" }),
    ]),
  }),
  payroll_title: Object.freeze({
    id: "payroll_title",
    label: "Payroll title mart",
    timestamp_field: "materialized_at",
    // Fiscal-year publisher; weekly refresh loop keeps this well inside the window.
    max_age_days: 180,
    canaries: Object.freeze([
      Object.freeze({ field: "title_description", value: "POLICE OFFICER" }),
      Object.freeze({ field: "title_description", value: "FIREFIGHTER" }),
    ]),
  }),
});

function normalized(value) {
  return value == null ? "" : String(value).trim();
}

function canaryLabel(canary) {
  return `${canary.field}=${JSON.stringify(canary.value)}`;
}

/**
 * Return age/canary findings for one committed serve document.
 *
 * @param {object} doc
 * @param {object} contract one entry from SERVE_LOOKUP_CONTRACTS
 * @param {{now?: Date|string|number}} [opts]
 * @returns {string[]}
 */
export function servePublishFindings(doc, contract, opts = {}) {
  const label = contract?.label || contract?.id || "warehouse serve lookup";
  const findings = [];
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];

  if (!contract || !Number.isFinite(Number(contract.max_age_days))) {
    findings.push(`${label} has no finite max_age_days contract`);
  }
  if (!Array.isArray(contract?.canaries) || contract.canaries.length === 0) {
    findings.push(`${label} has no named canaries`);
  }

  for (const canary of contract?.canaries || []) {
    const present = rows.some(
      (row) => normalized(row?.[canary.field]) === normalized(canary.value),
    );
    if (!present) findings.push(`${label} serve missing canary ${canaryLabel(canary)}`);
  }

  const timestampField = contract?.timestamp_field || "materialized_at";
  const stamped = Date.parse(String(doc?.[timestampField] || ""));
  const nowValue = opts.now instanceof Date ? opts.now.toISOString() : opts.now;
  const nowMs = Date.parse(String(nowValue || new Date().toISOString()));
  if (!Number.isFinite(stamped)) {
    findings.push(`${label} serve missing ${timestampField}`);
  } else if (!Number.isFinite(nowMs)) {
    findings.push(`${label} serve check received an invalid now value`);
  } else {
    const ageDays = (nowMs - stamped) / 86_400_000;
    if (ageDays > Number(contract.max_age_days)) {
      findings.push(
        `${label} serve age ${ageDays.toFixed(1)}d exceeds max ${contract.max_age_days}d`,
      );
    }
    if (ageDays < -1) findings.push(`${label} serve ${timestampField} is in the future`);
  }

  return findings;
}

export function assertServePublishLookup(doc, contract, opts = {}) {
  const findings = servePublishFindings(doc, contract, opts);
  if (findings.length) throw new Error(findings.join("; "));
  return true;
}

export function serveTwinFindings(siteDoc, workerDoc, contract) {
  const label = contract?.label || contract?.id || "warehouse serve lookup";
  const timestampField = contract?.timestamp_field || "materialized_at";
  const findings = [];
  if (!siteDoc || !workerDoc) return [`${label} serve twins are missing`];
  if (siteDoc.schema_version !== workerDoc.schema_version) {
    findings.push(`${label} serve twins disagree on schema_version`);
  }
  if (siteDoc[timestampField] !== workerDoc[timestampField]) {
    findings.push(`${label} serve twins disagree on ${timestampField}`);
  }
  if (JSON.stringify(siteDoc.rows) !== JSON.stringify(workerDoc.rows)) {
    findings.push(`${label} serve twins disagree on rows`);
  }
  return findings;
}

export function assertServePublishTwins(siteDoc, workerDoc, contract, opts = {}) {
  const findings = [
    ...serveTwinFindings(siteDoc, workerDoc, contract),
    ...servePublishFindings(siteDoc, contract, opts),
    ...servePublishFindings(workerDoc, contract, opts),
  ];
  if (findings.length) throw new Error(findings.join("; "));
  return true;
}
