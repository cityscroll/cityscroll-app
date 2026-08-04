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

const STAFFING_DISPLAY_FIELDS = [
  "role", "person", "agency", "effective_date", "salary", "title_code", "published_at",
];

function staffingLongDate(value, ui) {
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return value || "";
  const [, month, day, year] = match;
  return ui.fdt(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`, { dateOnly: true });
}

function staffingGroupMemberHTML(item, ui) {
  return `<li data-request-id="${ui.escUiHtml(item.request_id)}"><a href="${ui.REQ_URL(item.request_id)}" ${ui.EXT_ATTRS}><span lang="en" dir="ltr">${ui.escUiHtml(item.person)}</span>${ui.extSR()}</a></li>`;
}

function staffingHireGroupHTML(entry, ui) {
  const item = entry.members[0];
  const members = [...entry.members].sort((a, b) => a.person.localeCompare(b.person));
  const role = item.role || ui.t("staffing_unknown_role", { code: ui.escUiHtml(item.title_code || "—") });
  const salary = ui.money(item.salary);
  const pay = salary
    ? (Number(item.salary) === 1
      ? ui.t("staffing_appointment_group_stipend", { amount: salary })
      : ui.t("staffing_salary", { amount: salary }))
    : "";
  const summaryFacts = [
    ui.t("staffing_appointment_group_summary", { n: ui.fmtNumber(entry.count) }),
    item.effective_date ? ui.t("staffing_effective_date", { date: staffingLongDate(item.effective_date, ui) }) : "",
    pay,
  ].filter(Boolean).join(" · ");
  const sharedFacts = [
    `<span class="staffing-hire-agency" lang="en" dir="ltr">${ui.escUiHtml(item.agency)}</span>`,
    item.title_code ? `<span class="staffing-hire-fact">${ui.escUiHtml(ui.t("staffing_title_code", { code: item.title_code }))}</span>` : "",
    item.published_at ? `<span class="staffing-hire-date">${ui.escUiHtml(ui.t("staffing_appointment_group_posted", { date: ui.fdate(item.published_at) }))}</span>` : "",
  ].filter(Boolean).join("");
  return `<article class="staffing-hire-group" data-kind="same-except-group" data-group-count="${entry.count}">
    <div class="staffing-hire-group-head">
      <h4><span lang="en" dir="ltr">${ui.escUiHtml(role)}</span> — ${ui.escUiHtml(summaryFacts)}</h4>
      <div class="staffing-hire-group-facts">${sharedFacts}</div>
    </div>
    <details>
      <summary>${ui.escUiHtml(ui.t("staffing_appointment_group_names", { n: ui.fmtNumber(entry.count) }))}</summary>
      <ul class="staffing-hire-group-names">${members.map((member) => staffingGroupMemberHTML(member, ui)).join("")}</ul>
    </details>
  </article>`;
}

/** Render Staffing groups after the People route has loaded this module. */
export function staffingAppointmentListHTML(items, ui = globalThis) {
  return groupSameExcept(items, {
    fields: STAFFING_DISPLAY_FIELDS,
    except: ["person"],
    threshold: 3,
  }).map((entry) => entry.kind === "same-except-group"
    ? staffingHireGroupHTML(entry, ui)
    : ui.staffingHireRowHTML(entry.item)).join("");
}

const STAFFING_STYLE_ID = "staffing-consolidation-styles";
const STAFFING_STYLES = `.staffing-hire-row{border-bottom:1px solid var(--rule);min-width:0}
.staffing-hire-row:last-child{border-bottom:0}
.staffing-hire-row>a{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 9px;padding:7px 12px;min-width:0;text-decoration:none;color:var(--ink);transition:background .1s}
.staffing-hire-row>a:hover{background:var(--paper-2)}
.staffing-hire-role{font:700 13.5px/1.3 var(--font-body);min-width:0;overflow-wrap:anywhere}
.staffing-hire-person{font:650 12.5px/1.3 ui-sans-serif,system-ui,sans-serif;color:var(--ink-soft)}
.staffing-hire-agency{font:12px/1.3 ui-sans-serif,system-ui,sans-serif;color:var(--muted)}
.staffing-hire-fact{font:12px/1.3 ui-monospace,Menlo,monospace;color:var(--muted)}
.staffing-hire-date{font:600 11px/1.3 ui-sans-serif,system-ui,sans-serif;color:var(--muted);white-space:nowrap;margin-left:auto}
.staffing-hire-group{border-bottom:1px solid var(--rule);padding:12px;min-width:0;background:var(--paper-2)}
.staffing-hire-group:last-child{border-bottom:0}
.staffing-hire-group-head h4{font:700 15px/1.35 var(--font-body);margin:0;overflow-wrap:anywhere}
.staffing-hire-group-facts{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin-top:5px;min-width:0}
.staffing-hire-group-facts .staffing-hire-date{margin-left:0}
.staffing-hire-group details{margin-top:9px}
.staffing-hire-group summary{width:max-content;max-width:100%;font:700 12px/1.35 ui-sans-serif,system-ui,sans-serif;color:var(--oxblood);cursor:pointer}
.staffing-hire-group-names{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:2px 14px;list-style:none;margin:8px 0 0;padding:0;min-width:0}
.staffing-hire-group-names li{min-width:0}
.staffing-hire-group-names a{display:block;padding:5px 7px;border-radius:4px;font:650 12.5px/1.35 ui-sans-serif,system-ui,sans-serif;color:var(--ink-soft);overflow-wrap:anywhere}
.staffing-hire-group-names a:hover{background:var(--card);color:var(--oxblood)}`;

/** Install route-specific group styles once, keeping them off unrelated first paint. */
export function installStaffingConsolidationStyles(doc = document) {
  if (doc.getElementById(STAFFING_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STAFFING_STYLE_ID;
  style.textContent = STAFFING_STYLES;
  doc.head.append(style);
}
