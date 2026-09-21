import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import { normalizePdcCalendarMeeting, normalizeBsaCalendarMeeting, normalizeOathTrialCalendarMeeting } from "../site/meeting_object_contract.mjs";
import { buildObserveSurface, normalizeObserveScope, observeScopeUrl, OBSERVE_SPEAK_BOUNDARY, renderObserveDocument } from "../site/government_observe.mjs";
import { admitSearchDocument, SEARCH_DOCUMENT_SCHEMA } from "../site/search_document_contract.mjs";
import { todayISO, withPinnedClock } from "./helpers/test_clock.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function addDays(day, days) {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function fixtureRows(day0, day1) {
  return [
    normalizePdcCalendarMeeting({ pdc_event_id: "pdc-1", title: "PDC public review", event_date: day0 + "T10:00:00", venue: { name: "City Hall" }, source_url: "https://example.test/pdc", description: "Review a public design proposal.", access_steps: [{ kind: "observer_instructions", destination: "https://example.test/pdc-step", source_url: "https://example.test/pdc-step" }], affected_area: { boroughs: ["Manhattan"] } }),
    normalizePdcCalendarMeeting({ pdc_event_id: "pdc-3", title: "PDC second public review", event_date: day0 + "T12:00:00", venue: { name: "City Hall" }, source_url: "https://example.test/pdc-3", description: "Review another public design proposal.", affected_area: { boroughs: ["Manhattan"] } }),
    normalizeBsaCalendarMeeting({ bsa_session_id: "bsa-1", title: "BSA executive review", event_date: day1 + "T14:00:00", venue: { name: "Municipal Building" }, source_url: "https://example.test/bsa", observer_access: { watch_url: "https://example.test/watch" }, access_steps: [{ kind: "observer_instructions", destination: "https://example.test/bsa-step", source_url: "https://example.test/bsa-step" }], agenda_items: [{ case_id: "2026-1" }], affected_area: { community_districts: ["M01"] } }),
    normalizeOathTrialCalendarMeeting({ oath_trial_session_id: "oath-1", title: "OATH scheduled trial", event_date: day1 + "T11:00:00", venue: { name: "OATH hearing room" }, source_url: "https://example.test/oath", description: "Observe an administrative trial.", access_steps: [{ kind: "observer_instructions", destination: "https://example.test/oath-step", source_url: "https://example.test/oath-step" }], affected_area: { neighborhoods: ["Civic Center"] } }),
    normalizePdcCalendarMeeting({ pdc_event_id: "pdc-2", title: "PDC long complete title for overflow counting", event_date: day1 + "T16:00:00", venue: { name: "City Hall" }, source_url: "https://example.test/pdc-2", description: "Review a second public design proposal." }),
    normalizeOathTrialCalendarMeeting({ oath_trial_session_id: "oath-2", title: "OATH second scheduled trial", event_date: day1 + "T13:00:00", venue: { name: "OATH hearing room" }, source_url: "https://example.test/oath-2", description: "Observe a second administrative trial.", affected_area: { neighborhoods: ["Civic Center"] } }),
  ];
}

function detailHtml(row, currentHref) {
  const href = new URL(currentHref, "http://127.0.0.1").searchParams.get("return_to") || "/observe/";
  return "<!doctype html><html><body><main><a data-observe-return href=\"" + href.replaceAll("&", "&amp;") + "\">Back to observations</a><h1>" + row.title + "</h1></main></body></html>";
}

