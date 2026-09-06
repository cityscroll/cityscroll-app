#!/usr/bin/env node
/**
 * Render retained matter publication specimens from committed snapshot data.
 *
 * No publisher is contacted. Output is JSON consumed by the headless capture.
 *
 *   node tools/render_retained_matter_publication_fixtures.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildLegislativeMatterLookup } from "./build_legislative_matter_documents.mjs";
import {
  MATTER_COVERAGE_STATE,
  stampMatterLookup,
} from "../site/matter_publication_generation.mjs";
import {
  buildLegislativeMatterDocument,
  renderLegislativeMatterDocument,
} from "../site/legislative_matter_document.mjs";
import {
  councilMatterChoiceMarkup,
  councilMatterWatchSummaryHtml,
} from "../site/council_matter_watch.mjs";
import {
  reduceCouncilMatterWatchUpdates,
  renderCouncilMatterWatchUpdate,
} from "../site/council_matter_watch_change.mjs";
import {
  projectCouncilHearingMatterContinuation,
  renderCouncilHearingMatterContinuation,
} from "../site/council_hearing_matter_continuation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshot = JSON.parse(readFileSync(join(ROOT, "site/data/meeting_outcomes_snapshot.json"), "utf8"));
const committedLookup = buildLegislativeMatterLookup(snapshot);

const MATTER_ID = "78605";
const EARLY_NOTICE = "20260408025";
const LATER_NOTICE = "20260428021";
const FIVE_MATTER_NOTICE = "20260707021";
const GENERATION_ID = "gen-later";
const DATA_VINTAGE = snapshot.generated_at;

function hash(html) {
  return createHash("sha256").update(html).digest("hex");
}

function shell(title, route, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="/civic-documents.css"><link rel="stylesheet" href="/brand.css">
<style>
  body{margin:0}
  main{max-width:72rem;margin:0 auto;padding:1rem}
  .matter-follow-link,.node-action{display:inline-flex;min-height:44px;min-width:44px;align-items:center;padding:.5rem 1rem;border:1px solid #1f6b4f;border-radius:6px;text-decoration:none}
</style></head>
<body><a class="skip" href="#main">Skip to content</a>
<main id="main" data-route="${route}">${body}</main></body></html>`;
}

function lookupFromNotices(noticeIds) {
  const by_notice = {};
  for (const id of noticeIds) {
    if (snapshot.by_notice[id]) by_notice[id] = snapshot.by_notice[id];
  }
  return buildLegislativeMatterLookup({ ...snapshot, by_notice });
}

function appearance(matterId, noticeId, extra = {}) {
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
    notice_references: [noticeId],
    semantic_revision: action,
    ...extra,
  };
}

function documentHtml(lookup, matterId, extra = {}) {
  const view = buildLegislativeMatterDocument(stampMatterLookup(lookup, extra), matterId);
  return renderLegislativeMatterDocument(view, {
    currentHref: `https://cityscroll.org/matters/${matterId}/?from=/browse/meetings/`,
    today: "2026-08-10",
  });
}

function pack(name, route, html, extra = {}) {
  return {
    name,
    route,
    html,
    render_hash: hash(html),
    generation_id: extra.generation_id || null,
    data_vintage: DATA_VINTAGE,
    coverage_state: extra.coverage_state || null,
  };
}

export function renderRetainedMatterPublicationFixtures() {
  const laterLookup = lookupFromNotices([EARLY_NOTICE, LATER_NOTICE]);
  const five = snapshot.by_notice[FIVE_MATTER_NOTICE];
  const fiveRecord = {
    source_system: "city_record",
    request_id: FIVE_MATTER_NOTICE,
    meeting_id: `city_record:${FIVE_MATTER_NOTICE}`,
    meeting_outcome: five,
  };
  const fiveProjection = projectCouncilHearingMatterContinuation(fiveRecord, five);
  const hearingBody = `${renderCouncilHearingMatterContinuation(fiveRecord, five)}${councilMatterChoiceMarkup(fiveProjection.matters)}<p><a class="node-action" href="/browse/meetings/">Back to meetings</a></p>`;
  const currentHtml = documentHtml(laterLookup, MATTER_ID, {
    generation_id: GENERATION_ID,
    sequence: 2,
    published_at: "2026-08-10T14:00:00.000Z",
    coverage_state: MATTER_COVERAGE_STATE.CURRENT,
  });
  const fallbackHtml = documentHtml(committedLookup, MATTER_ID, {
    generation_id: `static:${DATA_VINTAGE}`,
    sequence: 0,
    published_at: DATA_VINTAGE,
    coverage_state: MATTER_COVERAGE_STATE.OLDER_STATIC_FALLBACK,
  });
  const staleHtml = documentHtml(laterLookup, MATTER_ID, {
    generation_id: GENERATION_ID,
    sequence: 2,
    published_at: "2026-08-10T14:00:00.000Z",
    coverage_state: MATTER_COVERAGE_STATE.STALE_REFRESH,
  });
  const incompleteHtml = documentHtml(laterLookup, MATTER_ID, {
    generation_id: GENERATION_ID,
    sequence: 2,
    published_at: "2026-08-10T14:00:00.000Z",
    coverage_state: MATTER_COVERAGE_STATE.INCOMPLETE_HISTORY,
  });
  const early = appearance(MATTER_ID, EARLY_NOTICE);
  const later = appearance(MATTER_ID, LATER_NOTICE, {
    published_generation_id: GENERATION_ID,
    published_generation_sequence: 2,
  });
  const [update] = reduceCouncilMatterWatchUpdates({
    matter_ref: `legistar:nyc:matter:${MATTER_ID}`,
    observations: [early, later],
    baseline: { observation_ids: [early.observation_id], baseline_acquired_at: early.acquired_at },
    publishedGeneration: { generation_id: GENERATION_ID, sequence: 2, published_at: "2026-08-10T14:00:00.000Z" },
  });
  const updateBody = `<h1>Council matter ${MATTER_ID}</h1>
    ${councilMatterWatchSummaryHtml({ lens: "meetings", matter_id: MATTER_ID }, { latest: update })}
    ${renderCouncilMatterWatchUpdate(update)}
    <p><a class="node-action" href="/matters/${MATTER_ID}/">View matter history</a></p>
    <p><a class="node-action" href="/following/">Back to Following</a></p>`;
  const failed = councilMatterWatchSummaryHtml({ lens: "meetings", matter_id: MATTER_ID }, { confirmation: "failed" });
  const unsupported = councilMatterWatchSummaryHtml({ lens: "meetings", matter_id: "not-a-matter" });

  return {
    "hearing-choice": pack("hearing-choice", `/notices/${FIVE_MATTER_NOTICE}/`, shell("Hearing matters · CityScroll", `/notices/${FIVE_MATTER_NOTICE}/`, hearingBody)),
    "history-current": pack("history-current", `/matters/${MATTER_ID}/`, currentHtml, {
      generation_id: GENERATION_ID,
      coverage_state: MATTER_COVERAGE_STATE.CURRENT,
    }),
    "later-update": pack("later-update", `/matters/${MATTER_ID}/`, shell("Matter update · CityScroll", `/matters/${MATTER_ID}/`, updateBody), {
      generation_id: GENERATION_ID,
    }),
    "older-fallback": pack("older-fallback", `/matters/${MATTER_ID}/`, fallbackHtml, {
      generation_id: `static:${DATA_VINTAGE}`,
      coverage_state: MATTER_COVERAGE_STATE.OLDER_STATIC_FALLBACK,
    }),
    "stale-refresh": pack("stale-refresh", `/matters/${MATTER_ID}/`, staleHtml, {
      generation_id: GENERATION_ID,
      coverage_state: MATTER_COVERAGE_STATE.STALE_REFRESH,
    }),
    "incomplete-history": pack("incomplete-history", `/matters/${MATTER_ID}/`, incompleteHtml, {
      generation_id: GENERATION_ID,
      coverage_state: MATTER_COVERAGE_STATE.INCOMPLETE_HISTORY,
    }),
    "failed-confirmation": pack("failed-confirmation", `/following/`, shell("Follow confirmation · CityScroll", "/following/", `<h1>Follow this matter</h1>${failed}`), {
      coverage_state: MATTER_COVERAGE_STATE.FAILED_CONFIRMATION,
    }),
    "unsupported-source": pack("unsupported-source", `/following/`, shell("Unsupported matter · CityScroll", "/following/", `<h1>Follow this matter</h1>${unsupported}`), {
      coverage_state: MATTER_COVERAGE_STATE.UNSUPPORTED_SOURCE,
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(renderRetainedMatterPublicationFixtures())}\n`);
}
