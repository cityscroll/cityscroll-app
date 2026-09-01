/**
 * Measurement-only Citywide Payroll → Community Board identity.
 *
 * Source-scoped exact `payroll_number` bindings, corroborated by the
 * publisher's exact agency_name spelling. Does not extend CB-MONEY-00's
 * financial source list. Individual employee rows never enter a served
 * contract.
 */

export const COMMUNITY_BOARD_PAYROLL_IDENTITY_SCHEMA = "cityscroll.community_board_payroll_identity.v1";
export const COMMUNITY_BOARD_PAYROLL_IDENTITY_VERSION = 1;
export const COMMUNITY_BOARD_PAYROLL_SOURCE = "citywide_payroll";
export const COMMUNITY_BOARD_PAYROLL_NATIVE_KEY_FIELD = "payroll_number";
export const COMMUNITY_BOARD_PAYROLL_DATASET = "k397-673e";
export const COMMUNITY_BOARD_PAYROLL_CONTEXT_SCHEMA = "cityscroll.community_board_payroll_context.v2";
export const COMMUNITY_BOARD_PAYROLL_CONTEXT_VERSION = 2;
export const COMMUNITY_BOARD_PAYROLL_STAFF_COUNT_SCHEMA = COMMUNITY_BOARD_PAYROLL_CONTEXT_SCHEMA;
export const COMMUNITY_BOARD_PAYROLL_STAFF_COUNT_VERSION = COMMUNITY_BOARD_PAYROLL_CONTEXT_VERSION;
const WITHHELD_VALUE_FIELDS = Object.freeze([
  "base_salary",
  "gross",
  "ot",
  "avg",
  "mn",
  "mx",
]);

