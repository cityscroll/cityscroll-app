import materialization from "../data/subsidy_project_lookup.json" with { type: "json" };

export function subsidyProjectMaterializationReady(doc = materialization) {
  const receipt = doc?.receipt || {};
  if (receipt.bridge_status !== "accepted") return false;
  if (!Number.isFinite(Number(receipt.join_rate)) || !Number.isFinite(Number(receipt.threshold))) return false;
  if (Number(receipt.join_rate) < Number(receipt.threshold)) return false;
  if (receipt.false_positives !== 0 || receipt.unreviewed_candidates !== 0) return false;
  return !!doc?.by_notice && Number(doc.row_count) > 0;
}

export function lookupSubsidyProjects(requestId, doc = materialization) {
  if (!subsidyProjectMaterializationReady(doc)) return [];
  const rows = doc.by_notice?.[String(requestId || "")] || [];
  return rows.filter((row) =>
    row?.receipt_backed === true
    && Number(row.join_confidence) >= 1
    && row.project_name
    && row.company
    && /^https:\/\/edc\.nyc\//.test(String(row.official_documents_url || ""))
  );
}

export function subsidyProjectReceipt(doc = materialization) {
  return subsidyProjectMaterializationReady(doc) ? { ...doc.receipt } : null;
}
