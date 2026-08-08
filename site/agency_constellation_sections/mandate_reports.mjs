import {
  MANDATE_REPORTS_RECEIPT_STYLE,
  renderMandateReportsReceiptSection,
} from "../mandate_reports_receipt.mjs";

export const mandateReportsSection = Object.freeze({
  id: "mandate-reports",
  order: 20,
  styleOrder: 20,
  style: MANDATE_REPORTS_RECEIPT_STYLE,
  render: (view) => renderMandateReportsReceiptSection(
    view.displayView.mandates_reports || view.view.mandates_reports || null,
  ),
});
