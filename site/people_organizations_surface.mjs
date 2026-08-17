import {
  browseListState,
  PEOPLE_ORGANIZATIONS_BROWSE_CONFIG,
} from "./browse_list_contract.mjs";
import { buildBrowseView } from "./browse_view.mjs";
import { PEOPLE_ORGANIZATIONS_SURFACE } from "./browse_surface_contracts.mjs";

export const PEOPLE_LIST_BROWSE_VIEW = Object.freeze({
  tab: "browse",
  label: "People and organizations",
  route: PEOPLE_ORGANIZATIONS_SURFACE.canonicalRoute,
  countLabel: "typed civic objects",
  description: "Officials, agencies, vendors, committees, community boards, and published appointments.",
  sources: "Person hub · committee graph · agency constellation",
  rowsKey: "rows",
});

export function peopleBrowseRows(model = {}) {
  const kindLabels = {
    official: "Official",
    "exact-person-appointment": "Exact-person appointment",
    "notice-only-hire": "Notice-only hire",
    agency: "Agency",
    vendor: "Vendor",
    committee: "Committee",
    "community-board": "Community board institution",
  };
  return (Array.isArray(model.rows) ? model.rows : []).flatMap((row) => {
    const id = String(row?.id || "").trim();
    const kind = String(row?.kind || "").trim();
    const label = String(row?.label || "").trim();
    if (!id || !PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.facetValues.includes(kind) || !label) return [];
    const rawKindLabel = kind.replaceAll("-", " ");
    const kindLabel = kindLabels[kind] || `${rawKindLabel[0].toUpperCase()}${rawKindLabel.slice(1)}`;
    const heading = kind === "official"
      ? `Official · ${label}`
      : `${label} · ${kindLabel} · ${id}`;
    return [{
      ...row,
      detail: kind === "official" && row.detail === "Official profile" ? "" : row.detail,
      show_civic_metadata: kind !== "official",
      show_relation_state: kind !== "community-board",
      civic_object: {
        kind,
        kind_label: kind === "official" ? "" : kindLabel,
        id,
        label: heading,
        href: row.href || null,
      },
    }];
  });
}

export function buildPeopleListBrowseView(model = {}, params = new URLSearchParams(), options = {}) {
  const state = browseListState(model, params, PEOPLE_ORGANIZATIONS_BROWSE_CONFIG);
  const rows = peopleBrowseRows({ rows: state.rows });
  return buildBrowseView("people-list", { rows }, params, {
    config: PEOPLE_LIST_BROWSE_VIEW,
    rows,
    asOf: state.generatedAt,
    limit: options.limit ?? PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.initialPageSize,
    handledFilters: [PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.facetParam],
  });
}
