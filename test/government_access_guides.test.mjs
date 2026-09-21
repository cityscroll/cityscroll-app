import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadGuide } from "../tools/build_guide_documents.mjs";
import { normalizeBsaCalendarMeeting, normalizeOathTrialCalendarMeeting, normalizePdcCalendarMeeting } from "../site/meeting_object_contract.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";
import { todayISO, withPinnedClock } from "./helpers/test_clock.mjs";

const articles = loadGuide().articles;
const byUrl = (url) => articles.find((article) => article.url === url);
const withoutJavaScript = (html) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<script\b[^>]*\/>/gi, "");

test("A1: government access guides publish both native routes with required metadata", () => {
  const observe = byUrl("/guide/how-to/observe-city-government/");
  const request = byUrl("/guide/how-to/request-trial-observation/");
  assert.ok(observe);
  assert.ok(request);
  for (const article of [observe, request]) {
    withPinnedClock("2026-09-15T12:00:00Z", () => assert.equal(article.last_reviewed, todayISO()));
    assert.ok(article.sources.length >= 3);
    assert.ok(article.related.length >= 1);
    assert.equal(article.return_to_task.href, "https://cityscroll.org/observe/");
  }
});

test("A2: each profile names what is seen, access, preparation, and an official next step", () => {
  const html = withoutJavaScript(readFileSync("site/guide/how-to/observe-city-government/index.html", "utf8"));
  const profiles = {
    pdc: "https://www.nyc.gov/site/planning/about/commission.page",
    bsa: "https://www.nyc.gov/site/bsa/calendar/calendar.page",
    oath: "https://www.nyc.gov/site/oath/trials/conference-and-trial-calendar.page",
    ccrb: "https://www.nyc.gov/site/ccrb/complaints/complaint-process/apu-trials.page",
    "hart-island": "https://www.nyc.gov/site/hartisland/hart-island/visitation.page",
    ddc: "https://www.nyc.gov/site/ddc/contracts/construction-contracts.page",
  };
  for (const [anchor, href] of Object.entries(profiles)) {
    const section = html.match(new RegExp(`<h2 id="${anchor}">[\\s\\S]*?(?=<h2(?: id=|>))`))?.[0] || "";
    assert.ok(section, `${anchor} profile is missing`);
    assert.match(section, /What you see:/);
    assert.match(section, /Access:/);
    assert.match(section, /Prepare:/);
    assert.ok(section.includes(`href="${href}"`), `${anchor} official next step is wrong or missing`);
  }
});

test("A3: boundary language stays scoped to the qualifying profile", () => {
  const html = readFileSync("site/guide/how-to/request-trial-observation/index.html", "utf8");
  const observe = readFileSync("site/guide/how-to/observe-city-government/index.html", "utf8");
  const section = (source, anchor) => source.match(new RegExp(`<h2 id="${anchor}">[\\s\\S]*?(?=<h2(?: id=|>))`))?.[0] || "";
  assert.match(section(observe, "pdc"), /Teams testimony signup[\s\S]*separate action/);
  assert.doesNotMatch(section(observe, "pdc"), /listen-only/);
  assert.match(section(observe, "bsa"), /listen-only/);
  assert.match(section(observe, "ddc"), /not a contract award/);
  assert.match(section(observe, "ddc"), /does not require bidder registration/);
});

test("A4: OATH and CCRB boundary details are exact and date-list-free", () => {
  const html = readFileSync("site/guide/how-to/request-trial-observation/index.html", "utf8");
  const section = (anchor) => html.match(new RegExp(`<h2 id="${anchor}">[\\s\\S]*?(?=<h2(?: id=|>))`))?.[0] || "";
  assert.match(section("oath"), /<strong>index<\/strong>[\s\S]*<strong>date<\/strong>[\s\S]*<strong>time<\/strong>/);
  assert.match(section("oath"), /OATHCalUnit@OATH\.nyc\.gov/);
  assert.doesNotMatch(section("ccrb"), /\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, 20\d{2}\b/);
  assert.match(section("ccrb"), /rolling three-week grid/);
  assert.match(section("ccrb"), /charges are allegations, not adjudicated findings/);
});

test("A5: Hart Island and DDC retain explicit non-event and registration boundaries", () => {
  const html = readFileSync("site/guide/how-to/observe-city-government/index.html", "utf8");
  const section = (anchor) => html.match(new RegExp(`<h2 id="${anchor}">[\\s\\S]*?(?=<h2(?: id=|>))`))?.[0] || "";
  assert.match(section("hart-island"), /different from close-person gravesite visits/);
  assert.match(section("hart-island"), /uses a lottery/);
  assert.match(section("hart-island"), /selected-Tuesday policy is not a weekly event schedule/);
  assert.match(section("hart-island"), /Do not assume availability/);
  assert.match(section("ddc"), /does not invent a recurring event, confirmed availability/);
  assert.match(section("ddc"), /does not require bidder registration/);
});

