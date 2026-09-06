/**
 * The public-body directory read model and its static document.
 *
 * The old directory listed the keys of the reviewed agency alias table. That
 * table is a name-reconciliation aid, not the inventory of destinations this
 * site publishes, so it both omitted profiles that exist — the City Planning
 * Commission and the Economic Development Corporation among them — and listed
 * names no build materializes.
 *
 * This model starts from the destinations instead: the agency constellation
 * lookup and the community-board lookup are what the builders actually write,
 * so every linked row here is a page a reader can open. Reviewed alias route
 * ids collapse into the canonical institution they resolve to, so an
 * institution is one row however many spellings reach it. Names the alias
 * table carries without a published destination are kept, unlinked and
 * unbadged, so a reference to one stays findable and no row promises a page
 * that is not there.
 *
 * Classification is separate from listing. A row shows a type and a purpose
 * only where `site/civic_institution_classification.mjs` has a reviewed,
 * sourced row for it; everything else is listed by name alone.
 */

import {
  AGENCY_GROUPS,
  agencyCanonicalId,
  resolveAgencyIdentity,
} from "./agency_identity.mjs";
import { reviewedAgencyAcronyms } from "./canonical_entity_interpretation.mjs";
import {
  INSTITUTION_BROWSE_GROUPS,
} from "./civic_institution_classification.mjs";
import {
  projectCommunityBoardClassification,
  projectInstitutionClassification,
} from "./civic_institution_classification_project.mjs";
import { projectResidentInstitutionIdentity } from "./civic_institution_resident_identity.mjs";
import { reviewedBoroughBoardDestinations } from "./civic_institution_related_bodies.mjs";
import {
  AGENCY_DIRECTORY_CONFIG,
  agencyDirectoryParams,
  agencyDirectoryRowHaystack,
  agencyDirectorySummary,
  filterAgencyDirectoryRows,
} from "./agency_directory_contract.mjs";
import { constellationLink, officialSourceLink } from "./affordance_grammar.mjs";

export const AGENCY_DIRECTORY_SCHEMA = "cityscroll.agency_directory.v1";
export const AGENCY_DIRECTORY_TITLE = "Agencies & public bodies";
export const AGENCY_DIRECTORY_LEDE =
  "Find departments, elected offices, boards, authorities, and organizations doing public work.";

/**
 * Rows with a reviewed placement come first, in the launch group order, then
 * the published destinations no reviewed source has typed yet, then the names
 * that have no published destination at all. Every one of them is in All.
 */
const UNCLASSIFIED_SECTION = Object.freeze({
  id: "other-published",
  label: "Other published institutions",
  note: "Listed by name with a published destination. A type appears here only once a primary source states one, so these carry none yet.",
});
const UNPUBLISHED_SECTION = Object.freeze({
  id: "no-published-profile",
  label: "Names without a published profile",
  note: "CityScroll keeps these names so an older reference to one still leads somewhere. A profile page opens for a name once there are public records to show under it.",
});

const directoryEsc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
}[char]));

function directoryText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** Publisher spellings a reader might type, capped so search stays lexical. */
function directorySourceSpellings(canonicalId, canonicalName) {
  const identity = resolveAgencyIdentity(canonicalName || canonicalId);
  const variants = Array.isArray(identity?.variants) ? identity.variants : [];
  return [...new Set(variants.map(directoryText).filter(Boolean))].slice(0, 12);
}

function directoryRow({
  canonicalId,
  name,
  href,
  subjectRef,
  classification,
  sourceSpellings = [],
  acronyms = [],
}) {
  const row = {
    canonical_id: canonicalId,
    name,
    href: href || null,
    // A board's subject is a community board, not an agency. Carrying the
    // agency reference onto it would mint an identity no source supports.
    subject_ref: subjectRef || null,
    group: classification?.browse_group || "",
    secondary_groups: classification ? [...classification.secondary_groups] : [],
    kind_label: classification?.kind_label || null,
    purpose: classification?.purpose || null,
    classification_status: classification ? "classified" : "unclassified",
    acronyms: [...new Set(acronyms.map(directoryText).filter(Boolean))],
    source_spellings: sourceSpellings,
  };
  row.haystack = agencyDirectoryRowHaystack(row);
  return row;
}

/**
 * Every canonical institution this build publishes, plus the reviewed names it
 * does not, deduplicated and ordered for reading.
 *
 * `agencies` is site/data/agency_constellation_lookup.json and `communityBoards`
 * is site/data/community_board_constellation_lookup.json — the two artifacts
 * whose entries correspond one-to-one with the documents the builders write.
 */
