import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FEEDBACK_CATEGORIES } from "../worker/src/lib/feedback.mjs";

const html = readFileSync(new URL("../site/start/index.html", import.meta.url), "utf8");
const preview = readFileSync(new URL("../site/start/preview.mjs", import.meta.url), "utf8");
const about = readFileSync(new URL("../site/about.html", import.meta.url), "utf8");

test("the candidate homepage gives each visitor intent one route", () => {
  assert.match(html, /<a href="\/start\/" aria-current="page">Homepage<\/a>/);
  assert.match(html, /<a href="\/wincitywork\/">WinCityWork<\/a>/);
  assert.match(html, /<a href="\/browse\/">CityScroll Data Hub<\/a>/);
  assert.match(html, /<a href="\/about\.html">About<\/a>/);
  assert.match(html, /<a href="\/about\.html\?intent=general#fbmessage">Contact<\/a>/);
  assert.match(html, />Live</);
  assert.match(html, /Open the WinCityWork Demo/);
  assert.match(html, /The Demo uses sample data/);
  assert.match(html, />Research</);
  assert.match(html, /intent=inquiry&amp;topic=civil-service-exams#fbmessage/);
  assert.match(html, /district manager routes a resident request/);
  assert.match(html, /intent=inquiry&amp;topic=community-boards#fbmessage/);
  assert.match(html, /wider than the City Record alone/);
  assert.match(html, /href="\/guide\/reference\/sources-and-coverage\/"/);
  assert.match(html, /intent=beta#fbmessage/);
  assert.match(html, /noindex, nofollow/);
  assert.doesNotMatch(html, /Use preview navigation|Exit preview|id="start-feedback"|Search NYC records/);
  assert.doesNotMatch(html, /href="\/"/);
});

test("candidate navigation stays on and no longer offers a preview switch or exit", () => {
  assert.match(preview, /\["\/start\/", "Homepage"\]/);
  assert.match(preview, /CityScroll Data Hub/);
  assert.match(preview, /intent=general#fbmessage/);
  assert.match(preview, /if \(startPage\) setPreview\(true\)/);
  assert.doesNotMatch(preview, /Exit preview|start-toggle|start-feedback|location\.assign\("\/"\)/);
});

test("About keeps feedback, research questions, and beta signup on the same form", () => {
  for (const category of ["bug", "feature", "general", "inquiry", "beta"]) {
    assert.match(about, new RegExp(`data-cat="${category}"`));
  }
  assert.match(about, /href="\/privacy"/);
  assert.match(about, /"\/feedback"/);
  assert.match(about, /feedbackPayload\(category,message,email\)/);
  assert.deepEqual(FEEDBACK_CATEGORIES, ["bug", "feature", "general", "inquiry", "beta"]);
});
