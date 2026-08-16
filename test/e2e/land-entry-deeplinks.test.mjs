import { SITE_SOURCE } from "../helpers/site_source.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { landProjectDisplayTitle } from "../../site/display_title.mjs";
import {
  objectCardInteractionProjection,
  renderObjectCardCopy,
} from "../../site/affordance_grammar.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const src = SITE_SOURCE;

function extractFn(name) {
  let start = src.indexOf("async function " + name + "(");
  if (start === -1) start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found in index.html`);
  let depth = 0;
  let seen = false;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") {
      depth++;
      seen = true;
    } else if (src[j] === "}" && --depth === 0 && seen) {
      return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

function extractDecl(name) {
  const match = src.match(new RegExp(`(?:^|\\n)const ${name}\\s*=`));
  assert.ok(match, `const ${name} not found in index.html`);
  const start = match.index + match[0].indexOf("const");
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    const char = src[j];
    if (char === "{" || char === "[" || char === "(") depth++;
    else if (char === "}" || char === "]" || char === ")") depth--;
    else if (char === ";" && depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unterminated const ${name}`);
}

// Fixture: real ZAP project 2023M0452 (Allen Street Mall Demapping), captured from NYC
// Open Data dataset hgx4-8ukb on 2026-07-27 and retained as a deterministic network mock.
const ALLEN_STREET = {
  project_id: "2023M0452",
  project_name: "Allen Street Mall Demapping",
  project_brief:
    "An application to demap part of Allen Street as street and map it as parkland.",
  primary_applicant: "DPR - Department of Parks & Recreation NYC",
  public_status: "Completed",
  project_status: "Active",
  borough: "Manhattan",
  community_district: "M03",
  actions: "MM; ZR",
  mih_flag: "false",
  current_milestone: "MM - Final Letter Sent",
  ulurp_numbers: "250306MMM; N250307ZRM",
};

const locationStub = {
  origin: "https://cityscroll.org",
  pathname: "/",
};
const escUiHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

function loadLandPermalinkTools(location) {
  return new Function(
    "location",
    "t",
    "qrButtonHTML",
    "currentLanguageURL",
    "landProjectDisplayTitle",
    "objectCardInteractionProjection",
    "renderObjectCardCopy",
    "escUiHtml",
    extractDecl("landLink")
      + extractFn("parseLandHashSegment")
      + extractFn("landObjectCardProjection")
      + extractFn("landPermalinkActionHTML")
      + "\nreturn { landLink, parseLandHashSegment, landPermalinkActionHTML };",
  )(
    location,
    (key) => ({ copy_link: "Copy link" })[key] || key,
    () => "",
    (url) => url,
    landProjectDisplayTitle,
    objectCardInteractionProjection,
    renderObjectCardCopy,
    escUiHtml,
  );
}

const {
  landLink,
  parseLandHashSegment,
  landPermalinkActionHTML,
} = loadLandPermalinkTools(locationStub);

test("a real ZAP project gets a canonical #land/<project_id> permalink", () => {
  assert.equal(parseLandHashSegment(ALLEN_STREET.project_id), ALLEN_STREET.project_id);
  assert.equal(landLink(ALLEN_STREET.project_id), "https://cityscroll.org/#land/2023M0452");
});

test("#land/<project_id> continues to resolve and lands on the Land tab label", () => {
  const landMatch = src.match(/<a class="tabbtn"[^>]*data-tab="land"[^>]*>(.*?)<\/a>/);
  assert.equal(landMatch?.[1], "Land");
  const applyHash = extractFn("applyHash");
  assert.match(applyHash, /raw\.startsWith\("land\/"\)/);
  assert.match(applyHash, /showLandEntry\(parseLandHashSegment\(raw\.slice\(5\)\)\);/);
});

test("the Land detail exposes the same Copy link action shape as notice details", () => {
  const html = landPermalinkActionHTML(ALLEN_STREET);
  assert.match(html, /class="ui-object-card-copy"/);
  assert.match(html, /data-object-card-copy="https:\/\/cityscroll\.org\/#land\/2023M0452"/);
  assert.match(html, />Copy link<\/button>/);
});

test("local preview origins still project the canonical public Land permalink", () => {
  const localTools = loadLandPermalinkTools({
    origin: "http://127.0.0.1:4173",
    pathname: "/browse/zoning/",
  });
  const html = localTools.landPermalinkActionHTML(ALLEN_STREET);
  assert.match(html, /data-object-card-copy="https:\/\/cityscroll\.org\/browse\/zoning\/#land\/2023M0452"/);
});

