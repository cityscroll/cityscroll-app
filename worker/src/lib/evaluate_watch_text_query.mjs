/**
 * Dispatch an admitted v1 expression to the lens's owned evaluator.
 * Unsupported lenses stay unavailable rather than running unfiltered.
 */

import { TEXT_QUERY_EVAL_STATUS } from "../../../site/watch_text_query_eval.mjs";
import { textQueryEvaluationSupported } from "../../../site/watch_text_query.mjs";
import { evaluateMoneyTextQueryWatch } from "./watch_text_query_procurement.mjs";
import { evaluateMeetingTextQueryWatch } from "./watch_text_query_meetings.mjs";

export async function evaluateAdmittedTextQueryWatch(opts = {}) {
  const lens = opts.sub?.lens;
  if (!textQueryEvaluationSupported(lens)) {
    return {
      status: TEXT_QUERY_EVAL_STATUS.unavailable,
      reason: "unsupported_lens",
      rows: [],
      scanned: 0,
      continuation: null,
      markSeenIds: [],
      excludedRows: [],
      clock: opts.clock || null,
    };
  }
  if (lens === "meetings") return evaluateMeetingTextQueryWatch(opts);
  if (lens === "money") return evaluateMoneyTextQueryWatch(opts);
  return {
    status: TEXT_QUERY_EVAL_STATUS.unavailable,
    reason: "unsupported_lens",
    rows: [],
    scanned: 0,
    continuation: null,
    markSeenIds: [],
    excludedRows: [],
    clock: opts.clock || null,
  };
}

export { TEXT_QUERY_EVAL_STATUS };
