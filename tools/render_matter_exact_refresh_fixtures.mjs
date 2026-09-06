#!/usr/bin/env node
/**
 * Render operator specimens for exact-matter refresh receipts.
 *
 * No publisher is contacted. Output is JSON consumed by the headless capture.
 *
 *   node tools/render_matter_exact_refresh_fixtures.mjs
 */
import { pathToFileURL } from "node:url";

import {
  projectMatterRefreshOperatorView,
  refreshExactMatterRoster,
  ROSTER_KIND,
  upsertRosterEntry,
} from "../worker/src/lib/matter_exact_refresh.mjs";
import { renderMatterExactRefreshOperatorHtml } from "../worker/src/lib/matter_exact_refresh_operator_view.mjs";
import { retainSnapshotMatterObservations } from "../worker/src/lib/matter_observation_journal.mjs";
import { matterJournalDatabase } from "../worker/test/helpers/matter_observation_d1.mjs";
import {
  BASELINE,
  createPublisherFetch,
  defaultCatalog,
  earlyOnlySnapshot,
  retentionEnv,
  START,
} from "../worker/test/helpers/matter_exact_refresh_oracle.mjs";

async function seed(env) {
  await retainSnapshotMatterObservations(env, earlyOnlySnapshot(), { acquiredAt: START.toISOString() });
  for (const row of BASELINE) {
    await upsertRosterEntry(env, { matterId: row.matter_id, kind: ROSTER_KIND.explicitRetained, now: START });
  }
}

async function completeRun() {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await seed(env);
  const { fetchImpl } = createPublisherFetch(defaultCatalog());
  await refreshExactMatterRoster(env, { now: START, fetchImpl, maxMatters: 10, maxRequests: 80 });
  const view = await projectMatterRefreshOperatorView(env);
  sqlite.close();
  return renderMatterExactRefreshOperatorHtml(view, {
    title: "Exact matter refresh — complete run",
    route: "/operator/matter-refresh/complete/",
  });
}

async function retryRecovery() {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await seed(env);
  const { fetchImpl: fail } = createPublisherFetch(defaultCatalog(), { status: 429, retryAfter: 30 });
  await refreshExactMatterRoster(env, { now: START, fetchImpl: fail, maxMatters: 10, maxRequests: 80 });
  const recoveredAt = new Date(START.getTime() + 24 * 60 * 60 * 1000);
  const { fetchImpl } = createPublisherFetch(defaultCatalog());
  await refreshExactMatterRoster(env, { now: recoveredAt, fetchImpl, maxMatters: 10, maxRequests: 80 });
  const view = await projectMatterRefreshOperatorView(env);
  sqlite.close();
  return renderMatterExactRefreshOperatorHtml(view, {
    title: "Exact matter refresh — retry recovery",
    route: "/operator/matter-refresh/retry/",
    retryHref: "#receipt",
  });
}

export async function renderMatterExactRefreshFixtures() {
  return {
    data_vintage: START.toISOString(),
    fixtures: {
      complete: {
        route: "/operator/matter-refresh/complete/",
        html: await completeRun(),
      },
      "retry-recovery": {
        route: "/operator/matter-refresh/retry/",
        html: await retryRecovery(),
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await renderMatterExactRefreshFixtures(), null, 2)}\n`);
}
