/**
 * Lens-neutral small-multiples collapse for exact displayed-field repetition.
 *
 * A surface declares every displayed field plus the field(s) allowed to vary.
 * The returned view model keeps every original row inside either an item or a
 * threshold-sized group; callers remain free to export the untouched source rows.
 */

function optionList(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function contract(options = {}) {
  const fields = optionList(options.fields).map(String);
  const except = new Set(optionList(options.except).map(String));
  if (!fields.length) throw new TypeError("same-consolidation requires displayed fields");
  if (!except.size) throw new TypeError("same-consolidation requires at least one differing field");
  for (const field of except) {
    if (!fields.includes(field)) {
      throw new TypeError(`same-consolidation differing field is not displayed: ${field}`);
    }
  }
  const threshold = Math.max(2, Number(options.threshold) || 3);
  const normalize = typeof options.normalize === "function"
    ? options.normalize
    : (value) => value == null ? "" : String(value);
  return { fields, except, threshold, normalize };
}

function valueFor(row, field, normalize) {
  return normalize(row?.[field], field, row);
}

function signature(row, fields, except, normalize) {
  return JSON.stringify(fields
    .filter((field) => !except.has(field))
    .map((field) => [field, valueFor(row, field, normalize)]));
}

function bucketsFor(rows, options) {
  const config = contract(options);
  const buckets = new Map();
  rows.forEach((row, index) => {
    const key = signature(row, config.fields, config.except, config.normalize);
    const bucket = buckets.get(key) || { key, firstIndex: index, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  });
  return { buckets, config };
}

/**
 * Collapse threshold-sized same-except-k groups without losing source rows.
 * @returns {Array<{kind:"same-except-item",item:object}|{kind:"same-except-group",count:number,members:object[],shared:object,differing:object}>}
 */
export function groupSameExcept(rows, options = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const { buckets, config } = bucketsFor(source, options);
  const grouped = new Set();
  const entries = [];

  source.forEach((row, index) => {
    const key = signature(row, config.fields, config.except, config.normalize);
    const bucket = buckets.get(key);
    if (bucket.rows.length < config.threshold) {
      entries.push({ kind: "same-except-item", item: row });
      return;
    }
    if (grouped.has(key)) return;
    grouped.add(key);
    const shared = {};
    const differing = {};
    for (const field of config.fields) {
      if (config.except.has(field)) {
        differing[field] = bucket.rows.map((member) => member?.[field]);
      } else {
        shared[field] = row?.[field];
      }
    }
    entries.push({
      kind: "same-except-group",
      key,
      count: bucket.rows.length,
      members: [...bucket.rows],
      shared,
      differing,
      firstIndex: index,
    });
  });
  return entries;
}

function rawRow(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.kind === "same-except-group") return null;
  if (entry.kind === "same-except-item") return entry.item || null;
  return entry;
}

/**
 * Detector for a rendered view model that left threshold-sized repetition loose.
 * Consolidated group entries are intentionally opaque; individual entries are
 * checked with the same exact displayed-field contract used by the grouper.
 */
export function repeatedSameExceptFindings(entries, options = {}) {
  const rows = (Array.isArray(entries) ? entries : []).map(rawRow).filter(Boolean);
  const { buckets, config } = bucketsFor(rows, options);
  return [...buckets.values()]
    .filter((bucket) => bucket.rows.length >= config.threshold)
    .map((bucket) => ({
      kind: "unconsolidated-same-except",
      count: bucket.rows.length,
      differing_fields: [...config.except],
      request_ids: bucket.rows.map((row) => row.request_id).filter(Boolean),
      sample: bucket.rows[0],
    }));
}

const STAFFING_FIELDS = [
  "role", "person", "agency", "effective_date", "salary", "title_code", "published_at",
];

export function groupStaffingAppointments(rows) {
  return groupSameExcept(rows, { fields: STAFFING_FIELDS, except: ["person"], threshold: 3 });
}

export function staffingAppointmentGroupHTML(entry, helpers) {
  const { t, escUiHtml, fmtNumber, money, fdt, fdate, REQ_URL, EXT_ATTRS, extSR, listEntityMentionHTML } = helpers;
  const item = entry.members[0];
  const members = [...entry.members].sort((a, b) => a.person.localeCompare(b.person));
  const date = (value) => {
    const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return value || "";
    const [, month, day, year] = match;
    return fdt(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`, { dateOnly: true });
  };
  const role = item.role || t("staffing_unknown_role", { code: escUiHtml(item.title_code || "—") });
  const agencyHTML = typeof listEntityMentionHTML === "function"
    ? listEntityMentionHTML({kind:"agency",value:item.agency,escape:escUiHtml,relation:"appoints_staff"})
    : escUiHtml(item.agency);
  const salary = money(item.salary);
  const pay = salary
    ? Number(item.salary) === 1
      ? t("staffing_appointment_group_stipend", { amount: salary })
      : t("staffing_salary", { amount: salary })
    : "";
  const summary = [
    t("staffing_appointment_group_summary", { n: fmtNumber(entry.count) }),
    item.effective_date ? t("staffing_effective_date", { date: date(item.effective_date) }) : "",
    pay,
  ].filter(Boolean).join(" · ");
  const facts = [
    `<span class="staffing-hire-agency" lang="en" dir="ltr">${agencyHTML}</span>`,
    item.title_code ? `<span class="staffing-hire-fact">${escUiHtml(t("staffing_title_code", { code: item.title_code }))}</span>` : "",
    item.published_at ? `<span class="staffing-hire-date">${escUiHtml(t("staffing_appointment_group_posted", { date: fdate(item.published_at) }))}</span>` : "",
  ].filter(Boolean).join("");
  const names = members.map(member => `<li data-request-id="${escUiHtml(member.request_id)}"><a href="${REQ_URL(member.request_id)}" ${EXT_ATTRS}><span lang="en" dir="ltr">${escUiHtml(member.person)}</span>${extSR()}</a></li>`).join("");
  return `<article class="staffing-hire-group" data-kind="same-except-group" data-group-count="${entry.count}">
    <div class="staffing-hire-group-head"><h4><span lang="en" dir="ltr">${escUiHtml(role)}</span> — ${escUiHtml(summary)}</h4><div class="staffing-hire-group-facts">${facts}</div></div>
    <details><summary>${escUiHtml(t("staffing_appointment_group_names", { n: fmtNumber(entry.count) }))}</summary><ul class="staffing-hire-group-names">${names}</ul></details>
  </article>`;
}

export function createStaffingConsolidationUI(helpers) {
  const { t, escUiHtml, money, fdate, REQ_URL, EXT_ATTRS, extSR, listEntityMentionHTML } = helpers;
  const agencyHTML = (item) => typeof listEntityMentionHTML === "function"
    ? listEntityMentionHTML({kind:"agency",value:item.agency,label:item.agency || "—",escape:escUiHtml,relation:"appoints_staff"})
    : escUiHtml(item.agency || "—");
  return {
    group: groupStaffingAppointments,
    facetHTML(kind, allKey, field, items, filters, topValues) {
      const selected = filters[field];
      const values = topValues(items, field, 4);
      if (selected && !values.includes(selected)) values.unshift(selected);
      return `<button type="button" class="chip" data-staffing-${kind}="" aria-pressed="${String(!selected)}">${t(allKey)}</button>`
        + values.map(value => `<button type="button" class="chip" data-staffing-${kind}="${escUiHtml(value)}" aria-pressed="${String(selected === value)}"><span lang="en" dir="ltr">${escUiHtml(value)}</span></button>`).join("");
    },
    rowHTML(item) {
      const role = item.role || "";
      const salary = money(item.salary);
      const empty = "—";
      const field = (label, value, className = "") => `<div class="staffing-hire-field${className ? ` ${className}` : ""}"><dt>${escUiHtml(label)}</dt><dd>${value}</dd></div>`;
      const titleCode = `<span class="staffing-hire-code" lang="en" dir="ltr">${escUiHtml(item.title_code || empty)}</span>`
        + (role ? `<span class="staffing-hire-role" lang="en" dir="ltr">${escUiHtml(role)}</span>` : "");
      const person = `<a href="${REQ_URL(item.request_id)}" ${EXT_ATTRS}><span lang="en" dir="ltr">${escUiHtml(item.person || empty)}</span>${extSR()}</a>`;
      return `<article class="staffing-hire-row" data-kind="hire">
        <dl class="staffing-hire-fields">
          ${field(t("person_name_label"), person, "staffing-hire-person-field")}
          ${field(t("staffing_title_code", { code: "" }).trim(), titleCode, "staffing-hire-title-field")}
          ${field(t("agency_label"), `<span lang="en" dir="ltr">${agencyHTML(item)}</span>`, "staffing-hire-agency-field")}
          ${field(t("staffing_effective_date", { date: "" }).trim(), `<span lang="en" dir="ltr">${escUiHtml(item.effective_date || empty)}</span>`)}
          ${field(t("staffing_salary", { amount: "" }).trim(), salary || empty)}
          ${field(t("staffing_appointment_group_posted", { date: "" }).trim(), item.published_at ? fdate(item.published_at) : empty)}
        </dl>
      </article>`;
    },
    groupHTML: entry => staffingAppointmentGroupHTML(entry, helpers),
  };
}
