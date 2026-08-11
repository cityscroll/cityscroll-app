import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  MANDATE_PREDICTION_METHOD,
  PREDICTION_BANDS,
  agencyMandatePredictionsPath,
  buildAgencyMandatePredictionsView,
  buildMandatePrediction,
  mandatePredictionDigestRowsForAgency,
  mergeObligationDigestWithPredictions,
  normalizeRecurrence,
  projectExpectedDeadline,
  renderMandatePredictionsSection,
} from "../site/mandate_prediction_alerts.mjs";
import {
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";
import { compileSub } from "../worker/src/lib/compile.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PARKS = "parks-and-recreation";
const NYPD = "police-department";
const DHMH = "health-and-mental-hygiene";
const LOOKUP_PATH = join(ROOT, "site/data/agency_obligations_lookup.json");
const TODAY = "2026-08-08";

const obligations = existsSync(LOOKUP_PATH)
  ? JSON.parse(readFileSync(LOOKUP_PATH, "utf8"))
  : null;

test("normalizeRecurrence maps common extract tokens", () => {
  assert.equal(normalizeRecurrence("annual"), "annual");
  assert.equal(normalizeRecurrence("every year"), "annual");
  assert.equal(normalizeRecurrence("quarterly"), "quarterly");
  assert.equal(normalizeRecurrence("every 5 years"), "every_5_years");
  assert.equal(normalizeRecurrence("one-time"), "one-time");
});

test("projectExpectedDeadline rolls annual and quarterly cycles forward", () => {
  const annual = projectExpectedDeadline("2015-09-30", "annual", TODAY);
  assert.equal(annual.expected_deadline, "2026-09-30");
  assert.equal(annual.deadline_source, "rolled_forward");

  const quarterly = projectExpectedDeadline("2015-11-12", "quarterly", TODAY);
  assert.equal(quarterly.expected_deadline, "2026-08-12");
  assert.equal(quarterly.deadline_source, "rolled_forward");

  const future = projectExpectedDeadline("2029-10-01", "one-time", TODAY);
  assert.equal(future.expected_deadline, "2029-10-01");
  assert.equal(future.deadline_source, "as_stated");

  // Past one-time has no standable next window.
  assert.equal(projectExpectedDeadline("2020-01-01", "one-time", TODAY), null);
  // Undated never invents a calendar day.
  assert.equal(projectExpectedDeadline(null, "annual", TODAY), null);
});

test("buildMandatePrediction names expected event and window without compliance", () => {
  const pred = buildMandatePrediction({
    obligation_id: "53408-003",
    matter_id: "53408",
    agency_id: NYPD,
    agency_name: "Police Department",
    duty_text: "The department must post an annual report on its website.",
    deliverable_type: "report",
    deadline: { computed_date: "2015-09-30" },
    recurrence: "annual",
    citation: "Admin. Code § demo",
    source: { legistar_url: "https://example.test/law" },
  }, { todayISO: TODAY });

  assert.ok(pred);
  assert.equal(pred.expected_event.kind, "report_or_study");
  assert.match(pred.expected_event.label, /Report/i);
  assert.equal(pred.expected_deadline, "2026-09-30");
  assert.equal(pred.days_to_deadline, 53);
  assert.equal(pred.prediction_band, PREDICTION_BANDS.APPROACHING);
  assert.equal(pred.predicted_window.p50, "2026-09-30");
  assert.equal(pred.alert_id, "obligation:53408-003:2026-09-30");
  assert.equal(pred.compliance_verdict, null);
  assert.equal(pred.basis.method, MANDATE_PREDICTION_METHOD);
  assert.doesNotMatch(JSON.stringify(pred), /non-compliance|violat|missed filing|may not/i);
});

test("rolled-forward annual predictions name the next occurrence and prior years", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  const view = buildAgencyMandatePredictionsView(DHMH, {
    obligationsLookup: obligations,
    todayISO: TODAY,
    includeCadenceOnly: true,
  });
  const drowning = view.predictions.find((item) => item.mandate_id === "71638-001");
  assert.ok(drowning, "DHMH drowning report prediction is present");
  assert.equal(drowning.expected_deadline, "2026-11-18");
  assert.equal(drowning.deadline_source, "rolled_forward");
  assert.equal(drowning.recurrence, "annual");

  const html = renderMandatePredictionsSection(view);
  assert.match(html, /annual · next occurrence · prior years: 2024, 2025/);
  assert.match(html, /expected by 2026-11-18/);

  const oneTime = renderMandatePredictionsSection({
    status: "matched",
    predictions: [{
      mandate_id: "one-time-1",
      duty_text: "Submit a one-time report.",
      deliverable_type: "report",
      expected_event: { label: "Report", kind: "report_or_study" },
      expected_deadline: "2029-01-01",
      days_to_deadline: 100,
      recurrence: "one-time",
      deadline_source: "as_stated",
    }],
  });
  assert.doesNotMatch(oneTime, /next occurrence|prior years|annual/);
});

