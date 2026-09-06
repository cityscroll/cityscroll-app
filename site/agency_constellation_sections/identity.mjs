import { renderAgencyIdentitySection } from "../agency_identity_evidence.mjs";

export const identitySection = Object.freeze({
  id: "identity",
  order: 5,
  render: (view) => renderAgencyIdentitySection(view.view),
  styleOrder: 5,
  // A role row's evidence line is one long unbreakable source receipt
  // (`source_record:checkbook_contracts:contract:...:prime-vendor:2026-07-07`).
  // With no break opportunity in it the row set the document's width, so the
  // whole profile scrolled sideways on a narrow screen. Let those tokens wrap
  // and keep every row inside the column.
  style: `.agency-role-edge-record,.agency-source-identity-record{overflow-wrap:anywhere;min-width:0}
.agency-role-edge-record .node-record-main,.agency-role-edge-record .node-muted,
.agency-source-identity-record .node-record-main,.agency-source-identity-record .node-muted{overflow-wrap:anywhere;min-width:0}`,
});

