// Agency plan reader: index watch comparison, fetch allowlist, and CLI.
//   node --test test/procurement_plan_index_watch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PLANNING_MANIFEST_PATH } from "../site/procurement_plan_listing.mjs";
import { comparePlanIndexes, extractIndexLinks, fiscalYearOfUrl } from "../tools/procurement_plan_index_watch.mjs";
import { fetchIndexPage, runPlanIndexWatch, exitCodeFor, main as watchMain, EXIT, HOST_ALLOWLIST } from "../tools/check_procurement_plan_index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "test/fixtures/procurement_plans");
const readRoot = (rel) => readFileSync(join(ROOT, rel));

const manifestBytes = readRoot(PLANNING_MANIFEST_PATH);
const manifest = JSON.parse(manifestBytes.toString("utf8"));

function pageFor(source, { drop = null, add = null, notes = {}, extraYear = null } = {}) {
  const workbooks = manifest.sources.filter((s) => s.source === source);
  const items = workbooks.filter((w) => w.url !== drop).map((w) => {
    const note = Object.hasOwn(notes, w.url)
      ? notes[w.url]
      : (w.index_note ?? "(updated 6/30/2026)");
    return `<li><a href="${w.url.replace("https://www.nyc.gov", "")}">${w.label}</a> ${note}</li>`;
  });
  if (add) items.push(`<li><a href="${add}">Added</a> (Posted on 11/06/2026)</li>`);
  if (extraYear) items.push(`<li><a href="${extraYear}">Next year</a> (updated 6/30/2027)</li>`);
  return `<html><body><ul>${items.join("\n")}</ul></body></html>`;
}
const okPages = () => ({ mocs_ll1: { ok: true, html: pageFor("mocs_ll1") }, mocs_ll63: { ok: true, html: pageFor("mocs_ll63") } });

test("(viii) unchanged link set is unchanged when recorded notes match the page", () => {
  const r = comparePlanIndexes(manifest, okPages());
  assert.equal(r.summary, "unchanged");
  assert.equal(r.indexes[0].notes_not_recorded, 0);
  assert.equal(r.indexes[1].notes_not_recorded, 0);
  assert.equal(r.indexes[0].recorded_workbooks, 32);
  assert.equal(r.indexes[1].recorded_workbooks, 101);
  assert.equal(exitCodeFor(r), EXIT.clean);
});

test("(viii) removed or added link, changed note and a new fiscal-year folder are each reported as changed", () => {
  const ll1 = manifest.sources.filter((s) => s.source === "mocs_ll1");
  const removed = comparePlanIndexes(manifest, { ...okPages(), mocs_ll1: { ok: true, html: pageFor("mocs_ll1", { drop: ll1[3].url }) } });
  assert.equal(removed.summary, "changed");
  assert.deepEqual(removed.indexes[0].removed.map((x) => x.url), [ll1[3].url]);
  const addedUrl = "/assets/mocs/downloads/Resources/ll63/2027fy/ZZZ_FY27LL63_NP_ADFY.xlsx";
  const added = comparePlanIndexes(manifest, { ...okPages(), mocs_ll63: { ok: true, html: pageFor("mocs_ll63", { add: addedUrl }) } });
  assert.deepEqual(added.indexes[1].added.map((x) => [x.url, x.note]), [[`https://www.nyc.gov${addedUrl}`, "(Posted on 11/06/2026)"]]);
  const uniformNotes = Object.fromEntries(ll1.map((s) => [s.url, "(updated 6/30/2026)"]));
  const withNotes = structuredClone(manifest);
  for (const s of withNotes.sources) if (s.source === "mocs_ll1") s.index_note = "(updated 6/30/2026)";
  const noteChanged = comparePlanIndexes(withNotes, {
    ...okPages(),
    mocs_ll1: { ok: true, html: pageFor("mocs_ll1", { notes: { ...uniformNotes, [ll1[0].url]: "(updated 12/01/2026)" } }) },
  });
  assert.equal(noteChanged.summary, "changed");
  assert.deepEqual(noteChanged.indexes[0].note_changes, [{ url: ll1[0].url, recorded: "(updated 6/30/2026)", observed: "(updated 12/01/2026)" }]);
  assert.equal(noteChanged.indexes[0].notes_not_recorded, 0);
  assert.equal(comparePlanIndexes(withNotes, {
    ...okPages(),
    mocs_ll1: { ok: true, html: pageFor("mocs_ll1", { notes: uniformNotes }) },
  }).summary, "unchanged");
  const nextYear = comparePlanIndexes(manifest, { ...okPages(), mocs_ll1: { ok: true, html: pageFor("mocs_ll1", { extraYear: "/assets/mocs/downloads/Resources/mwbe-LL1/fy28/ACS_LL1_FY28.xlsx" }) } });
  assert.deepEqual(nextYear.indexes[0].new_fiscal_years, [2028]);
  assert.equal(nextYear.indexes[0].status, "changed");
  assert.equal(fiscalYearOfUrl("https://www.nyc.gov/assets/mocs/downloads/Resources/ll63/2028fy/X.xlsx"), 2028);
});

