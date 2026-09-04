// Records a resident-snapshot refresh result inside the existing
// generation-output receipt (cityscroll.generation-output-receipt.v1),
// rather than a parallel receipt file. Pure so the shape is directly testable
// without spawning the production build.

export function mergeResidentSnapshotRefreshEvidence(generationReceipt, evidenceBySnapshot) {
  return {
    ...generationReceipt,
    resident_snapshot_refresh: { ...evidenceBySnapshot },
  };
}
