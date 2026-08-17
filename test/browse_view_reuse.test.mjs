import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { renderBrowseView } from "../site/browse_view.mjs";
import {
  buildExamsAliasBrowseView,
  examBrowseRows,
  EXAMS_BROWSE_ROW_KIND,
} from "../site/exams_surface.mjs";
import {
  buildPeopleListBrowseView,
  peopleBrowseRows,
} from "../site/people_organizations_surface.mjs";
import { buildBrowseConceptLanding, renderBrowseConceptLanding } from "../site/browse_concept_view.mjs";
import { buildBrowseAliasDocument } from "../site/primary_document_view.mjs";

const shell = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const peopleFixture = JSON.parse(readFileSync(new URL("fixtures/browse_owner_people.json", import.meta.url), "utf8"));
const examsFixture = JSON.parse(readFileSync(new URL("fixtures/browse_owner_exams.json", import.meta.url), "utf8"));

const digest = (html) => createHash("sha256").update(html).digest("hex");

test("Exams alias adapts real exam rows to the established Browse view", () => {
  const artifact = {
    data_current_as_of: "2026-08-14",
    exams: [{
      exam_number: "7016",
      title: "Clerical Associate",
      eligibility: "open_competitive",
      application_start: "2026-08-01",
      application_end: "2026-08-31",
      interest_area: "administration-finance",
    }],
  };
  const html = renderBrowseView(buildExamsAliasBrowseView(artifact));
  assert.match(html, /data-build-rendered="browse" data-browse-facet="exams-alias"/);
  assert.match(html, /data-civic-object-kind="exam" data-civic-object-id="7016"/);
  assert.match(html, /href="\/exams\/7016\/"/);
  assert.match(html, /Clerical Associate/);
  assert.match(html, /Copy link/);
});

test("People list adapts every typed row to the established Browse view", () => {
  const model = {
    generated_at: "2026-08-11T19:21:19.284Z",
    rows: [{
      kind: "official",
      id: "official:7801",
      label: "Christopher Marte",
      href: "/officials/7801/",
      relation_state: "published",
      detail: "Official profile",
      search_text: "Christopher Marte official council member",
    }],
  };
  const html = renderBrowseView(buildPeopleListBrowseView(model));
  assert.match(html, /data-build-rendered="browse" data-browse-facet="people-list"/);
  assert.match(html, /data-civic-object-kind="official" data-civic-object-id="official:7801"/);
  assert.match(html, /href="\/officials\/7801\/"/);
  assert.match(html, /Christopher Marte/);
  assert.match(html, /Copy link/);
});

test("People owner admits and filters only People row kinds", () => {
  const rows = peopleBrowseRows(peopleFixture);
  assert.deepEqual(rows.map((row) => row.kind), ["official", "agency"]);
  assert.ok(rows.every((row) => row.kind !== EXAMS_BROWSE_ROW_KIND));

  const view = buildPeopleListBrowseView(peopleFixture, new URLSearchParams({ type: "agency" }));
  assert.deepEqual(view.rows.map((row) => row.kind), ["agency"]);
});

test("Exams owner produces and filters only civil_service_exam rows", () => {
  const rows = examBrowseRows(examsFixture);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.kind === EXAMS_BROWSE_ROW_KIND));

  const interestView = buildExamsAliasBrowseView(examsFixture, new URLSearchParams({ interest: "technology-data" }));
  assert.deepEqual(interestView.rows.map((row) => row.kind), [EXAMS_BROWSE_ROW_KIND]);
  assert.equal(interestView.rows[0].civic_object.id, "7017");

  const actionableView = buildExamsAliasBrowseView(examsFixture, new URLSearchParams({ window: "actionable" }));
  assert.deepEqual(actionableView.rows.map((row) => row.civic_object.id), ["7016"]);
});

test("owner extraction preserves representative Browse HTML byte for byte", () => {
  const examsHtml = renderBrowseView(buildExamsAliasBrowseView({
    data_current_as_of: "2026-08-14",
    exams: [{
      exam_number: "7016",
      title: "Clerical Associate",
      eligibility: "open_competitive",
      application_start: "2026-08-01",
      application_end: "2026-08-31",
      interest_area: "administration-finance",
    }],
  }));
  const peopleHtml = renderBrowseView(buildPeopleListBrowseView({
    generated_at: "2026-08-11T19:21:19.284Z",
    rows: [{
      kind: "official",
      id: "official:7801",
      label: "Christopher Marte",
      href: "/officials/7801/",
      relation_state: "published",
      detail: "Official profile",
      search_text: "Christopher Marte official council member",
    }],
  }));

  assert.equal(Buffer.byteLength(examsHtml), 1486);
  assert.equal(digest(examsHtml), "4a969864dbbff9e70025217e5fffba95ba9218a2b0d1570c35f0ae32b90e62c7");
  assert.equal(Buffer.byteLength(peopleHtml), 1518);
  assert.equal(digest(peopleHtml), "232f44470302f878416e34f1b97a5ec22d3c5561b2d7757fb78a31435cf5c542");
});

test("visible Exams and People first paint both contain the shared Browse view", () => {
  const exams = buildBrowseAliasDocument(shell, "exams", {
    data_current_as_of: "2026-08-14",
    exams: [{ exam_number: "7016", title: "Clerical Associate" }],
    notices: [],
  });
  const careerResults = exams.slice(exams.indexOf('id="career-results"'), exams.indexOf('id="career-more"'));
  assert.match(careerResults, /data-build-rendered="browse"/);
  assert.match(careerResults, /data-civic-object-kind="exam"/);

  const people = renderBrowseConceptLanding(buildBrowseConceptLanding("people", {
    people: { by_person_id: { "7801": { person_id: "7801", person_name: "Christopher Marte" } } },
  }));
  assert.match(people, /id="people-organizations-list"[\s\S]*data-build-rendered="browse"/);
  assert.match(people, /data-civic-object-kind="official"/);
});