test("malformed land ids fail soft instead of throwing or entering the detail query", () => {
  assert.equal(parseLandHashSegment(""), null);
  assert.equal(parseLandHashSegment("not/a/project"), null);
  assert.equal(parseLandHashSegment("%E0%A4%A"), null);
  assert.equal(parseLandHashSegment("x".repeat(81)), null);
});

test("applyHash recognizes #land/<project_id> before the tab-level #land route", () => {
  const applyHash = extractFn("applyHash");
  const entryRoute = applyHash.indexOf('raw.startsWith("land/")');
  const tabRoute = applyHash.indexOf('const qi = raw.indexOf("?")');
  assert.notEqual(entryRoute, -1, "missing Land entry route");
  assert.ok(entryRoute < tabRoute, "Land entry route must run before generic tab parsing");
  assert.match(applyHash, /showLandEntry\(parseLandHashSegment\(raw\.slice\(5\)\)\)/);
});

test("cold-open loader fetches the exact real project and selects it in the existing Land pane", async () => {
  const elements = {
    "#llist": { innerHTML: "", querySelector: () => row },
    "#ldetail": { innerHTML: "" },
    "#lreshead": { textContent: "" },
    "#lrescount": { textContent: "" },
    "#land-borough-rail": { innerHTML: "" },
    "#lkw": { value: "prior search" },
    "#lstatus": { value: "all" },
  };
  const row = { dataset: { i: "0" } };
  const calls = { showTab: [], selected: [] };

  const { showLandEntry } = new Function(
    "fixture",
    `
      let landLoaded=false, landBanner="", landBorough="", lRows=[], landSelectionSeq=0;
      const t=key => key === "rezonings_heading" ? "Rezonings" : key;
      const $=selector => elements[selector];
      const elements=fixture.elements;
      const showTab=name => fixture.calls.showTab.push(name);
      const syncLandLensControls=()=>{};
      const setLandStatus=()=>{};
      const setLandResultCount=count=>{ elements["#lrescount"].textContent=String(count); };
      const focusItemRouteTarget=()=>{};
      const applyActiveHistoryRouteScroll=()=>{};
      const busyList=()=>{};
      const unbusy=()=>{};
      const clearLandDetail=()=>{};
      const listSkeleton=()=>"<div class=\\"empty skel\\"></div>";
      const staleGuard=()=>()=>false;
      const renderLandEntryNotFound=id => fixture.notFound.push(id);
      const loadLandProjectsSnapshot=async () => fixture.rows;
      const landRenderList=()=>{};
      const landSelect=async (i, el) => fixture.calls.selected.push({i, el});
      ${extractFn("showLandEntry")}
      return { showLandEntry };
    `,
  )({
    elements,
    calls,
    rows: [ALLEN_STREET],
    notFound: [],
  });

  await showLandEntry(ALLEN_STREET.project_id);

  assert.deepEqual(calls.showTab, ["land"]);
  assert.deepEqual(calls.selected, [{ i: 0, el: row }]);
});

test("unknown but well-formed project ids return to the Zoning collection without an apology panel", async () => {
  const notFound = [];
  const { showLandEntry } = new Function(
    "fixture",
    `
      let landLoaded=false, landBanner="", lRows=[], landSelectionSeq=0;
      const t=key => key;
      const $=()=>({innerHTML:"",textContent:"",value:"",querySelector:()=>null});
      const showTab=()=>{};
      const syncLandLensControls=()=>{};
      const setLandStatus=()=>{};
      const setLandResultCount=()=>{};
      const busyList=()=>{};
      const unbusy=()=>{};
      const clearLandDetail=()=>{};
      const listSkeleton=()=>"<div class=\\"empty skel\\"></div>";
      const staleGuard=()=>()=>false;
      const renderLandEntryNotFound=id => fixture.notFound.push(id);
      const loadLandProjectsSnapshot=async () => [];
      const landRenderList=()=>{};
      const landSelect=async ()=>{};
      ${extractFn("showLandEntry")}
      return { showLandEntry };
    `,
  )({ notFound });

  await showLandEntry("2099Q9999");
  assert.deepEqual(notFound, ["2099Q9999"]);
});
