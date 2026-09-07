#!/usr/bin/env node
/**
 * Build the community-board decision artifacts from their reviewed input.
 *
 * Two artifacts come out of one projection so they can never disagree:
 *
 *   site/data/community_board_resolution_pilot.json
 *     the resident read model, published decisions only
 *   worker/src/data/community_board_resolution_review_queue.json
 *     the held candidates, read only behind the operator key
 *
 * The held candidates never reach `site/`. A candidate is held because the
 * source did not settle what the board decided -- a document that states no
 * meeting date, a passage that was not read to the same standard, an address
 * the board's own agenda and resolution spell differently. Publishing those
 * beside decisions that were settled is exactly the confusion this pilot
 * exists to avoid, so the boundary is a separate file rather than a filter.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCommunityBoardResolutionPilot,
  communityBoardResolutionReviewQueue,
  publicCommunityBoardResolutionPilot,
} from "../site/community_board_resolution_pilot.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW = join(ROOT, "site/data/community_board_resolution_sources/board_resolution_pilot_review.v1.json");
const PUBLIC_OUT = join(ROOT, "site/data/community_board_resolution_pilot.json");
const QUEUE_OUT = join(ROOT, "worker/src/data/community_board_resolution_review_queue.json");

export function buildCommunityBoardResolutionArtifacts(reviewPath = REVIEW) {
  const review = JSON.parse(readFileSync(reviewPath, "utf8"));
  const pilot = buildCommunityBoardResolutionPilot(review);
  return {
    pilot,
    artifacts: [
      [PUBLIC_OUT, `${JSON.stringify(publicCommunityBoardResolutionPilot(pilot), null, 2)}\n`],
      [QUEUE_OUT, `${JSON.stringify(communityBoardResolutionReviewQueue(pilot), null, 2)}\n`],
    ],
  };
}

function main() {
  const check = process.argv.includes("--check");
  const { pilot, artifacts } = buildCommunityBoardResolutionArtifacts();
  let stale = 0;
  for (const [path, content] of artifacts) {
    if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
    stale += 1;
    if (check) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  if (check && stale) {
    throw new Error(`${stale} community board decision artifact(s) are stale; rebuild with node tools/build_community_board_resolution_pilot.mjs`);
  }
  const { decisions_published: published, candidates_held: held, documents } = pilot.coverage;
  console.log(check
    ? `Community board decision artifacts are current (${published} published, ${held} held, ${documents} documents)`
    : `Community board decision artifacts built (${published} published, ${held} held, ${documents} documents)`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
