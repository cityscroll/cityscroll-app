import {
  edgeProvenanceClientScript,
  renderEdgeProvenancePanel,
} from "../graph_edge_provenance.mjs";

export const provenanceSection = Object.freeze({
  id: "provenance",
  order: 90,
  region: "after",
  render: (view) => renderEdgeProvenancePanel(view.view.claims || [], {
    activeClaimId: view.activeClaimId,
  }),
  script: () => edgeProvenanceClientScript(),
});
