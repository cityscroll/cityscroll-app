import { dispositionJoinKeys } from "./property_disposition_spine.mjs";
import { classifyDispositionStage, DISPOSITION_STAGES } from "../../../site/property_disposition_stage.mjs";
import { propertyRowMatchesSavedSearch } from "../../../site/property_saved_search.mjs";

const ALL_STAGES = ["unstaged", ...DISPOSITION_STAGES];
const STAGE_ORDER = new Map(ALL_STAGES.map((stage, index) => [stage, index]));

export function propertyWatchStageLabel(stage, { transition = false } = {}) {
  const label = { unstaged: "unclassified", hearing: "hearing", auction_or_rfp: "auction / RFP", award_or_conveyance: "award / conveyance" }[stage] || String(stage || "").replace(/_/g, " ");
  return transition ? `moved to ${label}` : label;
}

function identityFor(row) {
  const keys = dispositionJoinKeys(row);
  return keys.find((key) => key.startsWith("bbl:")) || keys.find((key) => key.startsWith("taxlot:")) || `notice:${row?.request_id || "unknown"}`;
}
const semanticKey = (identity, kind, stage) => `property-stage:${encodeURIComponent(identity)}:${kind}:${stage}`;
const seenStage = (seen, identity, kind) => ALL_STAGES.find((stage) => seen.has(semanticKey(identity, kind, stage))) || null;
const latestSeenStage = (seen, identity) => ALL_STAGES.filter((stage) => seen.has(semanticKey(identity, "current", stage))).sort((a, b) => STAGE_ORDER.get(b) - STAGE_ORDER.get(a))[0] || null;

export function evaluatePropertyWatch(rows = [], filter = {}, seenInput = new Set(), today) {
  const seen = new Set(seenInput || []);
  const output = [];
  const markSeenIds = [];
  const ordered = [...rows].sort((a, b) => String(a?.start_date || "").localeCompare(String(b?.start_date || "")));
  for (const row of ordered) {
    if (!row?.request_id) continue;
    const identity = identityFor(row);
    const stage = row.disposition_stage || classifyDispositionStage(row) || "unstaged";
    let matchedAt = seenStage(seen, identity, "matched");
    let current = latestSeenStage(seen, identity);
    const directMatch = propertyRowMatchesSavedSearch({ ...row, disposition_stage: stage === "unstaged" ? null : stage }, filter, today);
    const advances = matchedAt && STAGE_ORDER.get(stage) > STAGE_ORDER.get(current || "unstaged");
    if (!matchedAt && directMatch) {
      matchedAt = stage; current = stage;
      for (const key of [semanticKey(identity, "matched", stage), semanticKey(identity, "current", stage)]) { markSeenIds.push(key); seen.add(key); }
    }
    if (!directMatch && !advances) continue;
    const transition = advances ? { from: current, to: stage, label: propertyWatchStageLabel(stage, { transition: true }) } : null;
    if (advances) { const key = semanticKey(identity, "current", stage); markSeenIds.push(key); seen.add(key); current = stage; }
    output.push({ ...row, disposition_stage: stage === "unstaged" ? null : stage, property_watch: { parcel_identity: identity, matched_at_stage: matchedAt, current_stage: current || stage, transition } });
  }
  return { rows: output, markSeenIds: [...new Set(markSeenIds)] };
}