test("program deliverables are not predicted in v1", () => {
  const pred = buildMandatePrediction({
    obligation_id: "p-1",
    duty_text: "Operate a program",
    deliverable_type: "program",
    deadline: { computed_date: "2026-09-01" },
    recurrence: "one-time",
  }, { todayISO: TODAY });
  assert.equal(pred, null);
});

test("shareable path anchors Expected mandate events card", () => {
  assert.equal(
    agencyMandatePredictionsPath(PARKS),
    "/agencies/parks-and-recreation/#mandates-predictions",
  );
});

test("live Parks materialization yields standable predictions", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  const view = buildAgencyMandatePredictionsView(PARKS, {
    obligationsLookup: obligations,
    todayISO: TODAY,
    includeCadenceOnly: true,
  });
  assert.equal(view.status, "matched");
  assert.equal(view.method, MANDATE_PREDICTION_METHOD);
  assert.ok(view.counts.predictions >= 1, "Parks has predictable mandates");
  assert.ok(view.predictions.every((p) => p.duty_text));
  assert.ok(view.predictions.every((p) => p.expected_event?.kind));
  assert.ok(view.predictions.some((p) => p.expected_deadline || p.deadline_source === "cadence_only"));
  // Future dated Parks report (2029-10-01) appears as a far-band prediction.
  const far = view.predictions.find((p) => p.mandate_id === "78458-003");
  assert.ok(far, "pilot report mandate is present");
  assert.equal(far.expected_deadline, "2029-10-01");
  assert.equal(far.prediction_band, PREDICTION_BANDS.FAR);
  assert.match(view.share_path, /#mandates-predictions$/);
  assert.match(view.follow_href, /lens=mandates/);
  assert.doesNotMatch(JSON.stringify(view), /not X but Y|may not be complete|disclaimer/i);
});

test("prediction citations use per-row Source law matter edges and preserve unresolved citations", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  const view = buildAgencyMandatePredictionsView(PARKS, {
    obligationsLookup: obligations,
    todayISO: TODAY,
    includeCadenceOnly: true,
  });
  const html = renderMandatePredictionsSection(view);
  const resolved = view.predictions.filter((item) => item.citation && item.source_href);
  const sourceUrls = new Set(resolved.map((item) => item.source_href));

  // Source law is per-row (co-located matter edge), not a collapsed disclosure.
  assert.match(html, /data-mandate-edge="source_law"/);
  assert.doesNotMatch(html, /Open source laws/);
  assert.ok(
    ([...html.matchAll(/href="(https:\/\/nyc\.legistar\.com\/Gateway\.aspx\?M=L&amp;ID=\d+)"/g)].length)
      >= sourceUrls.size,
  );
  assert.ok(resolved.every((item) => sourceUrls.has(item.source_href)));
  assert.equal(
    view.predictions.find((item) => item.citation === "Administrative Code § 18-142")?.source_href,
    "https://nyc.legistar.com/Gateway.aspx?M=L&ID=53592",
  );

  const unresolved = renderMandatePredictionsSection({
    status: "matched",
    predictions: [{
      mandate_id: "unresolved-1",
      duty_text: "Publish an annual report.",
      deliverable_type: "report",
      citation: "Administrative Code § 99-999",
      expected_event: { label: "Report", kind: "report_or_study" },
      expected_deadline: "2029-01-01",
      days_to_deadline: 100,
      recurrence: "one-time",
      deadline_source: "as_stated",
      source_href: null,
    }],
  });
  assert.match(unresolved, /Administrative Code § 99-999/);
  assert.doesNotMatch(unresolved, /nyc\.legistar\.com|Open source laws|data-mandate-edge="source_law"/);
});

test("prediction source links resolve for two additional agencies", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  for (const agency of [NYPD, DHMH]) {
    const view = buildAgencyMandatePredictionsView(agency, {
      obligationsLookup: obligations,
      todayISO: TODAY,
      includeCadenceOnly: true,
    });
    const html = renderMandatePredictionsSection(view);
    const citationCount = view.predictions.filter((item) => item.citation).length;
    const resolvedUrls = new Set(
      view.predictions
        .filter((item) => item.citation && item.source_href)
        .map((item) => item.source_href),
    );
    assert.ok(citationCount > 0, `${agency} has prediction citations`);
    // Per-row Source law matter edges: one Gateway link per prediction that has a URL.
    const gatewayHits = [
      ...html.matchAll(/href="https:\/\/nyc\.legistar\.com\/Gateway\.aspx\?M=L&amp;ID=\d+"/g),
    ].length;
    assert.ok(
      gatewayHits >= resolvedUrls.size,
      `${agency} surfaces Source law for resolved citations`,
    );
    assert.match(html, /data-mandate-edge="source_law"/);
    assert.equal(
      resolvedUrls.size,
      new Set(view.predictions.filter((item) => item.citation).map((item) => item.source_href)).size,
    );
  }
});

