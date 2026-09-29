import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { materializeConsultations } from "../site/consultation_acquisition.mjs";
import { buildFirstClassFreshnessReport, productionFreshnessFindings } from "../tools/first_class_refresh.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOW_PATH = join(ROOT, ".github/workflows/consultations-refresh.yml");
const REGISTRY_PATH = join(ROOT, "site/data/source_contracts.json");
const ARTIFACT_PATH = "site/data/consultations.json";

// The vintage that aged out and blocked every Pages deploy from 2026-09-29,
// and the instant a deploy actually refused to publish it (run 36611318361:
// "site/data/consultations.json: stale first-class artifact").
const EXPIRED_VINTAGE = "2026-09-22T17:22:12.050Z";
const DEPLOY_REFUSAL_INSTANT = "2026-09-29T19:39:35Z";

function consultationsRegistryEntry(registry) {
  const entry = (registry?.first_class_artifacts || []).find((artifact) => artifact.id === "public-consultations");
  assert.ok(entry, "the freshness registry declares the public-consultations artifact");
  return entry;
}

/**
 * Worst-case hours between scheduled runs of a cron entry. The supported
 * grammar is deliberately narrow — daily hour lists, hour steps, and a single
 * weekday — and anything else throws, so a future schedule edit cannot quietly
 * fall outside the shapes this guarantee was written for.
 */
function scheduledIntervalHours(cron) {
  const fields = String(cron).trim().split(/\s+/);
  assert.equal(fields.length, 5, `cron entry must have five fields: ${cron}`);
  const [minute, hour, dom, month, dow] = fields;
  assert.match(minute, /^(\d+|\*\/\d+)$/, `minute must be fixed or stepped: ${cron}`);
  assert.equal(dom, "*", `day of month must be unrestricted: ${cron}`);
  assert.equal(month, "*", `month must be unrestricted: ${cron}`);
  if (dow !== "*") {
    assert.match(dow, /^\d$/, `day of week must be a single weekday: ${cron}`);
    return 168;
  }
  if (/^\*\/(\d+)$/.test(hour)) return Number(hour.slice(2));
  assert.match(hour, /^\d+(,\d+)*$/, `hour must be fixed, a list, or stepped: ${cron}`);
  const hours = hour.split(",").map(Number).sort((left, right) => left - right);
  const gaps = hours.map((value, index) => (
    index === hours.length - 1 ? 24 - value + hours[0] : hours[index + 1] - value
  ));
  return Math.max(...gaps);
}

/** The schedule crons of a workflow file, as written under `on: schedule:`. */
function workflowScheduleCrons(source) {
  const scheduleStart = source.indexOf("on:");
  const jobsStart = source.indexOf("jobs:");
  assert.ok(scheduleStart >= 0 && jobsStart > scheduleStart, "workflow has an on: block before jobs:");
  const triggerBlock = source.slice(scheduleStart, jobsStart);
  return [...triggerBlock.matchAll(/- cron:\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

test("B1 the scheduled refresh cadence stays inside half the consultations hard maximum age", () => {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const entry = consultationsRegistryEntry(registry);
  const maximumHours = Number(entry.hard_maximum_age_hours);
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  const crons = workflowScheduleCrons(workflow);
  assert.ok(crons.length >= 1, "the refresh workflow declares a schedule");
  for (const cron of crons) {
    const intervalHours = scheduledIntervalHours(cron);
    assert.ok(
      intervalHours < maximumHours / 2,
      `schedule "${cron}" fires every ${intervalHours}h, which is not comfortably inside the ${maximumHours}h hard maximum`,
    );
  }
});

test("B2 the workflow acquires on main, publishes only the materialization, and reuses the automation token", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  assert.match(workflow, /workflow_dispatch:/, "the refresh can be run manually");
  assert.match(workflow, /ref: main/, "scheduled acquisition runs against the default branch");
  assert.match(workflow, /persist-credentials: false/, "the checkout keeps no push credentials");
  assert.doesNotMatch(workflow, /continue-on-error/, "a failed acquisition must fail the run, not continue past it");
  assert.match(workflow, /run: node tools\/refresh_consultations\.mjs/, "the owning refresh command performs the acquisition");
  assert.match(workflow, /site\/data\/consultations\.json\)\s*;;/, "the guard admits only the consultations materialization");
  assert.match(workflow, /add-paths:\s*\|\s*\n\s*site\/data\/consultations\.json/, "the pull request stages only the consultations materialization");
  assert.match(workflow, /branch: automation\/consultations-refresh/, "every run targets one automation branch so repeats update one pull request");
  assert.match(workflow, /if: steps\.generated\.outputs\.changed == 'true'/, "a run with no change opens no pull request");
  assert.match(workflow, /echo "The consultations materialization is already current\."/, "an unchanged run is a clean, published outcome");
  const secrets = [...workflow.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(secrets)], ["REFRESH_PR_TOKEN"], "the refresh uses only the existing automation token secret");
});

