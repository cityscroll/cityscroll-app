import { renderAgencyIdentitySection } from "../agency_identity_evidence.mjs";

export const identitySection = Object.freeze({
  id: "identity",
  order: 5,
  render: (view) => renderAgencyIdentitySection(view.view),
});

