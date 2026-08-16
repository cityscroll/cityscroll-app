import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createStaffingConsolidationUI,
  groupStaffingAppointments,
} from "../site/same_consolidation.mjs";

const people = readFileSync(new URL("../site/app/people.mjs", import.meta.url), "utf8");

function appointment(overrides = {}) {
  return {
    kind: "hire",
    request_id: "1",
    role: "POLL WORKER",
    person: "DOE,JANE",
    agency: "BOARD OF ELECTION POLL WORKERS",
    effective_date: "01/01/2026",
    salary: "1.00",
    title_code: "9POLL",
    published_at: "2026-01-02T00:00:00.000",
    ...overrides,
  };
}

const helpers = {
  t(key, values = {}) {
    const labels = {
      agency_label: "Agency",
      copy_link_btn: "Copy link",
      ext_link_new_tab_sr: "(opens in new tab)",
      person_name_label: "Name",
      staffing_appointment_group_names: `${values.n || ""} names`,
      staffing_appointment_group_posted: `Posted ${values.date || ""}`,
      staffing_appointment_group_stipend: `${values.amount || ""} stipend`,
      staffing_appointment_group_summary: `${values.n || ""} appointed`,
      staffing_effective_date: `Effective ${values.date || ""}`,
      staffing_salary: `Salary ${values.amount || ""}`,
      staffing_title_code: `Title code ${values.code || ""}`,
      staffing_unknown_role: `Title code ${values.code || ""}`,
      staffing_view_notice: "View in City Record",
    };
    return labels[key] || key;
  },
  escUiHtml: (value) => String(value),
  fmtNumber: (value) => String(value),
  money: (value) => `$${Number(value).toLocaleString("en-US")}`,
  fdt: (value) => value,
  fdate: (value) => String(value).slice(0, 10),
  REQ_URL: (id) => `https://example.test/${id}`,
  listEntityMentionHTML: () => '<a class="ui-constellation-link" href="/agencies/board-of-election-poll-workers/"><span aria-hidden="true">◆</span>Board of Election Poll Workers</a>',
};

test("Staffing exam cards consume the shared object-card grammar", () => {
  const start = people.indexOf("function careerCardHTML(exam)");
  const end = people.indexOf("function careerInterestContextHTML()", start);
  const card = people.slice(start, end);

  assert.match(card, /objectCardInteractionProjection\(/);
  assert.match(card, /renderObjectCardTitle\(/);
  assert.match(card, /renderObjectCardCopy\(/);
  assert.match(card, /officialSourceLink\(/);
  assert.match(card, /renderObjectCardActionRail\(/);
  assert.match(card, /kinetic_actions:\s*status==="open"/);
  assert.match(card, /context_ready:true/);
  assert.match(card, /data-oasys-handoff/);
  assert.match(card, /newTabLabel:t\("ext_link_new_tab_sr"\)/);
  assert.doesNotMatch(card, /data-career-copy[^}]*expanded/);
  assert.doesNotMatch(card, /href="\$\{escUiHtml\([^)]*\)\}" \$\{EXT_ATTRS\}/);
});

test("appointment rows open and copy the internal notice while separating the official source", () => {
  const html = createStaffingConsolidationUI(helpers).rowHTML(appointment());

  assert.match(html, /class="ui-constellation-link ui-object-card-title staffing-appointment-title" href="\/notices\/1"/);
  assert.match(html, /<span aria-hidden="true">◆<\/span>DOE,JANE/);
  assert.match(html, /data-object-card-copy="https:\/\/cityscroll\.org\/notices\/1"[^>]*>Copy link<\/button>/);
  assert.match(html, /class="ui-official-source-link staffing-appointment-source" href="https:\/\/example\.test\/1"[^>]*>View in City Record<span aria-hidden="true">↗<\/span>/);
  assert.match(html, /<span class="sr-only"> \(opens in new tab\)<\/span>/);
  assert.match(html, /href="\/agencies\/board-of-election-poll-workers\/"/);
  assert.doesNotMatch(html, /ui-object-card-action-rail/);
});

test("consolidated appointment members retain the same per-record grammar", () => {
  const rows = [
    appointment({ request_id: "1", person: "DOE,JANE" }),
    appointment({ request_id: "2", person: "ROE,JOHN" }),
    appointment({ request_id: "3", person: "PUBLIC,JANET" }),
  ];
  const [group] = groupStaffingAppointments(rows);
  const html = createStaffingConsolidationUI(helpers).groupHTML(group);

  assert.equal((html.match(/class="ui-constellation-link ui-object-card-title staffing-appointment-title"/g) || []).length, 3);
  assert.equal((html.match(/data-object-card-copy=/g) || []).length, 3);
  assert.equal((html.match(/class="ui-official-source-link staffing-appointment-source"/g) || []).length, 3);
  assert.doesNotMatch(html, /ui-object-card-action-rail/);
});
