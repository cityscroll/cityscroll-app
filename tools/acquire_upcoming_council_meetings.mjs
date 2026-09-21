#!/usr/bin/env node

/**
 * Acquire the announced Council calendar from the authenticated Legistar
 * Events API and retain the acquisition receipt needed by the owning builder.
 *
 * The staged projection is ignored build input. The receipt is retained beside
 * the other Legistar source receipts; a failed request writes neither file, so
 * the refresh runner can keep the last-known-good public artifact intact.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ACQUISITION_RECEIPT_PATH,
  ACQUISITION_STAGE_PATH,
  acquireLiveUpcomingCouncilMeetingsSnapshot,
  readLegistarToken,
  validateUpcomingAcquisitionReceipt,
} from "./build_upcoming_council_meetings_snapshot.mjs";

export function writeUpcomingCouncilAcquisition({
  acquired,
  stagePath = ACQUISITION_STAGE_PATH,
  receiptPath = ACQUISITION_RECEIPT_PATH,
} = {}) {
  if (!acquired?.ok || !acquired.view || !acquired.receipt) {
    throw new Error(`upcoming Council acquisition failed (${acquired?.reason || "unknown"})`);
  }
  const receipt = validateUpcomingAcquisitionReceipt(acquired.receipt);
  mkdirSync(dirname(stagePath), { recursive: true });
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(stagePath, `${JSON.stringify({
    schema: "cityscroll.upcoming_council_meetings_acquisition_stage.v1",
    receipt,
    view: acquired.view,
  }, null, 2)}\n`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { stagePath, receiptPath, receipt };
}

export async function acquireAndWriteUpcomingCouncilMeetings({
  token = readLegistarToken(),
  fetchImpl = fetch,
  now = new Date(),
  stagePath = ACQUISITION_STAGE_PATH,
  receiptPath = ACQUISITION_RECEIPT_PATH,
} = {}) {
  const acquired = await acquireLiveUpcomingCouncilMeetingsSnapshot({ token, fetchImpl, now });
  if (!acquired.ok) return acquired;
  return {
    ...acquired,
    written: writeUpcomingCouncilAcquisition({ acquired, stagePath, receiptPath }),
  };
}

async function main() {
  const acquired = await acquireAndWriteUpcomingCouncilMeetings();
  if (!acquired.ok) {
    const retained = existsSync(ACQUISITION_RECEIPT_PATH);
    console.error(
      retained
        ? `upcoming Council acquisition failed (${acquired.reason || "unknown"}); retaining last-known-good artifact`
        : `upcoming Council acquisition failed (${acquired.reason || "unknown"}); no retained artifact was changed`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    wrote: "site/data/legistar_sources/verification_receipts/upcoming_council_meetings_latest.json",
    fetched_at: acquired.receipt.fetched_at,
    row_count: acquired.receipt.row_count,
    content_hash: acquired.receipt.content_hash,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