test("A6: generated detail fixtures return into the guide and remain usable without JavaScript", () => {
  withPinnedClock("2026-09-15T12:00:00Z", () => {
    const day = todayISO();
    const fixtures = [
      [normalizePdcCalendarMeeting({ pdc_event_id: "pdc-guide", event_date: `${day}T10:00:00`, source_url: "https://example.nyc.gov/pdc" }), "/guide/how-to/observe-city-government/#pdc"],
      [normalizeBsaCalendarMeeting({ bsa_session_id: "bsa-guide", event_date: `${day}T10:00:00`, source_url: "https://example.nyc.gov/bsa" }), "/guide/how-to/observe-city-government/#bsa"],
      [normalizeOathTrialCalendarMeeting({ oath_trial_session_id: `oath-guide:${day}:10:00`, event_date: `${day}T10:00:00`, source_url: "https://example.nyc.gov/oath" }), "/guide/how-to/request-trial-observation/#oath"],
    ];
    for (const [record, href] of fixtures) {
      const detail = renderMeetingDocument(record);
      assert.match(detail, new RegExp(`class="meeting-guide-return"[\\s\\S]*href="${href.replaceAll(/[.*+?^${}()|[\\]\\]/g, "\\$&")}"`));
      assert.match(detail, /<main id="main"/);
    }
  });
  const observe = withoutJavaScript(readFileSync("site/guide/how-to/observe-city-government/index.html", "utf8"));
  const request = withoutJavaScript(readFileSync("site/guide/how-to/request-trial-observation/index.html", "utf8"));
  assert.match(request, /href="\/guide\/how-to\/observe-city-government\//);
  assert.match(observe, /href="https:\/\/cityscroll\.org\/observe\/"/);
  assert.match(observe, /<main[^>]*id="main"[\s\S]*Choose an observation experience/);
  assert.match(request, /<main[^>]*id="main"[\s\S]*OATH — copy three exact fields/);
});

test("A6: complete guide renders cover desktop, mobile, keyboard, and no-JavaScript inspection", () => {
  const routes = [
    ["observe-city-government", readFileSync("site/guide/how-to/observe-city-government/index.html", "utf8")],
    ["request-trial-observation", readFileSync("site/guide/how-to/request-trial-observation/index.html", "utf8")],
  ];

  // The guide markup is deterministic across widths; the served stylesheet supplies the
  // actual desktop/mobile difference. Keep the inspection tied to that source of truth.
  const documentStyles = readFileSync("site/civic-documents.css", "utf8");
  const narrowStyles = documentStyles.slice(documentStyles.indexOf("@media (max-width: 560px)"));
  assert.match(documentStyles, /\.document-mast-inner \{[\s\S]*?display: flex;[\s\S]*?align-items: center;/, "desktop guide masthead keeps its horizontal flex layout");
  assert.match(narrowStyles, /\.document-mast-inner \{[\s\S]*?flex-direction: column;/, "mobile guide masthead stacks at the narrow breakpoint");
  assert.match(narrowStyles, /\.document-nav \{[\s\S]*?width: 100%;/, "mobile guide navigation fills the narrow viewport");

  for (const [route, html] of routes) {
    const noJavaScript = withoutJavaScript(html);
    assert.match(noJavaScript, /<meta name="viewport" content="width=device-width,initial-scale=1">/, `${route} retains responsive viewport metadata without JavaScript`);
    assert.match(noJavaScript, /<main[^>]*id="main"[\s\S]*<h1[\s>]/, `${route} has a landmark and heading without JavaScript`);

    const links = [...noJavaScript.matchAll(/<a\b([^>]*)>/gi)].map((match) => match[1]);
    assert.ok(links.length > 0, `${route} exposes native links for keyboard inspection without JavaScript`);
    assert.ok(links.every((attributes) => /\bhref="[^"]+"/.test(attributes)), `${route} keyboard destinations are native href links without JavaScript`);
    assert.doesNotMatch(noJavaScript, /<a\b[^>]*\btabindex="[1-9]/i, `${route} does not reorder keyboard traversal with positive tabindex without JavaScript`);

    assert.match(noJavaScript, /<main[^>]*id="main"[\s\S]*<h1[\s>]/, `${route} keeps its primary reading path without JavaScript`);
    assert.ok((noJavaScript.match(/<a\b[^>]*href="[^"]+"/gi) || []).length >= 4, `${route} keeps actionable destinations without JavaScript`);
  }
});
