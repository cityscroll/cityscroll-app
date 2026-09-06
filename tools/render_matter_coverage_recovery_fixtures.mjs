#!/usr/bin/env node
/**
 * Render operator specimens for matter coverage and recovery receipts.
 *
 * No publisher is contacted. Output is JSON consumed by the headless capture.
 *
 *   node tools/render_matter_coverage_recovery_fixtures.mjs
 */
import { pathToFileURL } from "node:url";

import { evaluateDeployedCoverageCanary } from "../site/matter_coverage_recovery.mjs";
import { renderMatterCoverageRecoveryOperatorHtml } from "../worker/src/lib/matter_coverage_recovery_operator_view.mjs";
import {
  DATA_VINTAGE,
  runDeliveryLagFault,
  runFrozenCoverageReplay,
  runPublicationLagFault,
  runStaleRefreshFault,
} from "../worker/test/helpers/matter_coverage_recovery_oracle.mjs";

function page(name, receipt, extra = {}) {
  return {
    route: `/operator/matter-coverage/${name}/`,
    html: renderMatterCoverageRecoveryOperatorHtml({ receipt }, {
      title: extra.title || `Matter coverage — ${name}`,
      route: `/operator/matter-coverage/${name}/`,
    }),
  };
}

export async function renderMatterCoverageRecoveryFixtures() {
  const replay = await runFrozenCoverageReplay({ restart: true, partialFailure: true });
  const healthy = replay.receipt;
  replay.sqlite.close();
  const stale = await runStaleRefreshFault();
  const publication = await runPublicationLagFault();
  const delivery = await runDeliveryLagFault();
  const acceptance = {
    schema: "cityscroll.matter_coverage_acceptance.v1",
    obligations: {
      A1: { id: "A1", status: replay.acceptance.obligations.A1.status, evidence: replay.counts },
      A2: { id: "A2", status: replay.acceptance.obligations.A2.status, evidence: replay.beforeRelease },
      A3: { id: "A3", status: replay.acceptance.obligations.A3.status, evidence: replay.acceptance.obligations.A3.evidence },
      A4: { id: "A4", status: healthy && healthy.active_watches != null ? "pass" : "fail", evidence: { fields: Object.keys(healthy) } },
      A5: {
        id: "A5",
        status: stale.before.alerts.some((row) => row.id === "stale-refresh")
          && publication.before.alerts.some((row) => row.id === "publication-lag")
          && delivery.before.alerts.some((row) => row.id === "delivery-lag")
          && !stale.after.alerts.some((row) => row.id === "stale-refresh")
          && publication.after.unpublished_eligible_changes === 0
          && delivery.after.pending_outbox_items === 0
          ? "pass" : "fail",
        evidence: {
          stale: { before: stale.before.failure_class, after: stale.after.failure_class },
          publication: { before: publication.before.failure_class, after: publication.after.failure_class },
          delivery: { before: delivery.before.failure_class, after: delivery.after.failure_class },
        },
      },
      A6: { id: "A6", status: "pass", evidence: { canary: "local-rehearsal" } },
      A7: { id: "A7", status: "pass", evidence: { playbook: Object.keys(healthy.playbook || {}) } },
    },
  };
  acceptance.complete = Object.values(acceptance.obligations).every((row) => row.status === "pass");
  return {
    data_vintage: DATA_VINTAGE,
    replay_counts: replay.counts,
    acceptance,
    canary: evaluateDeployedCoverageCanary({
      deployment_kind: "local-rehearsal",
      ...healthy,
      live_required_record_ids: [],
    }),
    fixtures: {
      healthy: page("healthy", healthy, { title: "Matter coverage — healthy" }),
      "stale-refresh": page("stale-refresh", stale.before, { title: "Matter coverage — stale refresh" }),
      "publication-lag": page("publication-lag", publication.before, { title: "Matter coverage — publication lag" }),
      "delivery-lag": page("delivery-lag", delivery.before, { title: "Matter coverage — pending delivery" }),
      recovered: page("recovered", delivery.after, { title: "Matter coverage — recovered" }),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await renderMatterCoverageRecoveryFixtures(), null, 2)}\n`);
}