test("B3 a changed run arms exactly one pull request through the required checks and the merge queue", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  const pullRequestSteps = [...workflow.matchAll(/gh workflow run ci\.yml --ref automation\/consultations-refresh/g)];
  assert.equal(pullRequestSteps.length, 1, "required checks are triggered once for the automation branch");
  assert.match(workflow, /if: steps\.refresh-pr\.outputs\.pull-request-number != ''/, "check triggering waits for a created pull request");
  assert.match(workflow, /gh pr merge "\$REFRESH_PR" --auto --match-head-commit "\$REFRESH_HEAD"/, "the pull request is queued for auto-merge at its exact head");
  assert.match(workflow, /concurrency:\s*\n\s*group: consultations-refresh\s*\n\s*cancel-in-progress: false/, "overlapping runs wait instead of cancelling mid-acquisition");
});

test("B4 the production freshness gate refuses the expired 2026-09-22 vintage and accepts a refreshed one", () => {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const entry = consultationsRegistryEntry(registry);
  const root = mkdtempSync(join(tmpdir(), "consultations-freshness-"));
  try {
    mkdirSync(join(root, "site/data"), { recursive: true });

    // The artifact exactly as it stood when deploys began failing.
    writeFileSync(
      join(root, ARTIFACT_PATH),
      `${JSON.stringify(materializeConsultations({ asOf: EXPIRED_VINTAGE }), null, 2)}\n`,
    );
    const expired = buildFirstClassFreshnessReport(registry, { root, now: DEPLOY_REFUSAL_INSTANT });
    const expiredSurface = expired.surfaces.find((surface) => surface.public_artifact_path === ARTIFACT_PATH);
    assert.equal(expiredSurface.freshness_state, "stale");
    assert.equal(expiredSurface.age_hours > Number(entry.hard_maximum_age_hours), true);
    const expiredFindings = productionFreshnessFindings(expired).filter((finding) => finding.startsWith(`${ARTIFACT_PATH}:`));
    assert.deepEqual(expiredFindings, [`${ARTIFACT_PATH}: stale first-class artifact (vintage ${EXPIRED_VINTAGE})`]);

    // The same observation cycle re-run at the deploy-refusal instant passes it.
    writeFileSync(
      join(root, ARTIFACT_PATH),
      `${JSON.stringify(materializeConsultations({ asOf: DEPLOY_REFUSAL_INSTANT }), null, 2)}\n`,
    );
    const refreshed = buildFirstClassFreshnessReport(registry, { root, now: DEPLOY_REFUSAL_INSTANT });
    const refreshedSurface = refreshed.surfaces.find((surface) => surface.public_artifact_path === ARTIFACT_PATH);
    assert.equal(refreshedSurface.freshness_state, "fresh");
    assert.equal(refreshedSurface.population_count, 4);
    assert.deepEqual(
      productionFreshnessFindings(refreshed).filter((finding) => finding.startsWith(`${ARTIFACT_PATH}:`)),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
