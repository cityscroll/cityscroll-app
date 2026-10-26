import { recordSourceAcquisitionReceipt } from "./source_acquisition_receipt.mjs";

export async function withWorkerAcquisitionReceipt(env, sourceContractId, runId, work, { signal, logger = console } = {}) {
  const logReceiptFailure = (phase, error) => {
    try {
      logger.error(`source acquisition ${phase} receipt failed:`, JSON.stringify({
        source_contract_id: sourceContractId,
        run_id: runId,
        error: String(error?.message || error),
      }));
    } catch {}
  };
  try {
    const result = await work(signal);
    signal?.throwIfAborted?.();
    const status = result?.status === "failed" || result?.status === "error" || result?.ok === false
      ? "failed"
      : result?.status === "partial" ? "partial"
      : result?.status === "skipped" ? "held"
      : "succeeded";
    const receipt = {
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
    };
    try {
      await recordSourceAcquisitionReceipt(env, receipt);
    } catch (receiptError) {
      // The source work may already have published a last-good snapshot. Do not
      // relabel that work as failed solely because its observability write failed;
      // report the lost receipt loudly so the invocation is diagnosable.
      logReceiptFailure("success", receiptError);
    }
    return result;
  } catch (error) {
    try {
      const receipt = {
        source_contract_id: sourceContractId,
        observed_at: new Date().toISOString(),
        status: "failed",
        run_id: runId,
        publisher_clock_basis: null,
        publisher_updated_at: null,
        adapter: "worker-scheduled-refresh",
        exact_error: String(error?.message || error),
      };
      await recordSourceAcquisitionReceipt(env, receipt);
    } catch (receiptError) {
      logReceiptFailure("failure", receiptError);
    }
    throw error;
  }
}

export function startMorningZapOutcomes(ctx, env, runId, refreshZapOutcomes, logger = console, refreshLookup = null, refreshOptions = {}) {
  const { stepRunner = null, ...outcomeOptions } = refreshOptions || {};
  const runStep = stepRunner || (async (_label, work) => {
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      return { ok: false, error };
    }
  });
  const task = (async () => {
    let lookupDoc = null;
    if (refreshLookup) {
      const lookup = await runStep("zap projects lookup", (signal) => refreshLookup({
        onDocument: (doc) => { lookupDoc = doc; },
        signal,
      }));
      if (!lookup?.ok) {
        const error = lookup?.error || new Error("scheduled step failed");
        logger.error("land zap lookup refresh failed:", String(error?.message || error));
      }
    }
    const outcomes = await runStep("zap outcomes", (signal) => withWorkerAcquisitionReceipt(env, "zap-api-outcomes", runId, () => refreshZapOutcomes(env, {
        ...outcomeOptions,
        ...(lookupDoc ? { lookupDoc } : {}),
        force: true,
        signal,
      }), { signal }));
    if (outcomes?.ok) {
      const result = outcomes.value;
      logger.log("zap outcomes prewarm:", JSON.stringify(result));
    } else {
      const error = outcomes?.error || new Error("scheduled step failed");
      logger.error("zap outcomes prewarm failed:", String(error?.message || error));
    }
  })();
  ctx.waitUntil(task);
  return task;
}