test("(viii) the retained 2026-11-11 pages match the refreshed FY2027 collection", () => {
  const ll1 = readFileSync(join(FIXTURES, "index-pages/m-wbe-ll1.2026-11-11.html"), "utf8");
  const ll63 = readFileSync(join(FIXTURES, "index-pages/standard-prof-services-ll63.2026-11-11.html"), "utf8");
  const r = comparePlanIndexes(manifest, { mocs_ll1: { ok: true, html: ll1 }, mocs_ll63: { ok: true, html: ll63 } });
  assert.equal(r.indexes[0].status, "unchanged");
  assert.equal(r.indexes[1].status, "unchanged");
  assert.equal(r.indexes[1].added.length, 0);
  assert.equal(r.indexes[1].removed.length, 0);
  assert.equal(r.indexes[1].recorded_workbooks, 101);
  assert.equal(r.indexes[1].observed_workbooks, 101);
  const links = extractIndexLinks(ll1, "https://www.nyc.gov/site/mocs/resources/m-wbe-ll1.page");
  assert.equal(links.find((l) => l.url.endsWith("/HPD_LL1_FY27.xlsx")).note, "(updated 7/20/2026)");
  assert.ok(extractIndexLinks(ll63, "https://www.nyc.gov/site/mocs/resources/standard-prof-services-ll63.page")
    .some((a) => a.url.endsWith("/DPRE_LL63_FY27_New.xlsx") && a.note === "(Posted on 08/05/2026)"));
  assert.equal(exitCodeFor(r), EXIT.clean);
});

