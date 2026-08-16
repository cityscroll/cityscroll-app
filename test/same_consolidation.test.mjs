import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createStaffingConsolidationUI,
  groupSameExcept,
  repeatedSameExceptFindings,
} from "../site/same_consolidation.mjs";
import {
  auditUnconsolidatedRepeatedRows,
  findUnconsolidatedSameExceptRows,
} from "../tools/check-collapsed-group-labels.mjs";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");

const displayFields = [
  "role",
  "person",
  "agency",
  "effective_date",
  "salary",
  "title_code",
  "published_at",
];

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

test("groupSameExcept consolidates only threshold-sized exact shared-field groups", () => {
  const rows = [
    appointment({ request_id: "1", person: "DOE,JANE" }),
    appointment({ request_id: "2", person: "ROE,JOHN" }),
    appointment({ request_id: "3", person: "PUBLIC,JANET" }),
    appointment({ request_id: "4", person: "SOLO,SAM", salary: "2.00" }),
    appointment({ request_id: "5", person: "PAIR,PAT", salary: "3.00" }),
    appointment({ request_id: "6", person: "PAIR,LEE", salary: "3.00" }),
  ];

  const entries = groupSameExcept(rows, {
    fields: displayFields,
    except: ["person"],
    threshold: 3,
  });

  assert.equal(entries.length, 4);
  assert.equal(entries[0].kind, "same-except-group");
  assert.equal(entries[0].count, 3);
  assert.deepEqual(entries[0].members.map((row) => row.person), [
    "DOE,JANE",
    "ROE,JOHN",
    "PUBLIC,JANET",
  ]);
  assert.equal(entries[1].kind, "same-except-item");
  assert.equal(entries[2].kind, "same-except-item");
  assert.equal(entries[3].kind, "same-except-item");
});

test("groupSameExcept supports declared k greater than one", () => {
  const rows = [
    appointment({ request_id: "1", person: "DOE,JANE", agency: "BOARD A" }),
    appointment({ request_id: "2", person: "ROE,JOHN", agency: "BOARD B" }),
    appointment({ request_id: "3", person: "PUBLIC,JANET", agency: "BOARD C" }),
  ];
  const entries = groupSameExcept(rows, {
    fields: displayFields,
    except: ["person", "agency"],
    threshold: 3,
  });

  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0].differing), ["person", "agency"]);
  assert.equal(entries[0].members.length, 3);
});

test("detector fails raw same-except-one rows and accepts their consolidated view model", () => {
  const rows = [
    appointment({ request_id: "1", person: "DOE,JANE" }),
    appointment({ request_id: "2", person: "ROE,JOHN" }),
    appointment({ request_id: "3", person: "PUBLIC,JANET" }),
  ];
  const options = { fields: displayFields, except: ["person"], threshold: 3 };

  assert.equal(repeatedSameExceptFindings(rows, options).length, 1);
  assert.equal(findUnconsolidatedSameExceptRows(rows, options).length, 1);
  assert.deepEqual(
    repeatedSameExceptFindings(groupSameExcept(rows, options), options),
    [],
  );
});

test("the committed appointment census preserves every person while reducing repeated chrome", () => {
  const snapshot = JSON.parse(
    readFileSync(new URL("../site/data/staffing_default_hires.json", import.meta.url), "utf8"),
  );
  const crosswalk = JSON.parse(
    readFileSync(new URL("../site/data/title_crosswalk.json", import.meta.url), "utf8"),
  );
  const rows = Staffing.hireNotices(snapshot.notices, crosswalk);
  const entries = groupSameExcept(rows, {
    fields: displayFields,
    except: ["person"],
    threshold: 3,
  });
  const groups = entries.filter((entry) => entry.kind === "same-except-group");
  const flattened = entries.flatMap((entry) =>
    entry.kind === "same-except-group" ? entry.members : [entry.item],
  );

  assert.deepEqual(groups.map((group) => group.count).sort((a, b) => b - a), [29, 23]);
  assert.equal(flattened.length, rows.length, "group count and expanded member count preserve the source census");
  assert.deepEqual(
    flattened.map((row) => row.request_id).sort(),
    rows.map((row) => row.request_id).sort(),
    "exports can continue to use every original appointment row",
  );
});

