#!/usr/bin/env node
/**
 * Render exact Council-matter watch specimens from retained snapshot data.
 *
 * No publisher is contacted. Output is JSON consumed by the headless capture.
 *
 *   node tools/render_exact_council_matter_watch_fixtures.mjs
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import snapshot from "../site/data/meeting_outcomes_snapshot.json" with { type: "json" };
import {
  councilMatterChoiceMarkup,
  councilMatterFollowHref,
  councilMatterWatchSummaryHtml,
  exactCouncilMatterWatch,
} from "../site/council_matter_watch.mjs";
import {
  buildFollowingViewModel,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../site/following_view.mjs";

const FIVE = snapshot.by_notice["20260707021"];

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

function followingPage() {
  const href = councilMatterFollowHref({ lens: "meetings", matter_id: "79200" }, { frequency: "weekly" });
  const parsed = watchFromFollowingParams(new URL(href, "https://cityscroll.org").searchParams);
  return renderFollowingDocument(buildFollowingViewModel(parsed), { assetPrefix: "/" });
}

function fiveMatterChoice() {
  const body = `<p class="node-kicker">Notice 20260707021</p>
    <h1>Choose the exact Council matter to follow</h1>
    <p>This hearing listed five matters. Following one does not follow the others.</p>
    ${councilMatterChoiceMarkup(FIVE.matters)}
    <p><a class="node-action" href="/browse/meetings/">Back to meetings</a></p>`;
  return shell("Five-matter hearing · CityScroll", "/hearings/20260707021/", body);
}

function staleHistory() {
  const watch = exactCouncilMatterWatch({ lens: "meetings", matter_id: "79200" });
  const body = `<h1>Council matter 79200</h1>
    ${councilMatterWatchSummaryHtml(watch, { stale: true })}
    <p><a class="node-action" href="/following/">Back to Following</a></p>`;
  return shell("Stale matter watch · CityScroll", "/following/?lens=meetings&matter=79200", body);
}

export function renderExactMatterWatchFixtures() {
  return {
    "following-exact-matter": { html: followingPage(), route: "/following/?lens=meetings" },
    "five-matter-choice": { html: fiveMatterChoice(), route: "/hearings/20260707021/" },
    "stale-last-known": { html: staleHistory(), route: "/following/matter-79200/" },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(renderExactMatterWatchFixtures())}\n`);
}