function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected ${url}`);
    return route(init);
  };
  return { impl, calls };
}
const html = (body, headers = {}) => () => new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } });
const LL1_INDEX = "https://www.nyc.gov/site/mocs/resources/m-wbe-ll1.page";
const LL63_INDEX = "https://www.nyc.gov/site/mocs/resources/standard-prof-services-ll63.page";

test("(viii) fetch failure is could_not_check and never unchanged; exit codes 4 and 5", async () => {
  const { impl } = stubFetch({ [LL1_INDEX]: () => new Response("", { status: 503 }), [LL63_INDEX]: html(pageFor("mocs_ll63")) });
  const r = await runPlanIndexWatch(manifest, { fetchImpl: impl });
  assert.equal(r.summary, "could_not_check");
  assert.equal(r.indexes[0].reason, "http_503");
  assert.equal(exitCodeFor(r), EXIT.could_not_check);
  const both = stubFetch({ [LL1_INDEX]: () => { throw new Error("ECONNRESET"); }, [LL63_INDEX]: html(pageFor("mocs_ll63", { drop: manifest.sources.find((s) => s.source === "mocs_ll63").url })) });
  const r2 = await runPlanIndexWatch(manifest, { fetchImpl: both.impl });
  assert.equal(r2.summary, "changed_and_could_not_check");
  assert.equal(exitCodeFor(r2), EXIT.both);
  const empty = comparePlanIndexes(manifest, { mocs_ll1: { ok: true, html: "<html></html>" }, mocs_ll63: { ok: true, html: pageFor("mocs_ll63") } });
  assert.equal(empty.indexes[0].status, "could_not_check");
});

test("(viii) host allowlist, redirects, size cap and timeout", async () => {
  assert.deepEqual([...HOST_ALLOWLIST], ["www.nyc.gov"]);
  const offHost = await fetchIndexPage("https://evil.example.test/page", { fetchImpl: async () => { throw new Error("must not be contacted"); } });
  assert.equal(offHost.reason, "host_not_allowed");
  const redirect = stubFetch({ [LL1_INDEX]: () => new Response("", { status: 302, headers: { location: "https://evil.example.test/x" } }) });
  assert.equal((await fetchIndexPage(LL1_INDEX, { fetchImpl: redirect.impl })).reason, "host_not_allowed");
  assert.deepEqual(redirect.calls, [LL1_INDEX]);
  const loop = stubFetch({ [LL1_INDEX]: () => new Response("", { status: 301, headers: { location: LL1_INDEX } }) });
  assert.equal((await fetchIndexPage(LL1_INDEX, { fetchImpl: loop.impl })).reason, "too_many_redirects");
  assert.equal(loop.calls.length, 4);
  const declared = stubFetch({ [LL1_INDEX]: html("x", { "content-length": String(2 * 1024 * 1024) }) });
  assert.equal((await fetchIndexPage(LL1_INDEX, { fetchImpl: declared.impl })).reason, "oversize");
  const streamed = stubFetch({ [LL1_INDEX]: html("x".repeat(1024 * 1024 + 10)) });
  assert.equal((await fetchIndexPage(LL1_INDEX, { fetchImpl: streamed.impl })).reason, "oversize");
  const hang = async (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const timed = await fetchIndexPage(LL1_INDEX, { fetchImpl: hang, limits: { timeoutMs: 20, maxBytes: 1024, maxRedirects: 3 } });
  assert.equal(timed.reason, "timeout");
  const same = stubFetch({ [LL1_INDEX]: () => new Response("", { status: 302, headers: { location: "/site/mocs/resources/m-wbe-ll1-2.page" } }), "https://www.nyc.gov/site/mocs/resources/m-wbe-ll1-2.page": html("<a href='x'>y</a>") });
  assert.equal((await fetchIndexPage(LL1_INDEX, { fetchImpl: same.impl })).ok, true);
});

test("(viii) CLI: exit 0 clean, 3 changed, 2 usage; reads the manifest and makes exactly two GETs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-watch-"));
  try {
    const path = join(dir, "manifest.json");
    writeFileSync(path, manifestBytes);
    const sink = { text: "", write(t) { this.text += t; } };
    const clean = stubFetch({ [LL1_INDEX]: html(pageFor("mocs_ll1")), [LL63_INDEX]: html(pageFor("mocs_ll63")) });
    assert.equal(await watchMain(["--manifest", path, "--out", join(dir, "r.json")], { fetchImpl: clean.impl, stdout: sink }), 0);
    assert.equal(clean.calls.length, 2);
    assert.equal(JSON.parse(readFileSync(join(dir, "r.json"), "utf8")).summary, "unchanged");
    const dropped = stubFetch({
      [LL1_INDEX]: html(pageFor("mocs_ll1")),
      [LL63_INDEX]: html(pageFor("mocs_ll63", { drop: manifest.sources.find((s) => s.source === "mocs_ll63").url })),
    });
    assert.equal(await watchMain(["--manifest", path], { fetchImpl: dropped.impl, stdout: sink }), 3);
    assert.equal(await watchMain(["--bogus"], { stdout: sink }), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