export function buildAgencyDirectoryModel({
  agencies = {},
  communityBoards = {},
  publisherCrosswalk = null,
} = {}) {
  const rows = [];
  const seen = new Set();

  for (const [id, entry] of Object.entries(agencies.by_id || {})) {
    const canonicalId = directoryText(id);
    if (!canonicalId || seen.has(canonicalId)) continue;
    const name = directoryText(entry?.display_name) || canonicalId;
    seen.add(canonicalId);
    const classification = projectInstitutionClassification(canonicalId, { canonicalName: name });
    const resident = projectResidentInstitutionIdentity(canonicalId, {
      displayName: name,
      publisherRow: publisherCrosswalk?.entries?.[canonicalId] || null,
    });
    rows.push(directoryRow({
      canonicalId,
      name,
      href: directoryText(entry?.path) || `/agencies/${canonicalId}/`,
      subjectRef: directoryText(entry?.subject_ref) || `agency:id:${canonicalId}`,
      classification,
      sourceSpellings: directorySourceSpellings(canonicalId, name),
      acronyms: [
        ...reviewedAgencyAcronyms(canonicalId),
        ...(classification?.acronyms || []),
        ...(resident?.former_names || []),
      ],
    }));
  }

  // Each board keeps its own canonical destination. The aggregate community
  // boards institution stays an agency route; an individual board is never
  // republished under one.
  for (const [bodyId, board] of Object.entries(communityBoards.by_id || {})) {
    const canonicalId = directoryText(bodyId);
    if (!canonicalId || seen.has(canonicalId)) continue;
    const name = directoryText(board?.display_name) || canonicalId;
    const href = directoryText(board?.path);
    if (!href) continue;
    seen.add(canonicalId);
    rows.push(directoryRow({
      canonicalId,
      name,
      href,
      subjectRef: `community-board:${canonicalId}`,
      classification: projectCommunityBoardClassification(canonicalId, name),
      sourceSpellings: [],
      acronyms: [],
    }));
  }

  for (const board of reviewedBoroughBoardDestinations()) {
    const canonicalId = directoryText(board.canonical_id);
    if (!canonicalId || seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    rows.push(directoryRow({
      canonicalId,
      name: directoryText(board.name),
      href: directoryText(board.href),
      subjectRef: directoryText(board.subject_ref),
      classification: projectInstitutionClassification(canonicalId, { canonicalName: board.name }),
      sourceSpellings: [],
      acronyms: [],
    }));
  }

  // Reviewed names the previous directory listed. Their canonical id is the
  // identity the alias table resolves them to, so a name that now shares a
  // route with a published institution is already above and is not repeated.
  for (const name of Object.keys(AGENCY_GROUPS)) {
    const canonicalId = agencyCanonicalId(name);
    if (!canonicalId || seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    rows.push(directoryRow({
      canonicalId,
      name: directoryText(name),
      href: null,
      subjectRef: null,
      classification: projectInstitutionClassification(canonicalId, { canonicalName: name }),
      sourceSpellings: directorySourceSpellings(canonicalId, name),
      acronyms: [...reviewedAgencyAcronyms(canonicalId)],
    }));
  }

  const sections = [];
  for (const group of INSTITUTION_BROWSE_GROUPS) {
    const members = rows
      .filter((row) => row.group === group.id && row.href)
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    if (members.length) sections.push({ ...group, rows: members });
  }
  const unclassified = rows
    .filter((row) => !row.group && row.href)
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (unclassified.length) sections.push({ ...UNCLASSIFIED_SECTION, sources: [], rows: unclassified });
  const unpublished = rows
    .filter((row) => !row.href)
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (unpublished.length) sections.push({ ...UNPUBLISHED_SECTION, sources: [], rows: unpublished });

  const ordered = sections.flatMap((section) => section.rows);
  return {
    schema: AGENCY_DIRECTORY_SCHEMA,
    generated_from: {
      agencies: directoryText(agencies?.generated_at) || null,
      community_boards: directoryText(communityBoards?.generated_at) || null,
    },
    groups: INSTITUTION_BROWSE_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      count: ordered.filter((row) => (
        row.group === group.id || row.secondary_groups.includes(group.id)
      )).length,
    })),
    sections,
    rows: ordered,
    total: ordered.length,
    linked: ordered.filter((row) => row.href).length,
    classified: ordered.filter((row) => row.classification_status === "classified").length,
  };
}

function renderDirectoryRow(row) {
  const label = row.href
    ? constellationLink({
      href: row.href,
      label: row.name,
      className: "agency-index-link",
      attributes: row.subject_ref ? { "data-subject-ref": row.subject_ref } : {},
      escape: directoryEsc,
    })
    : `<span class="agency-directory-name">${directoryEsc(row.name)}</span>`;
  const kind = row.kind_label
    ? `<span class="agency-directory-kind">${directoryEsc(row.kind_label)}</span>`
    : "";
  const purpose = row.purpose
    ? `<span class="agency-directory-purpose">${directoryEsc(row.purpose)}</span>`
    : "";
  const absence = row.href
    ? ""
    : `<span class="agency-directory-purpose">No profile page yet.</span>`;
  const meta = kind || purpose || absence
    ? `<p class="agency-directory-row-meta">${[kind, purpose, absence].filter(Boolean).join(" ")}</p>`
    : "";
  return `<li class="agency-directory-row" data-directory-row="1" data-canonical-id="${directoryEsc(row.canonical_id)}" data-group="${directoryEsc(row.group)}" data-secondary-groups="${directoryEsc(row.secondary_groups.join(" "))}" data-haystack="${directoryEsc(row.haystack)}">${label}${meta}</li>`;
}

