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
  description: "Community Boards, City Council, agencies, and vendors—each row names its institution.",
  sources: "Community Board people and roles · person hub · committee graph · agency constellation",
  rowsKey: "rows",
});

export function peopleBrowseRows(model = {}) {
  const kindLabels = {
    official: "City Council member/official",
    "exact-person-appointment": "City Council term",
    "notice-only-hire": "Published staffing notice",
    agency: "Agency",
    vendor: "Vendor",
    committee: "City Council committee",
    "community-board": "Community Board",
    "community-board-person": "Community Board person",
    "community-board-committee": "Community Board committee",
  };
  const institutionLabels = {
    official: "New York City Council",
    "exact-person-appointment": "New York City Council",
    committee: "New York City Council",
    "community-board": "Community Board",
    "community-board-person": "Community Board",
    "community-board-committee": "Community Board",
    agency: "Agency",
    vendor: "Vendor",
    "notice-only-hire": "Agency",
  };
  return (Array.isArray(model.rows) ? model.rows : []).flatMap((row) => {
    const id = String(row?.id || "").trim();
    const kind = String(row?.kind || "").trim();
    const label = String(row?.label || "").trim();
    if (!id || !PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.facetValues.includes(kind) || !label) return [];
    const rawKindLabel = kind.replaceAll("-", " ");
    const kindLabel = kindLabels[kind] || `${rawKindLabel[0].toUpperCase()}${rawKindLabel.slice(1)}`;
    const institutionLabel = String(row.institution_label || institutionLabels[kind] || "").trim();
    const isCommunityBoard = kind === "community-board";
    const heading = isCommunityBoard
      ? label
      : institutionLabel
        ? `${institutionLabel} · ${kindLabel} · ${label}${kind === "official" ? "" : ` · ${id}`}`
      : kind === "official"
        ? `${kindLabel} · ${label}`
        : `${label} · ${kindLabel} · ${id}`;
    return [{
      ...row,
      institution: row.institution || (kind === "official" || kind === "exact-person-appointment" || kind === "committee" ? "city-council" : kind.startsWith("community-board") ? "community-board" : kind === "vendor" ? "vendor" : kind === "agency" || kind === "notice-only-hire" ? "agency" : ""),
      institution_label: isCommunityBoard ? "Community Board" : institutionLabel,
      institution_ref: isCommunityBoard ? null : row.institution_ref,
      institution_href: isCommunityBoard ? null : row.institution_href,
      institution_context: row.institution_context || (kind === "official" || kind === "exact-person-appointment" || kind === "committee" ? "Elected legislative body" : ""),
      detail: kind === "official" && row.detail === "Official profile" ? "" : row.detail,
      show_civic_metadata: kind !== "official" && !isCommunityBoard,
      show_relation_state: false,
      civic_object: {
        kind,
        kind_label: kindLabel,
        id,
        label: heading,
        href: row.href || null,
        institution: row.institution || (kind === "official" || kind === "exact-person-appointment" || kind === "committee" ? "city-council" : kind.startsWith("community-board") ? "community-board" : kind === "vendor" ? "vendor" : kind === "agency" || kind === "notice-only-hire" ? "agency" : ""),
        institution_label: institutionLabel,
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
    handledFilters: [
      PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.facetParam,
      PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.institutionParam,
      PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.roleParam,
    ],
  });
}
