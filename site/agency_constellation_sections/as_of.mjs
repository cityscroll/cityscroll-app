import { buildLedgerSummary, renderCivicTimeLedgerPanel } from "../civic_time_ledger.mjs";

export const asOfSection = Object.freeze({
  id: "as-of",
  order: 0,
  region: "before",
  render(view) {
    if (!view.showAsOf) return "";
    return renderCivicTimeLedgerPanel({
      path: view.view.path,
      asOfDay: view.effectiveAsOf,
      summary: view.effectiveAsOf ? buildLedgerSummary(view.view, view.displayView) : null,
    });
  },
});
