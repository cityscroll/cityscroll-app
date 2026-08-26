import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SEMANTIC_READINESS_MARKERS,
  boundedTerminalState,
  createRumSemanticMilestones,
} from "../site/rum_semantic_milestones.mjs";
import { createBufferedSemanticMilestones } from "../site/rum_production.mjs";
import {
  fixtureHomeReady,
  fixtureInteraction,
  fixtureLandOutcome,
} from "./fixtures/rum_semantic_components.mjs";

function clock(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function recorder() {
  const records = [];
  return {
    records,
    record(value) { records.push(structuredClone(value)); },
  };
}

test("home fixture reuses the product and synthetic semantic readiness contract", () => {
  const homeHtml = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const harness = readFileSync(new URL("./performance/verify.py", import.meta.url), "utf8");
  const marker = SEMANTIC_READINESS_MARKERS.home;

  assert.match(homeHtml, new RegExp(`${marker.context_attribute}="${marker.context_value}"`));
  assert.match(homeHtml, new RegExp(`${marker.ready_attribute}="${marker.ready_value}"`));
  assert.match(harness, /dataset\.primaryContext === 'home'/);
  assert.match(harness, /dataset\.homeReady === 'true'/);

  const sink = recorder();
  const rum = createRumSemanticMilestones({
    enabled: true,
    navigationStart: 0,
    now: clock(125),
    record: sink.record,
  });
  assert.equal(fixtureHomeReady(rum, {
    primaryContext: "home",
    homeReady: "true",
    primaryCtaVisible: true,
    topicInputVisible: true,
  }).state, "recorded");
  assert.deepEqual(sink.records.map((entry) => ({
    milestone: entry.milestone,
    metric_id: entry.metric_id,
    result_state: entry.result_state,
    value: entry.value,
  })), [{
    milestone: "surface-ready",
    metric_id: "content_ready_ms",
    result_state: "content",
    value: 125,
  }]);
});

test("fixture component reports useful, empty, unavailable, and error terminal states", () => {
  for (const [outcome, resultState] of [
    ["present", "content"],
    ["absent", "empty"],
    ["unavailable", "unavailable"],
    ["error", "error"],
  ]) {
    const sink = recorder();
    const rum = createRumSemanticMilestones({
      enabled: true,
      navigationStart: 10,
      now: clock(30),
      record: sink.record,
    });
    const rendered = fixtureLandOutcome(rum, { outcome });
    assert.equal(rendered.readerHtml, outcome === "present" ? "<section>Outcome</section>" : "");
    assert.equal(rendered.report.state, "recorded");
    assert.deepEqual(sink.records.map((entry) => [
      entry.milestone,
      entry.metric_id,
      entry.result_state,
      entry.value,
    ]), [["component-ready", "component_ready_ms", resultState, 20]]);
  }
});

test("interaction fixture emits ordered feedback and settled measurements", () => {
  const sink = recorder();
  const rum = createRumSemanticMilestones({
    enabled: true,
    navigationStart: 0,
    now: clock(100, 130, 180),
    record: sink.record,
  });
  const outcome = fixtureInteraction(rum, {
    componentId: "search-submit",
    resultState: "empty",
  });
  assert.equal(outcome.state, "settled");
  assert.deepEqual(sink.records.map((entry) => [
    entry.milestone,
    entry.metric_id,
    entry.result_state,
    entry.value,
  ]), [
    ["interaction-start", null, null, null],
    ["visual-feedback", "interaction_feedback_ms", null, 30],
    ["settled", "interaction_settled_ms", "empty", 80],
    ["feedback-to-settled", "feedback_to_settled_ms", "empty", 50],
  ]);
});

test("cancel is a bounded terminal event and emits no completed interaction measurement", () => {
  const sink = recorder();
  const rum = createRumSemanticMilestones({
    enabled: true,
    now: clock(20, 25),
    record: sink.record,
  });
  const outcome = fixtureInteraction(rum, {
    surfaceId: "home",
    componentId: "home-search-submit",
    cancel: true,
  });
  assert.equal(outcome.state, "cancelled");
  assert.deepEqual(sink.records.map((entry) => entry.milestone), [
    "interaction-start",
    "cancel",
  ]);
  assert.ok(sink.records.every((entry) => entry.metric_id === null));
});

test("duplicate and out-of-order milestones are rejected without extra records", () => {
  const sink = recorder();
  const rum = createRumSemanticMilestones({
    enabled: true,
    now: clock(10, 11, 12, 13, 14, 15, 16),
    record: sink.record,
  });

  assert.equal(rum.surfaceReady({ surfaceId: "home", resultState: "content" }).state, "recorded");
  assert.equal(rum.surfaceReady({ surfaceId: "home", resultState: "content" }).state, "duplicate");
  assert.equal(rum.componentReady({ surfaceId: "home", componentId: "home-topic-entry", resultState: "empty" }).state, "recorded");
  assert.equal(rum.componentReady({ surfaceId: "home", componentId: "home-topic-entry", resultState: "content" }).state, "duplicate");

  const interaction = rum.interactionStart({ surfaceId: "home", componentId: "home-search-submit" });
  assert.equal(interaction.settled({ resultState: "content" }).state, "out_of_order");
  assert.equal(interaction.visualFeedback().state, "recorded");
  assert.equal(interaction.visualFeedback().state, "duplicate");
  assert.equal(interaction.settled({ resultState: "content" }).state, "settled");
  assert.equal(interaction.cancel().state, "duplicate");

  assert.deepEqual(sink.records.map((entry) => entry.milestone), [
    "surface-ready",
    "component-ready",
    "interaction-start",
    "visual-feedback",
    "settled",
    "feedback-to-settled",
  ]);
});

test("buffered milestone keeps the owner-call timestamp across delayed collector install", () => {
  let clockValue = 125;
  const runtime = { performance: { now: () => clockValue } };
  const buffer = createBufferedSemanticMilestones(runtime);
  assert.equal(buffer.surfaceReady({ surfaceId: "home", resultState: "content" }).state, "buffered");

  clockValue = 9_000;
  const sink = recorder();
  const rum = createRumSemanticMilestones({
    enabled: true,
    navigationStart: 0,
    now: () => clockValue,
    record: sink.record,
  });
  assert.equal(buffer.drain(rum), 1);
  assert.equal(sink.records[0].value, 125);
});

test("terminal states are closed and disabled RUM is a fail-soft no-op", () => {
  for (const state of ["content", "empty", "unavailable", "error"]) {
    assert.equal(boundedTerminalState(state), state);
  }
  for (const state of ["cancelled", "loading", "spinner-gone", "", null, undefined]) {
    assert.equal(boundedTerminalState(state), null);
  }

  let calls = 0;
  const rum = createRumSemanticMilestones({
    enabled: false,
    now() { throw new Error("disabled reporter must not read the clock"); },
    record() { calls += 1; throw new Error("disabled reporter must not emit"); },
  });
  assert.equal(rum.surfaceReady({ surfaceId: "home", resultState: "content" }).state, "disabled");
  assert.equal(rum.componentReady({ surfaceId: "home", componentId: "home-topic-entry", resultState: "empty" }).state, "disabled");
  const interaction = rum.interactionStart({ surfaceId: "home", componentId: "home-search-submit" });
  assert.equal(interaction.state, "disabled");
  assert.equal(interaction.visualFeedback().state, "disabled");
  assert.equal(interaction.settled({ resultState: "content" }).state, "disabled");
  assert.equal(interaction.cancel().state, "disabled");
  assert.equal(calls, 0);

  const failingSink = createRumSemanticMilestones({
    enabled: true,
    now: clock(10),
    record() { throw new Error("observability is unavailable"); },
  });
  assert.doesNotThrow(() => failingSink.surfaceReady({
    surfaceId: "home",
    resultState: "content",
  }));
});

test("the collector remains selector-free; semantic markers stay component-owned", () => {
  const collector = readFileSync(new URL("../site/rum_collector.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(collector, /querySelector|matches\(|closest\(|selector/i);
  assert.doesNotMatch(collector, /data-home-ready|data-zap-outcomes/);
});
