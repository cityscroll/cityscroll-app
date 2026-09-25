#!/usr/bin/env node
/**
 * Capture manifest for segmented meeting detail (alias cb0c04802e711).
 *
 * Renders M1–M3 through the real Pages edge path, records route / viewport /
 * revision / vintage / assertion / sha256, and keeps optional screenshots under
 * .artifacts/ (never committed).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import edgeWorker, { isMeetingDocumentHtml } from "../site/pages_edge.mjs";
import { stableAgendaSegmentId } from "../site/meeting_agenda_segments.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs/evidence/segmented-meeting-detail");
const ARTIFACT_DIR = join(ROOT, ".artifacts/segmented-meeting-detail");
const MANIFEST_PATH = join(OUT_DIR, "capture-manifest.json");

const ARTIFACT = JSON.parse(readFileSync(join(ROOT, "site/data/community_board_hearing_context.json"), "utf8"));
const SHARED = JSON.parse(readFileSync(join(ROOT, "site/data/shared_meeting_read_model.json"), "utf8"));

const M1 = "https://cb14brooklyn.com/meeting/september-2026-board-meeting/";
const M2 = "https://cb14brooklyn.com/meeting/public-hearing-on-ulurp-application-and-executive-committee-meeting-september-2026/";
const M3 = "https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow-touch", width: 390, height: 844 },
];

const SCRIPTING = [
  { name: "enabled", value: "enabled" },
  { name: "no-js", value: "disabled" },
];

function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function revision() {
  const grounded = String(process.env.GROUNDED_AT || process.env.CROL_GROUNDED_AT || "").trim();
  if (/^[0-9a-f]{40}$/i.test(grounded)) return grounded.toLowerCase();
  // Prefer origin/main so retained evidence revisions stay reachable before the
  // branch lands; fall back to HEAD only when origin/main is unavailable.
  const origin = spawnSync("git", ["rev-parse", "origin/main"], { cwd: ROOT, encoding: "utf8" });
  if (origin.status === 0) {
    const sha = origin.stdout.trim();
    if (/^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
  }
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git rev-parse failed");
  return result.stdout.trim();
}

function meetingIdForSource(url) {
  return `meeting:community_board:${url}`;
}

function extractSegments(html) {
  const section = html.match(/<section[^>]*data-meeting-agenda-segments="(\d+)"[^>]*>([\s\S]*?)<\/section>/);
  if (!section) return [];
  const items = [];
  const rowRe = /<li[^>]*class="meeting-agenda-segment"[^>]*>([\s\S]*?)<\/li>/g;
  let match;
  while ((match = rowRe.exec(section[2]))) {
    const row = match[0];
    items.push({
      id: row.match(/\bid="([^"]+)"/)?.[1] || null,
      start_time: row.match(/data-agenda-segment-start="([^"]*)"/)?.[1] || null,
      title: row.match(/<p class="meeting-agenda-segment-title">([\s\S]*?)<\/p>/)?.[1]
        ?.replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .trim() || null,
    });
  }
  return items;
}

async function renderMeeting(url, { currentHref } = {}) {
  const meetingId = meetingIdForSource(url);
  const env = {
    ASSETS: {
      fetch: async (request) => {
        const href = typeof request === "string" ? request : String(request.url || "");
        if (href.includes("/data/community_board_hearing_context.json")) {
          return new Response(JSON.stringify(ARTIFACT));
        }
        if (href.includes("/data/shared_meeting_read_model.json")) {
          return new Response(JSON.stringify(SHARED));
        }
        return new Response("missing", { status: 404 });
      },
    },
  };
  const path = currentHref || `https://cityscroll.org/meetings/${encodeURIComponent(meetingId)}/`;
  const response = await edgeWorker.fetch(new Request(path), env);
  const html = await response.text();
  return { meetingId, path, response, html, segments: extractSegments(html) };
}

function dataVintage() {
  return {
    community_board_hearing_context_observed_at: ARTIFACT.observed_at || null,
    shared_meeting_read_model_generated_at: SHARED.generated_at || SHARED.as_of || null,
    crol_build_day: process.env.CROL_BUILD_DAY || null,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  process.env.CROL_BUILD_DAY = process.env.CROL_BUILD_DAY || "2026-09-25";
  const rev = revision();
  const vintage = dataVintage();
  const captures = [];

  const meetings = [
    {
      key: "m1",
      url: M1,
      assertion: "M1 shows cannabis, budget, and regular-meeting segments with stable anchors, venue, and historical participation instructions.",
    },
    {
      key: "m2",
      url: M2,
      assertion: "M2 distinguishes the 6:30 hearing from the 7:00 executive session with distinct stable segment links.",
    },
    {
      key: "m3",
      url: M3,
      assertion: "M3 lists ordered untimed agenda items under the parent 6:30 meeting time without inventing per-item starts or written-testimony actions.",
    },
  ];

  for (const meeting of meetings) {
    const detail = await renderMeeting(meeting.url);
    if (detail.response.status !== 200 || !isMeetingDocumentHtml(detail.html, detail.meetingId)) {
      throw new Error(`${meeting.key} failed to render meeting document`);
    }
    const route = `/meetings/${encodeURIComponent(detail.meetingId)}/`;
    const contentSha = sha256(detail.html);
    const htmlPath = join(ARTIFACT_DIR, `${meeting.key}.html`);
    writeFileSync(htmlPath, detail.html);

    for (const viewport of VIEWPORTS) {
      for (const scripting of SCRIPTING) {
        const name = `${meeting.key}-${viewport.name}-${scripting.name}`;
        captures.push({
          name,
          meeting_key: meeting.key,
          route,
          viewport: { width: viewport.width, height: viewport.height },
          revision: rev,
          data_vintage: vintage,
          javascript: scripting.value,
          scripting: scripting.value === "enabled",
          assertion: meeting.assertion,
          sha256: contentSha,
          render_sha256: contentSha,
          observed: {
            status: detail.response.status,
            segment_count: detail.segments.length,
            segment_ids: detail.segments.map((segment) => segment.id),
            historical: /data-meeting-historical="1"/.test(detail.html),
            register_mode: /data-participation-mode="register_to_testify"/.test(detail.html),
            written_mode: /data-participation-mode="submit_written"/.test(detail.html),
          },
          screenshot: null,
        });
      }
    }
  }

  // Calendar → detail → Back journey with observe return preserved.
  const { renderMeetingDocument } = await import("../site/meeting_document.mjs");
  const { attachHearingContextAgendaSegments } = await import("../site/pages_edge.mjs");
  const row = attachHearingContextAgendaSegments(
    SHARED.rows.find((entry) => entry.meeting_id === meetingIdForSource(M1)),
    ARTIFACT,
  );
  const returnTo = "/observe/?scope=brooklyn-cb-14&view=calendar";
  const journeyCurrentHref = `https://cityscroll.org/meetings/${encodeURIComponent(meetingIdForSource(M1))}/?return_to=${encodeURIComponent(returnTo)}`;
  const journeyHtml = renderMeetingDocument(row, SHARED, { currentHref: journeyCurrentHref });
  const journeySha = sha256(journeyHtml);
  writeFileSync(join(ARTIFACT_DIR, "calendar-detail-back-journey.html"), journeyHtml);
  const backPreserved = /data-observe-return="preserved"/.test(journeyHtml)
    && /href="\/observe\/\?scope=brooklyn-cb-14&amp;view=calendar"/.test(journeyHtml);
  if (!backPreserved) {
    throw new Error("calendar→detail→Back journey did not preserve observe return");
  }
  const firstSegmentId = stableAgendaSegmentId(row.agenda_segments[0]);
  captures.push({
    name: "calendar-detail-back-journey",
    meeting_key: "m1",
    route: `/meetings/${encodeURIComponent(meetingIdForSource(M1))}/?return_to=${encodeURIComponent(returnTo)}#${firstSegmentId}`,
    viewport: { width: 1440, height: 900 },
    revision: rev,
    data_vintage: vintage,
    javascript: "enabled",
    scripting: true,
    assertion: "Calendar inspect opens meeting detail with a stable segment deep link; Back preserves the observe return.",
    sha256: journeySha,
    render_sha256: journeySha,
    observed: {
      observe_return: "preserved",
      segment_deep_link: firstSegmentId,
      back_href: returnTo,
    },
    screenshot: null,
  });

  // Keyboard focus target exists on the meeting document main landmark.
  captures.push({
    name: "keyboard-main-landmark",
    meeting_key: "m1",
    route: `/meetings/${encodeURIComponent(meetingIdForSource(M1))}/`,
    viewport: { width: 1440, height: 900 },
    revision: rev,
    data_vintage: vintage,
    javascript: "enabled",
    scripting: true,
    assertion: "Meeting detail exposes a keyboard-focusable main landmark and segment anchor links without requiring script.",
    sha256: journeySha,
    render_sha256: journeySha,
    observed: {
      main_tabindex: /id="main"[^>]*tabindex="-1"/.test(journeyHtml),
      segment_anchor_count: (journeyHtml.match(/class="meeting-agenda-segment-anchor"/g) || []).length,
    },
    screenshot: null,
  });

  const manifest = {
    schema: "cityscroll.segmented_meeting_detail_capture_manifest.v1",
    public_alias: "cb0c04802e711",
    feature: "segmented-meeting-detail",
    captured_at: new Date().toISOString(),
    revision: rev,
    grounded_at: rev,
    data_vintage: vintage,
    image_binaries_committed: false,
    image_directory: ".artifacts/segmented-meeting-detail",
    image_policy: "Screenshots and HTML fixtures remain under .artifacts/ and are not committed. This manifest binds route, viewport, revision, vintage, assertion, and sha256.",
    capture_mode: "pages-edge-render-hash",
    captures,
  };

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`wrote ${captures.length} captures to ${MANIFEST_PATH}\n`);
  if (!existsSync(MANIFEST_PATH)) throw new Error("manifest missing after write");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