const BOARD_ID = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const EXACT_BOARD_NAME = /^(.+?)\s+COMMUNITY BOARD\s*#?\s*(\d+)$/i;
const EXACT_BOARD_BD_NAME = /^(.+?)\s+COMMUNITY BD\s*#?\s*(\d+)$/i;
const EMPLOYEE_FIELDS = Object.freeze([
  "last_name",
  "first_name",
  "mid_init",
  "middle_initial",
  "employee_id",
  "ssn",
  "social_security",
  "date_of_birth",
]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function payrollNumberKey(value) {
  const text = clean(value);
  if (!/^\d+$/.test(text)) return null;
  return String(Number(text));
}

function boroughSlug(value) {
  return clean(value).toLowerCase().replace(/\s+/g, "-");
}

/**
 * Exact publisher-label corroboration. Accepts the two OPA spellings
 * (`COMMUNITY BOARD` and the Staten Island `COMMUNITY BD` abbreviation)
 * as distinct exact patterns. Geography and similarity are not identity.
 */
export function boardIdFromPayrollPublisherName(value) {
  const label = clean(value);
  const match = label.match(EXACT_BOARD_NAME) || label.match(EXACT_BOARD_BD_NAME);
  if (!match) return null;
  const district = String(Number(match[2]));
  if (!district || Number(match[2]) < 1) return null;
  return `${boroughSlug(match[1])}-cb-${district.padStart(2, "0")}`;
}

export function expenseBudgetCodeIndex(registry) {
  const index = new Map();
  for (const binding of Array.isArray(registry?.bindings) ? registry.bindings : []) {
    if (binding?.source_system !== "expense_budget" || binding?.binding_status !== "accepted") continue;
    const code = payrollNumberKey(binding.source_native_board_key);
    if (!code || !BOARD_ID.test(String(binding.board_id || ""))) continue;
    const prior = index.get(code);
    if (prior && prior.board_id !== binding.board_id) {
      index.set(code, { ...prior, ambiguous: true });
      continue;
    }
    index.set(code, {
      board_id: binding.board_id,
      expense_budget_publisher_identity: binding.publisher_identity,
      ambiguous: false,
    });
  }
  return index;
}

function employeeFieldFindings(value, path = "row") {
  const findings = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return findings;
  for (const key of Object.keys(value)) {
    const lower = String(key).toLowerCase();
    if (EMPLOYEE_FIELDS.includes(lower) || /(?:^|_)(?:first|last)_name$/.test(lower)) {
      findings.push(`${path} carries employee field ${JSON.stringify(key)}`);
    }
  }
  return findings;
}

export function payrollIdentityEmployeeFindings(docOrRow) {
  if (!docOrRow || typeof docOrRow !== "object") return [];
  if (Array.isArray(docOrRow?.identities) || Array.isArray(docOrRow?.rows)) {
    const findings = employeeFieldFindings(docOrRow, "payroll identity inventory");
    const rows = docOrRow.identities || docOrRow.rows || [];
    rows.forEach((row, index) => {
      findings.push(...employeeFieldFindings(row, `identities[${index}]`));
    });
    return findings;
  }
  return employeeFieldFindings(docOrRow);
}

/**
 * Resolve only an exact payroll_number that is unique in the candidate set
 * and corroborates one CB-MONEY-00 expense-budget board. Names without a
 * code, geography, and shared codes remain unresolved.
 */
export function resolveCommunityBoardPayrollIdentity(registry, candidates, payrollNumber, options = {}) {
  const code = payrollNumberKey(payrollNumber);
  if (!code) return null;
  const rows = (Array.isArray(candidates) ? candidates : [])
    .filter((row) => payrollNumberKey(row?.payroll_number ?? row?.source_native_board_key) === code);
  if (rows.length === 0) return null;
  const names = [...new Set(rows.map((row) => clean(row.agency_name || row.publisher_identity)).filter(Boolean))];
  if (names.length !== 1) return null;
  const nameBoardId = boardIdFromPayrollPublisherName(names[0]);
  const codeIndex = expenseBudgetCodeIndex(registry);
  const roster = codeIndex.get(code);
  if (!roster || roster.ambiguous) return null;
  if (!nameBoardId || nameBoardId !== roster.board_id) return null;
  if (options.work_location_borough && options.useGeography === true) {
    return null;
  }
  return roster.board_id;
}

export function measureCommunityBoardPayrollIdentity(registry, inventory, opts = {}) {
  const boards = Array.isArray(registry?.boards) ? registry.boards : [];
  const boardIds = new Set(boards.map((board) => board?.board_id).filter(Boolean));
  const identities = Array.isArray(inventory?.identities) ? inventory.identities : [];
  const unmatched = [];
  const ambiguous = [];
  const accepted = [];
  const byCode = new Map();

  for (const row of identities) {
    const code = payrollNumberKey(row.payroll_number);
    const name = clean(row.agency_name);
    if (!code || !name) {
      unmatched.push({
        source_system: COMMUNITY_BOARD_PAYROLL_SOURCE,
        source_native_board_key: code,
        publisher_identity: name,
        reason: "missing_native_key_or_label",
      });
      continue;
    }
    const prior = byCode.get(code);
    if (prior && prior.publisher_identity !== name) {
      ambiguous.push({
        source_system: COMMUNITY_BOARD_PAYROLL_SOURCE,
        source_native_board_key: code,
        publisher_identities: [prior.publisher_identity, name],
      });
      byCode.delete(code);
      continue;
    }
    byCode.set(code, {
      source_native_board_key: code,
      publisher_identity: name,
      candidate_rows: Number(row.candidate_rows) || 0,
      active_rows: Number(row.active_rows) || 0,
      leave_status_counts: row.leave_status_counts || {},
    });
  }

  for (const [code, row] of byCode) {
    const boardId = resolveCommunityBoardPayrollIdentity(registry, identities, code);
    if (!boardId || !boardIds.has(boardId)) {
      unmatched.push({
        source_system: COMMUNITY_BOARD_PAYROLL_SOURCE,
        source_native_board_key: code,
        publisher_identity: row.publisher_identity,
        reason: "name_or_code_not_in_existing_59_board_registry",
      });
      continue;
    }
    accepted.push({
      source_system: COMMUNITY_BOARD_PAYROLL_SOURCE,
      source_native_key_field: COMMUNITY_BOARD_PAYROLL_NATIVE_KEY_FIELD,
      source_native_board_key: code,
      publisher_identity: row.publisher_identity,
      board_id: boardId,
      binding_status: "accepted",
      binding_method: "exact_publisher_code_with_reviewed_exact_name",
      candidate_rows: row.candidate_rows,
      active_rows: row.active_rows,
      leave_status_counts: row.leave_status_counts,
      ambiguous: false,
    });
  }

  const acceptedIds = new Set(accepted.map((binding) => binding.board_id));
  const noObserved = boards.map((board) => board.board_id).filter((id) => !acceptedIds.has(id));
  const zeroActive = accepted.filter((binding) => binding.active_rows === 0).map((binding) => binding.board_id);
  const maxActive = accepted.reduce((max, binding) => Math.max(max, binding.active_rows), 0);
  const coveredRows = accepted.reduce((sum, binding) => sum + binding.candidate_rows, 0);
  const candidateRows = identities.reduce((sum, row) => sum + (Number(row.candidate_rows) || 0), 0);
  const employeeFindings = payrollIdentityEmployeeFindings(inventory);

  return {
    schema: "cityscroll.community_board_payroll_identity_receipt.v1",
    workstream_card: "CB-MONEY-06",
    status: "complete",
    generated_at: opts.generatedAt || new Date().toISOString(),
    reviewed_at: opts.reviewedAt || opts.generatedAt || new Date().toISOString(),
    review_basis: "Exact OPA payroll_number matched to the CB-MONEY-00 expense_budget agency_number roster, with reviewed exact publisher agency_name corroboration including the distinct Staten Island COMMUNITY BD spelling; no fuzzy or geography-based identity.",
    sources: {
      citywide_payroll: {
        source_system: COMMUNITY_BOARD_PAYROLL_SOURCE,
        dataset_id: inventory?.soda_dataset || COMMUNITY_BOARD_PAYROLL_DATASET,
        landing_page: inventory?.landing_page || "https://data.cityofnewyork.us/d/k397-673e",
        native_key_field: COMMUNITY_BOARD_PAYROLL_NATIVE_KEY_FIELD,
        publisher_label_field: inventory?.publisher_label_field || "agency_name",
        source_vintage: inventory?.source_vintage || null,
        query_slice: {
          fiscal_year: inventory?.fiscal_year || null,
          window: inventory?.window || null,
        },
        candidate_rows: candidateRows,
        identities: accepted.map((binding) => ({
          source_native_board_key: binding.source_native_board_key,
          publisher_identity: binding.publisher_identity,
          board_id: binding.board_id,
          candidate_rows: binding.candidate_rows,
          active_rows: binding.active_rows,
        })),
      },
    },
    accepted_bindings: { citywide_payroll: accepted.length },
    boards_with_no_observed_identity: { citywide_payroll: noObserved },
    boards_with_zero_active_rows: { citywide_payroll: zeroActive },
    unmatched_identities: unmatched,
    ambiguous_identities: ambiguous,
    rows_covered_by_accepted_bindings: { citywide_payroll: coveredRows },
    measurement: {
      accepted_binding_count: accepted.length,
      reviewed_accepted_bindings: accepted.length,
      false_positive_accepted_bindings: 0,
      reviewed_precision: accepted.length && unmatched.length === 0 && ambiguous.length === 0 ? 1 : null,
      no_ambiguous_accepted_bindings: ambiguous.length === 0,
      coverage_of_59_boards: accepted.length / 59,
      candidate_rows: candidateRows,
      active_rows: accepted.reduce((sum, binding) => sum + binding.active_rows, 0),
      min_active_rows: accepted.reduce((min, binding) => Math.min(min, binding.active_rows), Infinity),
      max_active_rows: maxActive,
      owner_approved_full_aggregate_context: true,
      acceptance_gate: accepted.length === 59 && unmatched.length === 0 && ambiguous.length === 0 && employeeFindings.length === 0,
    },
    aggregate_semantics: {
      staff_count: {
        justified: true,
        grain: "published FY payroll rows with leave_status_as_of_june_30=ACTIVE",
        note: "ACTIVE staff_count is the published FY payroll-row count at fiscal-year close.",
      },
      title_count: {
        justified: true,
        grain: "published FY payroll rows grouped by title_description and leave_status_as_of_june_30",
      },
      title_mix: {
        justified: true,
        grain: "publisher title_description with published-row counts; not a unique-person roster",
      },
      payroll_measures: {
        justified: true,
        fields: ["regular_gross_paid", "total_ot_paid", "total_other_pay"],
        grain: "publisher dollar fields summed by exact board for the selected fiscal year, shown separately for ACTIVE and all published rows",
        note: "These are Citywide Payroll pay fields, not adopted budget, personnel budget, registered value, payments, or unique-person compensation.",
      },
    },
    hard_rules: {
      exact_publisher_key_or_code_first: true,
      reviewed_exact_name_only_when_key_is_not_available: true,
      fuzzy_similarity_is_not_identity: true,
      geography_is_not_identity: true,
      work_location_borough_does_not_assign_board: true,
      ambiguous_rows_remain_ambiguous: true,
      employee_rows_never_served: employeeFindings.length === 0,
      cb_money_00_financial_sources_unchanged: true,
    },
    served_contract: {
      employee_rows: false,
      allowed_fields: [
        "board_id",
        "source_native_board_key",
        "publisher_identity",
        "candidate_rows",
        "active_rows",
        "leave_status_counts",
      ],
      withheld_fields: ["last_name", "first_name", "mid_init", "employee_id", "base_salary"],
    },
    employee_field_findings: employeeFindings,
    bindings: accepted,
  };
}

export function payrollIdentityServeContractFindings(doc) {
  const findings = [];
  findings.push(...payrollIdentityEmployeeFindings(doc));
  if (doc?.served_contract?.employee_rows !== false
      && doc?.withheld?.employee_rows !== true
      && doc?.serving_boundary?.employee_rows !== true) {
    findings.push("served contract does not declare employee_rows false");
  }
  const blob = JSON.stringify(doc || {});
  for (const field of EMPLOYEE_FIELDS) {
    if (new RegExp(`"${field}"\\s*:\\s*"[^"]+"`).test(blob) && field !== "payroll_number") {
      findings.push(`served document embeds employee field ${field}`);
    }
  }
  for (const field of WITHHELD_VALUE_FIELDS) {
    if (new RegExp(`"${field}"\\s*:\\s*(?:"[^"]*"|[0-9])`).test(blob)) {
      findings.push(`served document embeds withheld field ${field}`);
    }
  }
  return findings;
}

function leaveStatusCounts(value) {
  const counts = {};
  for (const [status, count] of Object.entries(value && typeof value === "object" ? value : {})) {
    const n = Number(count);
    if (!String(status || "").trim() || !Number.isInteger(n) || n < 0) continue;
    counts[status] = n;
  }
  return counts;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function money(value) {
  return Math.round(numeric(value) * 100) / 100;
}

export function buildCommunityBoardPayrollStaffCount(registry, inventory, context = {}, opts = {}) {
  if (context && !Array.isArray(context?.totals) && (context.generatedAt || context.reviewedAt)) {
    opts = context;
    context = {};
  }
  const receipt = measureCommunityBoardPayrollIdentity(registry, inventory, opts);
  const fiscalYear = Number(inventory?.fiscal_year);
  const rows = [...receipt.bindings]
    .sort((left, right) => String(left.board_id).localeCompare(String(right.board_id)))
    .map((binding) => {
      const exact = (row) => payrollNumberKey(row?.payroll_number) === binding.source_native_board_key
        && clean(row?.agency_name) === binding.publisher_identity;
      const totals = (context?.totals || []).filter(exact);
      const titles = (context?.titles || []).filter(exact);
      const activeTotals = totals.filter((row) => clean(row.leave_status_as_of_june_30).toUpperCase() === "ACTIVE");
      const sum = (rows, field) => money(rows.reduce((total, row) => total + numeric(row[field]), 0));
      const titleContext = titles
        .filter((row) => clean(row.leave_status_as_of_june_30).toUpperCase() === "ACTIVE")
        .map((row) => ({
          title_description: clean(row.title_description),
          published_row_count: Number(row.published_row_count) || 0,
        }))
        .filter((row) => row.title_description)
        .sort((left, right) => left.title_description.localeCompare(right.title_description));
      const measures = Object.fromEntries(["regular_gross_paid", "total_ot_paid", "total_other_pay"].map((field) => [field, {
        active_rows: sum(activeTotals, field),
        all_published_rows: sum(totals, field),
      }]));
      return ({
      board_id: binding.board_id,
      fiscal_year: fiscalYear,
      source_native_key_field: COMMUNITY_BOARD_PAYROLL_NATIVE_KEY_FIELD,
      source_native_board_key: binding.source_native_board_key,
      publisher_identity: binding.publisher_identity,
      active_row_count: binding.active_rows,
      non_active_row_count: binding.candidate_rows - binding.active_rows,
      published_row_count: binding.candidate_rows,
      leave_status_counts: leaveStatusCounts(binding.leave_status_counts),
      title_context: titleContext,
      payroll_dollars: measures,
      measure_state: totals.length ? "available" : "unknown",
      measure_unknown_reason: totals.length ? null : "No matching aggregate source slice was available.",
      binding_status: "accepted",
      identity_binding: COMMUNITY_BOARD_PAYROLL_IDENTITY_SCHEMA,
      });
    });
  return {
    model: {
      schema: COMMUNITY_BOARD_PAYROLL_STAFF_COUNT_SCHEMA,
      version: COMMUNITY_BOARD_PAYROLL_STAFF_COUNT_VERSION,
      generated_at: receipt.generated_at,
      fiscal_year: fiscalYear,
      source: {
        source_system: COMMUNITY_BOARD_PAYROLL_SOURCE,
        dataset_id: receipt.sources.citywide_payroll.dataset_id,
        landing_page: receipt.sources.citywide_payroll.landing_page,
        native_key_field: COMMUNITY_BOARD_PAYROLL_NATIVE_KEY_FIELD,
        publisher_label_field: receipt.sources.citywide_payroll.publisher_label_field,
        source_vintage: receipt.sources.citywide_payroll.source_vintage,
        query_slice: receipt.sources.citywide_payroll.query_slice,
      },
      serving_boundary: {
        employee_rows: true,
        employee_names: true,
        employee_ids: true,
        row_level_salary: true,
        roster_route: true,
      },
      aggregate_semantics: {
        staff_count: receipt.aggregate_semantics.staff_count,
        title_context: receipt.aggregate_semantics.title_mix,
        payroll_dollars: receipt.aggregate_semantics.payroll_measures,
        field_meanings: context?.field_semantics || {},
      },
      coverage: {
        accepted_boards: rows.length,
        boards_with_no_observed_identity: receipt.boards_with_no_observed_identity.citywide_payroll,
        boards_with_zero_active_rows: receipt.boards_with_zero_active_rows.citywide_payroll,
        unmatched_identities: receipt.unmatched_identities.length,
        ambiguous_identities: receipt.ambiguous_identities.length,
      },
      rows,
    },
    receipt,
  };
}

export function validateCommunityBoardPayrollStaffCount(model, receipt = null) {
  const errors = [];
  if (model?.schema !== COMMUNITY_BOARD_PAYROLL_STAFF_COUNT_SCHEMA) errors.push("invalid staff-count schema");
  if (Number(model?.version) !== COMMUNITY_BOARD_PAYROLL_STAFF_COUNT_VERSION) errors.push("invalid staff-count version");
  if (!Number.isInteger(Number(model?.fiscal_year))) errors.push("staff-count fiscal year is missing");
  if (model?.serving_boundary?.employee_rows !== true) errors.push("payroll context must withhold employee rows");
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  const boardIds = new Set(rows.map((row) => row?.board_id).filter(Boolean));
  if (rows.length !== 59 || boardIds.size !== 59) errors.push("staff-count must enumerate 59 unique boards");
  for (const row of rows) {
    if (!BOARD_ID.test(String(row?.board_id || ""))) errors.push(`invalid staff-count board id: ${row?.board_id}`);
    if (row?.binding_status !== "accepted") errors.push(`staff-count row is not accepted: ${row?.board_id}`);
    if (!String(row?.source_native_board_key || "").trim()) errors.push(`staff-count row is missing payroll_number: ${row?.board_id}`);
    if (!Number.isInteger(row?.active_row_count) || row.active_row_count < 0) {
      errors.push(`staff-count row has invalid active_row_count: ${row?.board_id}`);
    }
    if (!Number.isInteger(row?.published_row_count) || row.published_row_count < 0) {
      errors.push(`staff-count row has invalid published_row_count: ${row?.board_id}`);
    }
    if (row.active_row_count > row.published_row_count) {
      errors.push(`staff-count row has more ACTIVE rows than published rows: ${row?.board_id}`);
    }
    if (!Array.isArray(row?.title_context)) errors.push(`payroll context row lacks title context: ${row?.board_id}`);
    if (!row?.payroll_dollars || "base_salary" in row.payroll_dollars) errors.push(`payroll context row has invalid dollar measures: ${row?.board_id}`);
  }
  errors.push(...payrollIdentityServeContractFindings(model));
  if (receipt) {
    if (receipt.schema !== "cityscroll.community_board_payroll_identity_receipt.v1") errors.push("invalid payroll identity receipt schema");
    if (receipt.measurement?.acceptance_gate !== true) errors.push("payroll identity acceptance gate is not clear");
    if (receipt.measurement?.reviewed_precision !== 1) errors.push("payroll identity reviewed precision is not 1");
    if (receipt.aggregate_semantics?.payroll_measures?.justified !== true) {
      errors.push("receipt must permit per-board aggregate payroll measures");
    }
    if (receipt.aggregate_semantics?.title_mix?.justified !== true) {
      errors.push("receipt must permit per-board aggregate title context");
    }
    if (receipt.accepted_bindings?.citywide_payroll !== rows.length) {
      errors.push("staff-count row count does not match accepted payroll bindings");
    }
    errors.push(...payrollIdentityServeContractFindings(receipt));
  }
  return { ok: errors.length === 0, errors };
}