test("NYPD digest path surfaces earlier-stage predicted report events on real data", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  const rows = mandatePredictionDigestRowsForAgency(obligations, NYPD, {
    todayISO: TODAY,
    windowDays: 90,
  });
  assert.ok(rows.length >= 1, "NYPD annual/quarterly reports project into the 90-day window");
  for (const row of rows) {
    assert.equal(row.predicted_event, true);
    assert.ok(row.expected_event_kind);
    assert.ok(row.deadline_date >= TODAY);
    assert.ok(row.days_to_deadline >= 0 && row.days_to_deadline <= 90);
    assert.equal(row.compliance_verdict, null);
    assert.match(row.alert_id, /^obligation:/);
  }
  // Known annual roll-forward: 2015-09-30 → 2026-09-30 (53 days).
  const annual = rows.find((r) => r.obligation_id === "53408-003");
  assert.ok(annual, "annual report deadline_source is in the digest window");
  assert.equal(annual.deadline_date, "2026-09-30");
  assert.equal(annual.days_to_deadline, 53);
  assert.match(annual.expected_event_label, /Report/i);
});

test("compileSub obligations lens merges prediction branch for NYPD", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  const q = compileSub({
    lens: "obligations",
    filter: { agency_id: NYPD, agency: "Police Department", windowDays: 90 },
  }, TODAY);
  assert.ok(q);
  assert.equal(q.kind, "obligation");
  const rows = q.transformRows(obligations);
  const predicted = rows.filter((r) => r.predicted_event === true);
  assert.ok(predicted.length >= 1, "compile path must emit predicted mandate events");
  assert.ok(predicted.every((r) => r.expected_event_kind));
  assert.ok(predicted.every((r) => r.compliance_verdict === null));
});

test("merge prefers prediction cycle over raw past statute date for same mandate", () => {
  const base = [{
    alert_id: "obligation:x-001:2015-09-30",
    obligation_id: "x-001",
    duty_text: "Annual report",
    deliverable_type: "report",
    deadline_date: "2015-09-30",
    deadline_band: "past_date",
    compliance_verdict: null,
  }];
  const predicted = [{
    alert_id: "obligation:x-001:2026-09-30",
    obligation_id: "x-001",
    duty_text: "Annual report",
    deliverable_type: "report",
    deadline_date: "2026-09-30",
    predicted_event: true,
    expected_event_kind: "report_or_study",
    days_to_deadline: 53,
    compliance_verdict: null,
  }];
  const merged = mergeObligationDigestWithPredictions(base, predicted);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].deadline_date, "2026-09-30");
  assert.equal(merged[0].predicted_event, true);
});

test("constellation document renders Expected mandate events for Parks", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  const intelligence = JSON.parse(
    readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"),
  );
  const certification = JSON.parse(
    readFileSync(join(ROOT, "site/data/exam_certification_constellation.json"), "utf8"),
  );
  const processConformance = existsSync(join(ROOT, "site/data/process_conformance_lookup.json"))
    ? JSON.parse(readFileSync(join(ROOT, "site/data/process_conformance_lookup.json"), "utf8"))
    : null;
  const view = buildAgencyConstellationView(PARKS, {
    intelligence,
    certification,
    obligations,
    process_conformance: processConformance,
  });
  assert.equal(view.mandates_predictions?.status, "matched");
  assert.match(view.mandates_predictions_href, /#mandates-predictions$/);

  const html = renderAgencyConstellationDocument(view);
  assert.match(html, /id="mandates-predictions"/);
  assert.match(html, /Expected mandate events/);
  assert.match(html, /data-expected-event-kind=/);
  assert.match(html, /Watch expected mandate events/);
  assert.doesNotMatch(html, /non-compliance|out of compliance|may not be complete/i);
  assert.doesNotMatch(html, /not a prediction of|disclaimer|we cannot guarantee/i);
  const cruft = detectNodePageCruft(html);
  assert.equal(cruft.length, 0, `node page cruft: ${cruft.join("; ")}`);
});

test("renderMandatePredictionsSection omits empty views", () => {
  assert.equal(renderMandatePredictionsSection(null), "");
  assert.equal(renderMandatePredictionsSection({ status: "empty", predictions: [] }), "");
});
