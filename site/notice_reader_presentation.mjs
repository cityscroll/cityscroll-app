/**
 * Shared notice reader presentation decisions: which relationships already
 * appear in primary facts, and where optional management utilities sit.
 *
 * Edge HTML and the client template both consume these helpers so hydration
 * cannot restore a second toolbar or restate an already-represented role.
 */

export const NOTICE_MORE_TOOLS_SUMMARY = "More tools";
export const NOTICE_TOOLS_REGION_ATTR = "data-notice-tools-region";
export const NOTICE_PRIMARY_FACTS_ATTR = "data-notice-primary-facts";
export const NOTICE_ENRICHMENT_REGION_ATTR = "data-notice-enrichment-region";

/** Relation types that primary notice facts already present to the reader. */
export const NOTICE_PRIMARY_RELATION_TYPES = Object.freeze([
  "published_by_agency",
  "named_vendor",
  "related_land_use_project",
  "hosted_by_community_board",
]);

const clean = (value, max = 320) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const defaultEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));

function relationTypeOf(record = {}) {
  return clean(record.edge_type || record.relation_type || record.relation || record.relation_family, 120);
}

function targetIdentity(record = {}) {
  return clean(
    record.target_id
      || record.related_object_id
      || record.target_ref
      || record.node_id
      || record.target_name
      || record.related_object_label
      || record.label,
    320,
  ).toLowerCase();
}

/**
 * Stable meaning key for a represented relationship.
 * Dedupes by role + target identity, not by destination URL alone, so the same
 * organization can still appear under two distinct roles.
 */
export function noticeRelationshipKey(record = {}) {
  const relation = relationTypeOf(record);
  const target = targetIdentity(record);
  const kind = clean(record.target_kind || record.related_object_kind || "", 40).toLowerCase();
  if (!relation || !target) return "";
  return `${relation}|${kind}|${target}`;
}

/**
 * Build the set of relationships already shown in primary notice facts
 * (glance rows, subject links, and explicit entity pivots).
 */
export function representedNoticeRelationships({
  agency = null,
  vendor = null,
  project = null,
  communityBoard = null,
  subjects = [],
} = {}) {
  const represented = new Set();
  if (agency?.id || agency?.name) {
    represented.add(noticeRelationshipKey({
      edge_type: "published_by_agency",
      target_kind: "agency",
      target_id: agency.id || agency.name,
      target_name: agency.name || agency.id,
    }));
  }
  if (vendor?.id || vendor?.name) {
    represented.add(noticeRelationshipKey({
      edge_type: "named_vendor",
      target_kind: "vendor",
      target_id: vendor.id || vendor.name,
      target_name: vendor.name || vendor.id,
    }));
  }
  if (project?.id || project?.name) {
    represented.add(noticeRelationshipKey({
      edge_type: "related_land_use_project",
      target_kind: "project",
      target_id: project.id || project.name,
      target_name: project.name || project.id,
    }));
  }
  if (communityBoard?.id || communityBoard?.name) {
    represented.add(noticeRelationshipKey({
      edge_type: "hosted_by_community_board",
      target_kind: "community-board",
      target_id: communityBoard.id || communityBoard.name,
      target_name: communityBoard.name || communityBoard.id,
    }));
  }
  for (const subject of Array.isArray(subjects) ? subjects : []) {
    const key = noticeRelationshipKey({
      edge_type: "related_record",
      target_kind: subject.kind || subject.target_kind || "record",
      target_id: subject.id || subject.target_id,
      target_name: subject.label || subject.target_name,
    });
    if (key) represented.add(key);
  }
  return represented;
}

/**
 * Drop local-connection neighbors whose relation meaning is already present in
 * primary facts. Distinct roles for the same target remain.
 */
export function filterNoticeConstellationNeighbors(neighbors = [], represented = new Set()) {
  const keys = represented instanceof Set ? represented : new Set(represented || []);
  if (!keys.size) return Array.isArray(neighbors) ? [...neighbors] : [];
  return (Array.isArray(neighbors) ? neighbors : []).filter((neighbor) => {
    const key = noticeRelationshipKey(neighbor);
    if (!key) return true;
    return !keys.has(key);
  });
}

/**
 * Native, initially closed disclosure for optional notice management utilities.
 * Callers supply already-built control markup so existing IDs and handlers stay intact.
 */
export function renderNoticeMoreToolsDisclosure({
  bodyHtml = "",
  summary = NOTICE_MORE_TOOLS_SUMMARY,
  open = false,
  escape = defaultEscape,
} = {}) {
  const body = String(bodyHtml || "").trim();
  if (!body) return "";
  const openAttr = open ? " open" : "";
  return `<details class="notice-more-tools" ${NOTICE_TOOLS_REGION_ATTR}="1"${openAttr}>
    <summary>${escape(summary)}</summary>
    <div class="notice-more-tools-body actions">${body}</div>
  </details>`;
}

/**
 * Wrap optional enrichment so missing content can leave no empty heading.
 * Empty body yields an empty string.
 */
export function renderNoticeEnrichmentRegion({
  region,
  bodyHtml = "",
  escape = defaultEscape,
} = {}) {
  const body = String(bodyHtml || "").trim();
  if (!body) return "";
  const name = clean(region, 80);
  if (!name) return body;
  return `<div ${NOTICE_ENRICHMENT_REGION_ATTR}="${escape(name)}">${body}</div>`;
}

export function noticeMoreToolsSummaryLabel(translate) {
  if (typeof translate === "function") {
    const label = translate("more_tools");
    if (label && label !== "more_tools") return label;
  }
  return NOTICE_MORE_TOOLS_SUMMARY;
}
