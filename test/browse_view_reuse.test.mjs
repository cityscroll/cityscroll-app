import assert from "node:assert/strict";
import test from "node:test";

import { renderBrowseView } from "../site/browse_view.mjs";
import {
  buildExamsAliasBrowseView,
  buildPeopleListBrowseView,
} from "../site/browse_reuse_surfaces.mjs";
import { buildBrowseConceptLanding, renderBrowseConceptLanding } from "../site/browse_concept_view.mjs";
import { buildBrowseAliasDocument } from "../site/primary_document_view.mjs";
import { readFileSync } from "node:fs";

const shell = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

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