function renderDirectorySection(section) {
  const sources = (section.sources || []).length
    ? `<p class="agency-directory-group-sources">${section.sources.map((source) => officialSourceLink({
      href: source.url || source.source_url,
      label: source.citation,
      newTabLabel: "(opens in new tab)",
      escape: directoryEsc,
    })).join(" ")}</p>`
    : "";
  return `<section class="agency-directory-group" id="group-${directoryEsc(section.id)}" data-directory-section="${directoryEsc(section.id)}" aria-labelledby="group-${directoryEsc(section.id)}-heading">
<h2 id="group-${directoryEsc(section.id)}-heading">${directoryEsc(section.label)} <span class="agency-directory-count" data-directory-section-count="${directoryEsc(section.id)}">${section.rows.length}</span></h2>
<p class="agency-directory-group-note">${directoryEsc(section.note)}</p>${sources}
<ul class="agency-directory-rows">${section.rows.map(renderDirectoryRow).join("")}</ul>
</section>`;
}

function renderDirectoryGroupNav(model, state) {
  const link = (id, label, count) => {
    const current = state.group === id;
    const href = id
      ? `${AGENCY_DIRECTORY_CONFIG.route}?${AGENCY_DIRECTORY_CONFIG.groupParam}=${encodeURIComponent(id)}#group-${encodeURIComponent(id)}`
      : AGENCY_DIRECTORY_CONFIG.route;
    return `<li><a class="agency-directory-group-link" href="${directoryEsc(href)}" data-directory-group="${directoryEsc(id)}"${current ? ' aria-current="true"' : ""}>${directoryEsc(label)} <span class="agency-directory-count">${count}</span></a></li>`;
  };
  return `<nav class="agency-directory-groups" aria-label="Browse by group">
<ul>${[
    link("", "All", model.total),
    ...model.groups.filter((group) => group.count).map((group) => link(group.id, group.label, group.count)),
  ].join("")}</ul></nav>`;
}

/**
 * The static document.
 *
 * Everything a reader can reach is in the markup before any script runs: the
 * search is a real GET form, each group is a real anchor to that group's
 * section, and every destination is an ordinary href. The browser enhancement
 * in `site/agency_directory_runtime.mjs` narrows what is shown; it is not what
 * makes any of it reachable.
 */
export function renderAgencyDirectoryDocument(model, { search = "" } = {}) {
  const groupIds = model.groups.map((group) => group.id);
  const state = agencyDirectoryParams(search, groupIds);
  const matched = filterAgencyDirectoryRows(model.rows, state).length;
  const groupLabel = model.groups.find((group) => group.id === state.group)?.label || "";
  const summary = agencyDirectorySummary({
    matched,
    total: model.total,
    query: state.query,
    groupLabel,
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${directoryEsc(AGENCY_DIRECTORY_TITLE)} · CityScroll</title><link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/civic-documents.css"></head>
<body><a class="skip" href="#main">Skip to content</a>
<main id="main" class="node-document civic-object-document" data-node-document="1"><p class="node-back"><a href="/browse/">Back to Browse</a></p>
<header class="node-hero civic-object-hero"><p class="node-kicker civic-object-kicker">Public bodies</p><h1>${directoryEsc(AGENCY_DIRECTORY_TITLE)}</h1>
<p class="node-lede">${directoryEsc(AGENCY_DIRECTORY_LEDE)}</p>
</header>
<div class="agency-directory" data-agency-directory="1" data-directory-total="${model.total}">
<form class="agency-directory-search" method="get" action="${directoryEsc(AGENCY_DIRECTORY_CONFIG.route)}" role="search" data-directory-form="1">
<label for="agency-directory-query">Search by name or acronym</label>
<span class="agency-directory-search-controls">
<input id="agency-directory-query" class="agency-directory-input" type="search" name="${directoryEsc(AGENCY_DIRECTORY_CONFIG.queryParam)}" value="${directoryEsc(state.query)}" autocomplete="off" spellcheck="false" data-directory-query="1">
<button class="civic-object-action" type="submit">Search</button>
<a class="civic-object-action agency-directory-clear" href="${directoryEsc(AGENCY_DIRECTORY_CONFIG.route)}" data-directory-clear="1">Clear</a>
</span>
</form>
${renderDirectoryGroupNav(model, state)}
<p class="agency-directory-summary" data-directory-summary="1" role="status">${directoryEsc(summary)}</p>
<p class="agency-directory-empty" data-directory-empty="1" hidden>No public body in this directory matches that search. Clear the search to see all ${model.total}, or choose another group.</p>
${model.sections.map(renderDirectorySection).join("\n")}
</div>
</main><footer class="node-footer civic-object-footer">CityScroll is an unofficial reading aid. <a href="/guide/">Guide</a>. <a href="/about.html">About the data</a>.</footer>
<script type="module" src="/agency_directory_runtime.mjs"></script>
</body></html>`;
}