async function startFixtureServer(html, rows) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/observe/" || url.pathname === "/observe") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (url.pathname.startsWith("/meetings/")) {
      if (url.searchParams.get("preview") === "1") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end("{\"error\":\"temporary detail failure\"}");
        return;
      }
      const row = rows.find((candidate) => candidate.meeting_id === decodeURIComponent(url.pathname.slice("/meetings/".length)));
      response.writeHead(row ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      response.end(row ? detailHtml(row, request.url) : "<main><h1>Meeting not found</h1><a href=\"/observe/\">Continue with observations</a></main>");
      return;
    }
    const safePath = normalize(url.pathname).replace(/^(\.\.(\/|\\\\|$))+/, "");
    const file = join(ROOT, "site", safePath.replace(/^\//, ""));
    try {
      response.writeHead(200, { "content-type": url.pathname.endsWith(".css") ? "text/css" : "text/javascript" });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: "http://127.0.0.1:" + server.address().port };
}

function runPythonJourney(source, env) {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", source], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ status: null, stdout, stderr: String(error) }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("A1: each observer source retains precise date, purpose, access step, venue, and affected-place evidence", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", () => {
    const day0 = todayISO();
    const surface = buildObserveSurface({ rows: fixtureRows(day0, addDays(day0, 1)), generated_at: day0 }, {}, { today: day0 });
    const bySource = {
      pdc_calendar: surface.observations.find((row) => row.id.endsWith("pdc-1")),
      bsa_calendar: surface.observations.find((row) => row.source_system === "bsa_calendar"),
      oath_trial_calendar: surface.observations.find((row) => row.source_system === "oath_trial_calendar"),
    };
    assert.equal(bySource.pdc_calendar.date_value, day0 + "T10:00:00");
    assert.equal(bySource.bsa_calendar.access, "remote");
    assert.equal(bySource.oath_trial_calendar.access_step.href, "https://example.test/oath-step");
    assert.deepEqual([bySource.pdc_calendar, bySource.bsa_calendar, bySource.oath_trial_calendar].map((row) => [row.source_system, row.venue, row.affected_place]), [["pdc_calendar", "City Hall", "Manhattan"], ["bsa_calendar", "Municipal Building", "M01"], ["oath_trial_calendar", "OATH hearing room", "Civic Center"]]);
    assert.deepEqual(surface.guides.map((guide) => guide.id), ["ccrb", "hart-island", "ddc"]);
  });
});

test("A2: URL, collection, search production, and serving retain distinct venue and affected-place semantics", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", () => {
    const day0 = todayISO();
    const rows = fixtureRows(day0, addDays(day0, 1));
    const scope = normalizeObserveScope("?body=bsa_calendar&access=remote&placeRole=venue&view=calendar&month=2026-09&selection=x&scroll=44&focus=selection");
    assert.equal(observeScopeUrl(scope), "/observe/?activity=observe&body=bsa_calendar&access=remote&placeRole=venue&view=calendar&month=2026-09&selection=x&scroll=44&focus=selection");
    const surface = buildObserveSurface({ rows, generated_at: day0 }, scope, { today: day0 });
    assert.deepEqual(surface.observations.map((row) => row.source_system), ["bsa_calendar"]);
    const document = admitSearchDocument({
      schema: SEARCH_DOCUMENT_SCHEMA, object_ref: "meeting:bsa_calendar:bsa-1", object_type: "meeting", domain: "meetings",
      canonical_href: "/meetings/meeting%3Absa_calendar%3Absa-1", title: "BSA executive review",
      summary: "Municipal Building", search_text: "BSA executive review Municipal Building",
      source_family: "shared_meeting_read_model", source_observation_refs: ["bsa_calendar:bsa-1"],
      classification: { method: "canonical_meeting_projection", basis: "meeting_object.v1:exact_source_qualified_meeting_id" },
      provenance: { producer: "shared_meeting_search_document.v1", source_system: "bsa_calendar" },
      observation: {
        activity: "observe", body: "bsa_calendar", access: "remote", place_role: null,
        venue: { label: "Municipal Building", source_backed: true },
        affected_place: { label: "M01", source_backed: true },
      },
    }).document;
    assert.equal(document.observation.activity, "observe");
    assert.equal(document.observation.venue.label, "Municipal Building");
    assert.equal(document.observation.affected_place.label, "M01");
    assert.equal(document.observation.venue.source_backed, true);
    assert.equal(document.observation.affected_place.source_backed, true);
  });
});

test("A3/A4: shared calendar markup keeps complete titles, stable ordering, exact overflow, and separate guides", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", () => {
    const day0 = todayISO();
    const html = renderObserveDocument(buildObserveSurface({ rows: fixtureRows(day0, addDays(day0, 1)), generated_at: day0 }, "?view=calendar&month=2026-09", { today: day0 }));
    assert.match(html, /data-compact-month-schema/);
    assert.match(html, /calendar-event-preview/);
    assert.match(html, /\+1 more/);
    assert.match(html, /PDC long complete title for overflow counting/);
    assert.match(html, /CCRB public trials/);
    assert.match(html, /Hart Island public visits/);
    assert.match(html, /DDC bid openings/);
    assert.doesNotMatch(html, /subscribe|webcal:/i);
    assert.match(html, /datetime=\"2026-09-15T10:00:00\"/);
  });
});

