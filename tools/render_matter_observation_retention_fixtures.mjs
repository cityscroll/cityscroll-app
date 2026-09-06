#!/usr/bin/env node
/**
 * Render operator journal specimens from retained snapshot and native fixtures.
 *
 * No publisher is contacted. Output is JSON consumed by the headless capture.
 *
 *   node tools/render_matter_observation_retention_fixtures.mjs
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  projectMatterJournal,
  retainNativeMatterObservations,
  retainSnapshotMatterObservations,
} from "../worker/src/lib/matter_observation_journal.mjs";
import { renderMatterObservationOperatorHtml } from "../worker/src/lib/matter_observation_operator_view.mjs";
import { matterJournalDatabase } from "../worker/test/helpers/matter_observation_d1.mjs";

const snapshot = JSON.parse(
  readFileSync(new URL("../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"),
);

async function lastGoodAfterFailure() {
  const { sqlite, DB } = matterJournalDatabase();
  const env = { DB };
  await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: snapshot.generated_at });
  await retainSnapshotMatterObservations(env, { by_notice: {} }, { acquiredAt: "2026-08-11T00:00:00.000Z" });
  const view = await projectMatterJournal(env);
  sqlite.close();
  return renderMatterObservationOperatorHtml(view, {
    title: "Matter observation journal — last-good after a failed refresh",
    route: "/operator/matter-observations/last-good/",
    matterId: "79200",
  });
}

async function nativeUpgrade() {
  const { sqlite, DB } = matterJournalDatabase();
  const env = { DB };
  await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: snapshot.generated_at });
  await retainNativeMatterObservations(env, {
    events: [{ EventId: 22509, EventDate: "2026-07-22" }],
    eventItems: [{
      EventItemId: 551001,
      EventItemEventId: 22509,
      EventItemMatterId: 79200,
      EventItemMatterName: "Landmarks, Queens CD 2 Walk to Park Site Selection/Acquisition, Queens (C 260089 PCQ).",
      EventItemActionName: "Laid Over by Subcommittee",
    }],
    votes: [],
  }, { acquiredAt: "2026-08-11T00:00:00.000Z" });
  const view = await projectMatterJournal(env);
  sqlite.close();
  return renderMatterObservationOperatorHtml(view, {
    title: "Matter observation journal — native upgrade",
    route: "/operator/matter-observations/native-upgrade/",
    matterId: "79200",
  });
}

async function correction() {
  const { sqlite, DB } = matterJournalDatabase();
  const env = { DB };
  const item = (action) => ({
    events: [{ EventId: 22342, EventDate: "2026-04-22" }],
    eventItems: [{
      EventItemId: 410010,
      EventItemEventId: 22342,
      EventItemMatterId: 78605,
      EventItemActionName: action,
      EventItemMatterName: "A land use item",
    }],
    votes: [],
  });
  await retainNativeMatterObservations(env, item("Laid Over by Subcommittee"), { acquiredAt: "2026-05-01T00:00:00.000Z" });
  await retainNativeMatterObservations(env, item("Approved by Subcommittee"), { acquiredAt: "2026-05-20T00:00:00.000Z" });
  const view = await projectMatterJournal(env);
  sqlite.close();
  return renderMatterObservationOperatorHtml(view, {
    title: "Matter observation journal — correction on one event",
    route: "/operator/matter-observations/correction/",
    matterId: "78605",
  });
}

export async function renderMatterObservationFixtures() {
  const fixtures = {
    "last-good-after-failed-refresh": {
      route: "/operator/matter-observations/last-good/",
      html: await lastGoodAfterFailure(),
    },
    "native-upgrade": {
      route: "/operator/matter-observations/native-upgrade/",
      html: await nativeUpgrade(),
    },
    correction: {
      route: "/operator/matter-observations/correction/",
      html: await correction(),
    },
  };
  return { data_vintage: snapshot.generated_at, fixtures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await renderMatterObservationFixtures(), null, 2)}\n`);
}
