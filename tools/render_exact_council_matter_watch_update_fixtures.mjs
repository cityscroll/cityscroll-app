#!/usr/bin/env node
/**
 * Render exact Council-matter watch-update specimens from retained snapshot data.
 *
 * No publisher is contacted. Output is JSON consumed by the headless capture.
 *
 *   node tools/render_exact_council_matter_watch_update_fixtures.mjs
 */
import { pathToFileURL } from "node:url";

import snapshot from "../site/data/meeting_outcomes_snapshot.json" with { type: "json" };
import {
  councilMatterWatchSummaryHtml,
  exactCouncilMatterWatch,
} from "../site/council_matter_watch.mjs";
import {
  reduceCouncilMatterWatchUpdates,
  renderCouncilMatterWatchUpdate,
} from "../site/council_matter_watch_change.mjs";

function appearance(matterId, noticeId) {
  const record = snapshot.by_notice[noticeId];
  const matter = (record?.matters || []).find((row) => String(row.matter_id) === String(matterId));
  const action = (Array.isArray(matter?.actions) ? matter.actions.at(-1) : "") || matter?.outcome;
  return {
    observation_id: `obs:${matterId}:${record.event.event_id}:${noticeId}`,
    matter_id: String(matterId),
    event_id: String(record.event.event_id),
    action_name: action,
    title: matter?.title,
    event_time: record.event.date,
    observed_at: record.event.date,
    acquired_at: `${record.event.date}T12:00:00.000Z`,
    published_revision: `rev:${noticeId}:${record.event.event_id}`,
    notice_references: [noticeId],
    semantic_revision: action,
  };
}

function shell(title, route, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="/civic-documents.css"><link rel="stylesheet" href="/brand.css">
<style>
  body{margin:0;font:16px/1.5 ui-sans-serif,system-ui,sans-serif}
  main{max-width:72rem;margin:0 auto;padding:1rem}
  .matter-follow-link{display:inline-flex;min-height:44px;min-width:44px;align-items:center;padding:.5rem 1rem;border:1px solid #1f6b4f;border-radius:6px;text-decoration:none}
</style></head>
<body><a class="skip" href="#main">Skip to content</a>
<main id="main" data-route="${route}">${body}</main></body></html>`;
}

function occurredUpdate() {
  const early = appearance("78605", "20260408025");
  const later = appearance("78605", "20260428021");
  const [update] = reduceCouncilMatterWatchUpdates({
    matter_ref: "legistar:nyc:matter:78605",
    observations: [early, later],
    baseline: { observation_ids: [early.observation_id], baseline_acquired_at: early.acquired_at },
    asOf: "2026-08-10",
  });
  const watch = exactCouncilMatterWatch({ lens: "meetings", matter_id: "78605" });
  const body = `<h1>Council matter 78605</h1>
    ${councilMatterWatchSummaryHtml(watch, { latest: update })}
    ${renderCouncilMatterWatchUpdate(update)}
    <p><a class="node-action" href="/following/">Back to Following</a></p>`;
  return shell("Matter update · CityScroll", "/matters/78605/", body);
}

function scheduledUpdate() {
  const early = appearance("78605", "20260408025");
  const scheduled = {
    observation_id: "obs-scheduled",
    matter_id: "78605",
    event_id: "24000",
    action_name: "",
    status: "scheduled",
    event_time: "2026-12-01",
    observed_at: "2026-12-01",
    acquired_at: "2026-08-20T00:00:00.000Z",
    published_revision: "rev-scheduled",
  };
  const [update] = reduceCouncilMatterWatchUpdates({
    matter_ref: "legistar:nyc:matter:78605",
    observations: [early, scheduled],
    baseline: { observation_ids: [early.observation_id], baseline_acquired_at: early.acquired_at },
    asOf: "2026-08-10",
  });
  const body = `<h1>Council matter 78605</h1>
    ${renderCouncilMatterWatchUpdate(update)}
    <p><a class="node-action" href="/following/">Back to Following</a></p>`;
  return shell("Scheduled matter update · CityScroll", "/matters/78605/scheduled/", body);
}

function correctionUpdate() {
  const early = appearance("78605", "20260408025");
  const later = appearance("78605", "20260428021");
  const correction = {
    ...later,
    observation_id: "obs-correction",
    action_name: "Amended by Subcommittee",
    semantic_revision: "Amended by Subcommittee",
    published_revision: "rev-correction",
    acquired_at: "2026-08-21T00:00:00.000Z",
  };
  const [update] = reduceCouncilMatterWatchUpdates({
    matter_ref: "legistar:nyc:matter:78605",
    observations: [early, later, correction],
    baseline: {
      observation_ids: [early.observation_id, later.observation_id],
      baseline_acquired_at: later.acquired_at,
    },
    asOf: "2026-08-22",
  });
  const body = `<h1>Council matter 78605</h1>
    ${renderCouncilMatterWatchUpdate(update)}
    <p class="matter-watch-stale" role="status">The last known history is still shown. A later refresh has not been applied.</p>
    <p><a class="node-action" href="/following/">Back to Following</a></p>`;
  return shell("Corrected matter update · CityScroll", "/matters/78605/correction/", body);
}

export function renderExactMatterWatchUpdateFixtures() {
  return {
    "occurred-update": { html: occurredUpdate(), route: "/matters/78605/" },
    "scheduled-update": { html: scheduledUpdate(), route: "/matters/78605/scheduled/" },
    "correction-update": { html: correctionUpdate(), route: "/matters/78605/correction/" },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(renderExactMatterWatchUpdateFixtures())}\n`);
}