test("A5: direct route state and disappearing selection have a safe return path", () => {
  const scope = normalizeObserveScope("?body=bsa_calendar&access=remote&placeRole=venue&view=calendar&month=2026-09&selection=missing&scroll=420&focus=selection");
  const html = renderObserveDocument(buildObserveSurface({ rows: [] }, scope, { today: "2026-09-15" }));
  assert.match(html, /data-observe-view=\"calendar\"/);
  assert.match(html, /data-observe-scroll=\"420\"/);
  assert.match(html, /observe-return-fallback/);
  assert.match(html, /Continue with the current observations/);
});

test("A6: served desktop, narrow touch, keyboard, no-JavaScript, failed-detail, and Back journey", async () => {
  const day0 = "2026-09-15";
  const rows = fixtureRows(day0, addDays(day0, 1));
  const html = renderObserveDocument(buildObserveSurface({ rows, generated_at: day0 }, "?view=calendar&month=2026-09&body=pdc_calendar", { today: day0 }));
  const fixture = await startFixtureServer(html, rows);
  const python = [
    "import os",
    "from playwright.sync_api import sync_playwright",
    "base = os.environ[\"CITYSCROLL_OBSERVE_BASE\"]",
    "with sync_playwright() as pw:",
    "    browser = pw.chromium.launch(headless=True)",
    "    for width, touch in [(1280, False), (390, True)]:",
    "        page = browser.new_page(viewport={\"width\": width, \"height\": 844}, has_touch=touch)",
    "        requests = []",
    "        errors = []",
    "        page.on(\"request\", lambda request: requests.append(request.url))",
    "        page.on(\"pageerror\", lambda error: errors.append(str(error)))",
    "        page.on(\"console\", lambda message: errors.append(\"console:\" + message.text) if message.type == \"error\" else None)",
    "        page.goto(base + \"/observe/?view=calendar&month=2026-09&body=pdc_calendar\", wait_until=\"commit\")",
    "        page.locator(\".observe-card\").first.wait_for()",
    "        assert \"body=pdc_calendar\" in page.url",
    "        summary = page.locator(\".observe-card details summary\").first",
    "        summary.focus()",
    "        page.keyboard.press(\"Enter\")",
    "        assert page.locator(\".observe-card details[open]\").count() == 1",
    "        page.keyboard.press(\"Enter\")",
    "        button = page.locator(\"[data-calendar-event-preview]:visible\").first",
    "        page.wait_for_timeout(1000)",
    "        assert page.locator(\"[data-calendar-event-preview-ready]\").count() == 1, errors",
    "        button.wait_for()",
    "        button.click()",
    "        page.locator(\".calendar-event-preview-dialog[open]\").wait_for()",
    "        page.locator(\".calendar-event-preview-close\").click()",
    "        button.click()",
    "        page.locator(\".calendar-event-preview-detail-status\").wait_for()",
    "        page.locator(\".calendar-event-preview-close\").click()",
    "        assert not any(\"nyc.gov\" in url or \"subscribe\" in url.lower() or \"webcal:\" in url.lower() for url in requests)",
    "        page.locator(\"a.observe-detail\").first.click()",
    "        page.locator(\"[data-observe-return]\").wait_for()",
    "        page.locator(\"[data-observe-return]\").click()",
    "        assert \"body=pdc_calendar\" in page.url and \"view=calendar\" in page.url and \"month=2026-09\" in page.url",
    "        page.close()",
    "    nojs = browser.new_page(java_script_enabled=False, viewport={\"width\": 1280, \"height\": 844})",
    "    nojs.goto(base + \"/observe/?view=calendar&month=2026-09\", wait_until=\"domcontentloaded\")",
    "    assert nojs.locator(\"details\").count() > 0",
    "    assert nojs.locator(\"a.observe-detail\").first.get_attribute(\"href\").startswith(\"/meetings/\")",
    "    browser.close()",
  ].join("\n");
  const result = await runPythonJourney(python, { ...process.env, CITYSCROLL_OBSERVE_BASE: fixture.base });
  await new Promise((resolve) => fixture.server.close(resolve));
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("Observe boundary remains explicit and does not create speaking controls", () => {
  const html = renderObserveDocument(buildObserveSurface({ rows: fixtureRows("2026-09-15", "2026-09-16") }, {}, { today: "2026-09-15" }));
  assert.ok(html.includes(OBSERVE_SPEAK_BOUNDARY));
  assert.doesNotMatch(html, /Request to speak|Submit testimony|register to testify/i);
});
