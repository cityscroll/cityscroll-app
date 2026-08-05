import test from "node:test";
import assert from "node:assert/strict";

import {
  landProjectDisplayTitle,
  noticeDisplayTitle,
  publishedDisplayTitle,
} from "../site/display_title.mjs";
import { feedItems } from "../worker/src/lib/feed.mjs";

const PLACEHOLDER_RENDER = /(?:\(\s*(?:unnamed|untitled)[^)]*\)|\b(?:unnamed|untitled|null)\b)/i;

const legacyProjects = [
  {
    project_id: "P1985Q0956",
    project_brief: "DISPOSITION OF CITY-OWNED PROPERTY",
    borough: "Queens",
    community_district: "Q09",
  },
  {
    project_id: "P1985Q0958",
    project_brief: "DISPOSITION OF CITY-OWNED PROPERTY, 11 PARCELS",
    borough: "Queens",
    community_district: "Q13",
  },
  {
    project_id: "P1985Q1002",
    project_brief: "DISPOSITION OF CITY-OWNED PROPERTY, 19 PARCELS",
    borough: "Queens",
    community_district: "Q12",
  },
];

test("legacy nameless ZAP projects use evidenced action and place titles", () => {
  assert.deepEqual(legacyProjects.map(landProjectDisplayTitle), [
    "Property disposition — Queens, Community District 9",
    "Property disposition — Queens, Community District 13",
    "Property disposition — Queens, Community District 12",
  ]);
});

test("nameless ZAP projects without enough descriptive evidence mirror ZAP's Project ID convention", () => {
  assert.equal(landProjectDisplayTitle({ project_id: "P1985Q9999" }), "Project P1985Q9999");
  assert.equal(landProjectDisplayTitle({ project_id: "P1", project_name: "(unnamed)" }), "Project P1");
});

test("published titles win and placeholder-like source values do not", () => {
  assert.equal(publishedDisplayTitle("A real title"), "A real title");
  for (const value of ["", "null", "Untitled", "(untitled notice)", "(unnamed)"]) {
    assert.equal(publishedDisplayTitle(value), "");
  }
});

test("identified notice and project feed cards never render placeholder titles", () => {
  const rows = [
    ...legacyProjects.map((row) => feedItems("rezone", [row])[0]),
    feedItems("rules", [{ request_id: "20260805001", short_title: "null" }])[0],
    feedItems("property", [{ request_id: "20260805002", short_title: "(untitled)" }])[0],
  ];
  for (const row of rows) {
    assert.ok(row.title, `${row.id} has a title`);
    assert.doesNotMatch(row.title, PLACEHOLDER_RENDER, `${row.id} has no placeholder title`);
  }
  assert.equal(noticeDisplayTitle({ request_id: "20260805001", short_title: "null" }), "Notice 20260805001");
});
