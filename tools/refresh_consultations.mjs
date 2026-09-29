import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireConsultationSources } from "../site/consultation_acquisition.mjs";

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function consultationRefreshDisabled({ root = defaultRoot, env = process.env } = {}) {
  const value = String(env.CITYSCROLL_CONSULTATIONS_REFRESH || "").toLowerCase();
  return ["off", "0", "false", "disabled"].includes(value) || existsSync(join(root, ".consultations-refresh.off"));
}

export async function runConsultationRefresh({ root = defaultRoot, asOf = new Date().toISOString(), fetchImpl = globalThis.fetch, env = process.env, transportOptions = {} } = {}) {
  const output = join(root, "site/data/consultations.json");
  const previous = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : null;
  if (consultationRefreshDisabled({ root, env })) {
    return { status: "skipped", reason: "kill_switch", materialization: previous, observations: [], receipt: { schema: "cityscroll.consultation_source_observation.v1", observed_at: asOf, failures: 0, last_good_preserved: true, kill_switch: true } };
  }
  const result = await acquireConsultationSources({ fetchImpl, asOf, previous, transportOptions });
  if (result.materialization) writeFileSync(output, `${JSON.stringify(result.materialization, null, 2)}\n`);
  return { status: result.receipt.failures ? "degraded" : "succeeded", ...result };
}

/**
 * A degraded acquisition — any publisher source that did not verify — fails the
 * scheduled producer even when the last verified materialization was preserved.
 * Exiting zero there let the dataset age out behind green runs while production
 * kept refusing to publish it, so degradation is a visible failure for every
 * caller: the dedicated scheduled refresh, the bundled first-class refresh, and
 * a hand-run refresh alike. The kill switch stays a clean, intentional skip.
 */
export function consultationRefreshExitCode(result) {
  return result?.status === "degraded" ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runConsultationRefresh().then((result) => {
    process.stdout.write(`${JSON.stringify({ status: result.status, failures: result.receipt.failures, last_good_preserved: result.receipt.last_good_preserved })}\n`);
    process.exitCode = consultationRefreshExitCode(result);
  }).catch((error) => {
    process.stderr.write(`consultation refresh failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