test("the People renderer uses the shared grouping utility and keeps exports on raw rows", () => {
  const people = readFileSync(new URL("../site/app/people.mjs", import.meta.url), "utf8");
  const consolidation = readFileSync(new URL("../site/same_consolidation.mjs", import.meta.url), "utf8");
  const exports = readFileSync(new URL("../site/app/search-share.mjs", import.meta.url), "utf8");

  assert.match(people, /SameConsolidation\.group\(items/);
  assert.match(people, /function loadSameConsolidation/);
  assert.doesNotMatch(people, /^const sameConsolidationReady=import/m);
  assert.match(consolidation, /members = \[\.\.\.entry\.members\]\.sort/);
  assert.match(consolidation, /createStaffingConsolidationUI/);
  assert.match(consolidation, /staffingAppointmentGroupHTML/);
  assert.match(exports, /if\(lens==="people"\) return withEnrichedExportSpec\(lens,\{rows:staffingVisibleItems\(\)/);
  assert.deepEqual(auditUnconsolidatedRepeatedRows(), []);
});

test("appointment archive rows expose six labeled fields and separate object navigation from the source", () => {
  const helpers = {
    t(key, values = {}) {
      const labels = {
        person_name_label: "Name",
        agency_label: "Agency",
        copy_link_btn: "Copy link",
        ext_link_new_tab_sr: "(opens in new tab)",
        staffing_effective_date: `Effective ${values.date || ""}`,
        staffing_salary: `Salary ${values.amount || ""}`,
        staffing_title_code: `Title code ${values.code || ""}`,
        staffing_appointment_group_posted: `Posted ${values.date || ""}`,
        staffing_unknown_role: `Title code ${values.code || ""}`,
        staffing_view_notice: "View in City Record",
      };
      return labels[key] || key;
    },
    escUiHtml: (value) => String(value),
    money: (value) => `$${Number(value).toLocaleString("en-US")}`,
    fdate: (value) => String(value).slice(0, 10),
    REQ_URL: (id) => `https://example.test/${id}`,
    EXT_ATTRS: 'target="_blank" rel="noopener noreferrer"',
    extSR: () => '<span class="sr-only"> (opens in new tab)</span>',
  };
  const html = createStaffingConsolidationUI(helpers).rowHTML(appointment());

  assert.match(html, /<dl class="staffing-hire-fields"/);
  assert.equal((html.match(/class="staffing-hire-field(?: |")/g) || []).length, 6);
  assert.match(html, /<dt>Name<\/dt><dd><span[^>]*><a class="ui-constellation-link ui-object-card-title staffing-appointment-title" href="\/notices\/1"><span aria-hidden="true">◆<\/span>DOE,JANE<\/a>/);
  assert.match(html, /<dt>Title code<\/dt><dd>/);
  assert.match(html, /<dt>Agency<\/dt><dd>/);
  assert.match(html, /<dt>Effective<\/dt><dd>/);
  assert.match(html, /<dt>Salary<\/dt><dd>/);
  assert.match(html, /<dt>Posted<\/dt><dd>/);
  assert.match(html, /data-object-card-copy="https:\/\/cityscroll\.org\/notices\/1"[^>]*>Copy link<\/button>/);
  assert.match(html, /class="ui-official-source-link staffing-appointment-source"[^>]*>View in City Record<span aria-hidden="true">↗<\/span>/);
  assert.equal((html.match(/<a\b/g) || []).length, 2, "the internal record title and official source stay separate");
  assert.doesNotMatch(html, /<article[^>]*>\s*<a\b/);
});
