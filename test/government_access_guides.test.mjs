import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadGuide } from "../tools/build_guide_documents.mjs";

const articles = loadGuide().articles;
const byUrl = (url) => articles.find((article) => article.url === url);

test("government access guides publish the two native routes with required metadata", () => {
  const observe = byUrl("/guide/how-to/observe-city-government/");
  const request = byUrl("/guide/how-to/request-trial-observation/");
  assert.ok(observe);
  assert.ok(request);
  for (const article of [observe, request]) {
    assert.match(article.last_reviewed, /^2026-09-15$/);
    assert.ok(article.sources.length >= 3);
    assert.ok(article.related.length >= 1);
    assert.equal(article.return_to_task.href, "https://cityscroll.org/observe/");
  }
});

test("six profiles preserve distinct official action targets and boundaries", () => {
  const html = readFileSync("site/guide/how-to/observe-city-government/index.html", "utf8");
  for (const anchor of ["pdc", "bsa", "oath", "ccrb", "hart-island", "ddc"]) {
    assert.match(html, new RegExp(`id=\"${anchor}\"`));
  }
  for (const href of [
    "https://www.nyc.gov/site/planning/about/commission.page",
    "https://www.nyc.gov/site/bsa/calendar/calendar.page",
    "https://www.nyc.gov/site/oath/trials/conference-and-trial-calendar.page",
    "https://www.nyc.gov/site/ccrb/complaints/complaint-process/apu-trials.page",
    "https://www.nyc.gov/site/hartisland/hart-island/visitation.page",
    "https://www.nyc.gov/site/ddc/contracts/construction-contracts.page",
  ]) assert.match(html, new RegExp(href.replaceAll(".", "\\.")));
  assert.match(html, /Teams testimony signup/);
  assert.match(html, /listen-only/);
  assert.match(html, /not a contract award/);
  assert.match(html, /selected-Tuesday policy is not a weekly event schedule/);
});

test("trial guide carries exact OATH request fields and current CCRB handoff", () => {
  const html = readFileSync("site/guide/how-to/request-trial-observation/index.html", "utf8");
  assert.match(html, /index[\s\S]*date[\s\S]*time/i);
  assert.match(html, /OATHCalUnit@OATH\.nyc\.gov/);
  assert.match(html, /rolling three-week grid/);
  assert.match(html, /charges are allegations, not adjudicated findings/);
  assert.match(html, /id="oath"/);
  assert.match(html, /id="ccrb"/);
});

test("guide builder renders the generated routes and calendar return links", () => {
  const observe = readFileSync("site/guide/how-to/observe-city-government/index.html", "utf8");
  const request = readFileSync("site/guide/how-to/request-trial-observation/index.html", "utf8");
  assert.match(request, /href="\/guide\/how-to\/observe-city-government\//);
  assert.match(observe, /href="https:\/\/cityscroll\.org\/observe\/"/);
  assert.match(observe, /href="https:\/\/cityscroll\.org\/observe\/#pdc"/);
  assert.match(observe, /href="\/guide\/how-to\/request-trial-observation\/#oath"/);
});
