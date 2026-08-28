import { renderAgencyFiscalContextSection } from "../agency_fiscal_context.mjs";

export const fiscalContextSection = Object.freeze({
  id: "fiscal-context",
  order: 39,
  render(view) {
    return renderAgencyFiscalContextSection(view.displayView.fiscal_context);
  },
});
