import { recordSourceAcquisitionReceipt } from "./source_acquisition_receipt.mjs";

export async function withWorkerAcquisitionReceipt(env, sourceContractId, runId, work, { signal } = {}) {
  try {
    const result = await work();
    signal?.throwIfAborted();
    const status = result?.status === "failed" || result?.status === "error" || result?.ok === false
      ? "failed"
      : result?.status === "partial" ? "partial"
      : result?.status === "skipped" ? "held"
      : "succeeded";
    await recordSourceAcquisitionReceipt(env, {
      source_contract_id: sourceContractId,
      observed_at: new Date().toISOString(),
      status,
      run_id: runId,
      publisher_clock_basis: status === "succeeded" && result?.publisher_updated_at ? "publisher_response" : null,
      publisher_updated_at: status === "succeeded" ? result?.publisher_updated_at || null : null,
      adapter: "worker-scheduled-refresh",
      ...(result?.reason ? { reason: result.reason } : {}),
      ...(Number.isFinite(result?.requested) ? {
        requested: result.requested,
        computed: result.computed,
        skipped: result.skipped,
        failed: result.failed,
      } : {}),
    });
    return result;
  } catch (error) {
    try {
      await recordSourceAcquisitionReceipt(env, {
        source_contract_id: sourceContractId,
        observed_at: new Date().toISOString(),
        status: "failed",
        run_id: runId,
        publisher_clock_basis: null,
        publisher_updated_at: null,
        adapter: "worker-scheduled-refresh",
        exact_error: String(error?.message || error),
      });
    } catch {}
    throw error;
  }
}

export function startMorningZapOutcomes(ctx, env, runId, refreshZapOutcomes, logger = console) {
  const task = (async () => {
    try {
      const result = await withWorkerAcquisitionReceipt(env, "zap-api-outcomes", runId, () => refreshZapOutcomes(env));
      logger.log("zap outcomes prewarm:", JSON.stringify(result));
    } catch (error) {
      logger.error("zap outcomes prewarm failed:", String(error?.message || error));
    }
  })();
  ctx.waitUntil(task);
  return task;
}
