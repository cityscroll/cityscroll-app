/**
 * Community-board directory neighborhood entry.
 *
 * Turns the board↔NTA association index (and its directory consumer) into a
 * labeled neighborhood chooser, shareable geo URLs, and a complete no-JS
 * association table on /community-boards/. Special-district overlaps never
 * become board cards. Exact-address resolution is offered as an explicit panel;
 * the address→board resolver lives in board_exact_address.mjs.
 */

import { communityBoardPageHref } from "./community_board_links.mjs";
import {
  GEOGRAPHY_NAVIGATION_GEO_PARAM,
  geographyNavigationSelectionToken,
  parseGeographyNavigationState,
} from "./geography_navigation_state.mjs";
import {
  isResidentialNeighborhoodSubtype,
  resolveGeographyNavigationKey,
} from "./geography_navigation_capability.mjs";
import {
  ntaBoroughForFeature,
} from "./geography_navigation_shell.mjs";
import {
  renderBoardExactAddressPanelHtml,
} from "./board_exact_address.mjs";

export const BOARD_NEIGHBORHOOD_DIRECTORY_SCHEMA =
  "cityscroll.board_neighborhood_directory.v1";

export const BOARD_NEIGHBORHOOD_DIRECTORY_BASE = "/community-boards/";

const BOARD_ID_RE = /^([a-z]+(?:-[a-z]+)*)-cb-(\d{2})$/;
const BOROUGH_FROM_SLUG = Object.freeze({
  bronx: "Bronx",
  brooklyn: "Brooklyn",
  manhattan: "Manhattan",
  queens: "Queens",
  "staten-island": "Staten Island",
});

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

/** Resident board name from a canonical board id. */
export function boardDisplayNameFromId(boardId, boardNames = null) {
  const id = clean(boardId).toLowerCase();
  if (boardNames && typeof boardNames === "object" && boardNames[id]) {
    return clean(boardNames[id]);
  }
  const match = id.match(BOARD_ID_RE);
  if (!match) return null;
  const borough = BOROUGH_FROM_SLUG[match[1]] || null;
  const number = Number(match[2]);
  if (!borough || !Number.isInteger(number)) return null;
  return `${borough} Community Board ${number}`;
}

/** Compact NTA label map from a geography layer document (geometry ignored). */
export function ntaLabelIndexFromLayer(layerDoc = {}) {
  const out = Object.create(null);
  for (const feature of Array.isArray(layerDoc.features) ? layerDoc.features : []) {
    const id = clean(feature?.id || feature?.key?.split(":").pop()).toUpperCase();
    if (!/^(?:BK|BX|MN|QN|SI)\d{4}$/.test(id)) continue;
    const label = clean(feature?.label);
    if (!label || /^[A-Z]{2}\d{4}$/.test(label)) continue;
    out[id] = Object.freeze({
      id,
      label,
      subtype: feature?.subtype == null ? null : clean(feature.subtype),
      borough: ntaBoroughForFeature(feature),
    });
  }
  return Object.freeze(out);
}

function compareBoardChoices(left, right) {
  const pct = (Number(right.pct_from) || 0) - (Number(left.pct_from) || 0);
  if (pct !== 0) return pct;
  return clean(left.board_id).localeCompare(clean(right.board_id));
}


/** Local by_nta lookup — keep this module free of Node built-ins for Pages. */
function boardsForNta(index, ntaId) {
  const id = clean(ntaId).toUpperCase();
  return Array.isArray(index?.by_nta?.[id]) ? index.by_nta[id] : [];
}

/**
 * Resolve a neighborhood geography selection against the association index.
 * Unknown or non-NTA keys leave the directory unfiltered.
 */
export function resolveBoardNeighborhoodSelection(rawGeo, associations) {
  if (rawGeo == null || rawGeo === "") {
    return Object.freeze({
      ok: true,
      selected: false,
      geo: null,
      key: null,
      nta_id: null,
      label: null,
      subtype: null,
      boards: Object.freeze([]),
      non_board_overlaps: Object.freeze([]),
      recovery: null,
    });
  }
  const resolved = resolveGeographyNavigationKey(rawGeo);
  if (!resolved.ok || resolved.type !== "nta2020") {
    return Object.freeze({
      ok: false,
      selected: false,
      geo: null,
      key: null,
      nta_id: null,
      label: null,
      subtype: null,
      boards: Object.freeze([]),
      non_board_overlaps: Object.freeze([]),
      recovery: Object.freeze({
        reason: resolved.reason || "malformed_geography_key",
        explanation: resolved.explanation
          || "That geography key is not a neighborhood selection for this directory.",
      }),
    });
  }
  if (!associations || associations.load_failed) {
    return Object.freeze({
      ok: false,
      selected: true,
      geo: geographyNavigationSelectionToken(resolved),
      key: resolved.key,
      nta_id: resolved.id,
      label: associations?.labels?.[resolved.id]?.label || resolved.id,
      subtype: associations?.labels?.[resolved.id]?.subtype || null,
      boards: Object.freeze([]),
      non_board_overlaps: Object.freeze([]),
      recovery: Object.freeze({
        reason: "association_load_failed",
        explanation: "Neighborhood-to-board associations could not be loaded. The full board directory remains available.",
      }),
    });
  }

  const ntaId = resolved.id;
  const labelMeta = associations.labels?.[ntaId] || null;
  const boards = boardsForNta(associations, ntaId)
    .filter((edge) => edge?.board_id)
    .slice()
    .sort(compareBoardChoices)
    .map((edge) => Object.freeze({
      ...edge,
      board_name: boardDisplayNameFromId(edge.board_id, associations.board_names),
      profile_href: communityBoardPageHref(edge.board_id),
    }));
  const nonBoard = (Array.isArray(associations.non_board_overlaps)
    ? associations.non_board_overlaps
    : [])
    .filter((edge) => clean(edge?.nta_id).toUpperCase() === ntaId)
    .map((edge) => Object.freeze({ ...edge }));

  return Object.freeze({
    ok: true,
    selected: true,
    geo: geographyNavigationSelectionToken(resolved),
    key: resolved.key,
    nta_id: ntaId,
    label: labelMeta?.label || ntaId,
    subtype: labelMeta?.subtype || boards[0]?.subtype || nonBoard[0]?.subtype || null,
    boards: Object.freeze(boards),
    non_board_overlaps: Object.freeze(nonBoard),
    recovery: null,
  });
}

/** Heading copy for a resolved selection. Never labels a match "your board". */
export function boardNeighborhoodSelectionHeading(selection) {
  if (!selection?.selected || !selection.ok) return "Community boards";
  const label = clean(selection.label) || selection.nta_id || "this neighborhood";
  if (selection.boards.length > 1) return `Boards overlapping ${label}`;
  if (selection.boards.length === 1) return `Board overlapping ${label}`;
  return `No published board for ${label}`;
}

/**
 * Normalize an index document or directory consumer into the associations bag
 * the chooser and table render against.
 */
export function associationsFromBoardNeighborhoodSource(source = {}, {
  labels = null,
  boardNames = null,
  loadFailed = false,
} = {}) {
  if (loadFailed) {
    return Object.freeze({
      schema: BOARD_NEIGHBORHOOD_DIRECTORY_SCHEMA,
      load_failed: true,
      generation_id: null,
      by_nta: Object.freeze({}),
      non_board_overlaps: Object.freeze([]),
      labels: Object.freeze(labels || {}),
      board_names: Object.freeze(boardNames || {}),
    });
  }
  const byNta = source?.by_nta && typeof source.by_nta === "object" ? source.by_nta : {};
  const nonBoard = Array.isArray(source?.non_board_overlaps) ? source.non_board_overlaps : [];
  const generationId = clean(
    source?.generation_id
    || source?.generation?.id
    || source?.generation?.content_sha256
    || "",
  ) || null;
  return Object.freeze({
    schema: BOARD_NEIGHBORHOOD_DIRECTORY_SCHEMA,
    load_failed: false,
    generation_id: generationId,
    by_nta: byNta,
    non_board_overlaps: Object.freeze([...nonBoard]),
    labels: Object.freeze(labels || {}),
    board_names: Object.freeze(boardNames || {}),
  });
}

function neighborhoodOptions(associations) {
  const options = [];
  for (const ntaId of Object.keys(associations.by_nta || {}).sort((a, b) => a.localeCompare(b))) {
    const meta = associations.labels?.[ntaId] || null;
    const edges = associations.by_nta[ntaId] || [];
    const subtype = meta?.subtype || edges[0]?.subtype || null;
    const label = meta?.label || ntaId;
    options.push(Object.freeze({
      nta_id: ntaId,
      label,
      subtype,
      borough: meta?.borough || null,
      is_special_use: !isResidentialNeighborhoodSubtype(subtype),
      geo: `nta2020:${ntaId}`,
      href: `${BOARD_NEIGHBORHOOD_DIRECTORY_BASE}?${GEOGRAPHY_NAVIGATION_GEO_PARAM}=${encodeURIComponent(`nta2020:${ntaId}`)}`,
      board_count: edges.filter((edge) => edge?.board_id).length,
    }));
  }
  return Object.freeze(
    options.sort((left, right) => left.label.localeCompare(right.label) || left.nta_id.localeCompare(right.nta_id)),
  );
}

function associationTableRows(associations) {
  const rows = [];
  for (const ntaId of Object.keys(associations.by_nta || {}).sort((a, b) => a.localeCompare(b))) {
    const label = associations.labels?.[ntaId]?.label || ntaId;
    for (const edge of (associations.by_nta[ntaId] || []).slice().sort(compareBoardChoices)) {
      if (!edge?.board_id) continue;
      rows.push(Object.freeze({
        nta_id: ntaId,
        neighborhood_label: label,
        board_id: edge.board_id,
        board_name: boardDisplayNameFromId(edge.board_id, associations.board_names),
        district_id: edge.district_id,
        pct_from: edge.pct_from,
        subtype: edge.subtype,
        profile_href: communityBoardPageHref(edge.board_id),
        geo_href: `${BOARD_NEIGHBORHOOD_DIRECTORY_BASE}?${GEOGRAPHY_NAVIGATION_GEO_PARAM}=${encodeURIComponent(`nta2020:${ntaId}`)}`,
        has_board: true,
      }));
    }
  }
  for (const edge of associations.non_board_overlaps || []) {
    const ntaId = clean(edge?.nta_id).toUpperCase();
    if (!ntaId) continue;
    rows.push(Object.freeze({
      nta_id: ntaId,
      neighborhood_label: associations.labels?.[ntaId]?.label || ntaId,
      board_id: null,
      board_name: null,
      district_id: edge.district_id,
      pct_from: edge.pct_from,
      subtype: edge.subtype,
      profile_href: null,
      geo_href: `${BOARD_NEIGHBORHOOD_DIRECTORY_BASE}?${GEOGRAPHY_NAVIGATION_GEO_PARAM}=${encodeURIComponent(`nta2020:${ntaId}`)}`,
      has_board: false,
    }));
  }
  return Object.freeze(rows);
}

function formatPctFrom(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "not published";
  if (number >= 99.95) return "~100% of neighborhood area";
  if (number < 0.05) return "<0.1% of neighborhood area";
  return `${number.toFixed(1)}% of neighborhood area`;
}

function renderBoardChoiceCard(board) {
  const name = board.board_name || board.board_id;
  const profile = board.profile_href
    ? `<a class="scorecard-neighborhood-profile" href="${esc(board.profile_href)}">Open board profile</a>`
    : "";
  const hashHref = `#board-${esc(board.board_id)}`;
  return `<li class="scorecard-neighborhood-choice" data-board-neighborhood-choice="${esc(board.board_id)}" data-district-id="${esc(board.district_id)}">
      <a class="scorecard-neighborhood-choice-name" href="${esc(hashHref)}">${esc(name)}</a>
      <span class="scorecard-neighborhood-choice-district">District ${esc(board.district_id)}</span>
      ${profile}
      <details class="scorecard-neighborhood-overlap">
        <summary>Boundary overlap</summary>
        <p>${esc(formatPctFrom(board.pct_from))} (neighborhood area share).</p>
      </details>
    </li>`;
}

/** Failure panel that keeps the directory usable and offers retry. */
export function renderBoardNeighborhoodDirectoryFailureHtml({
  explanation = "Neighborhood-to-board associations could not be loaded. The full board directory remains available.",
  retryHref = BOARD_NEIGHBORHOOD_DIRECTORY_BASE,
} = {}) {
  return `<section class="scorecard-neighborhood-entry is-failed" data-board-neighborhood-entry data-association-state="failed" aria-labelledby="scorecard-neighborhood-heading">
    <div class="scorecard-heading">
      <div>
        <p class="scorecard-kicker">Find a board</p>
        <h2 id="scorecard-neighborhood-heading">Choose a neighborhood</h2>
      </div>
    </div>
    <p class="scorecard-neighborhood-failure" data-board-neighborhood-failure role="status">${esc(explanation)}</p>
    <p class="scorecard-neighborhood-failure-actions">
      <a class="scorecard-neighborhood-retry" data-board-neighborhood-retry href="${esc(retryHref)}">Try loading neighborhood choices again</a>
    </p>
    <p class="scorecard-muted">Board calendars, profiles, and source coverage below stay available.</p>
  </section>`;
}

/**
 * Progressive-enhancement markup: labeled chooser, selection results, address
 * action hook, and the complete association table for no-JS browsing.
 */
export function renderBoardNeighborhoodDirectoryHtml(associations, {
  selectedGeo = null,
  base = BOARD_NEIGHBORHOOD_DIRECTORY_BASE,
} = {}) {
  if (!associations || associations.load_failed) {
    return renderBoardNeighborhoodDirectoryFailureHtml({ retryHref: base });
  }

  const selection = resolveBoardNeighborhoodSelection(selectedGeo, associations);
  const options = neighborhoodOptions(associations);
  const residential = options.filter((row) => !row.is_special_use);
  const special = options.filter((row) => row.is_special_use);
  const selectedValue = selection.ok && selection.selected ? selection.geo : "";
  const optionMarkup = residential.map((row) => {
    const boardIds = (associations.by_nta?.[row.nta_id] || [])
      .filter((edge) => edge?.board_id)
      .slice()
      .sort(compareBoardChoices)
      .map((edge) => edge.board_id)
      .join(" ");
    return `<option value="${esc(row.geo)}" data-nta-id="${esc(row.nta_id)}" data-board-ids="${esc(boardIds)}" data-neighborhood-label="${esc(row.label)}"${row.geo === selectedValue ? " selected" : ""}>${esc(row.label)}</option>`;
  }).join("");
  const specialMarkup = special.map((row) => {
    const boardIds = (associations.by_nta?.[row.nta_id] || [])
      .filter((edge) => edge?.board_id)
      .slice()
      .sort(compareBoardChoices)
      .map((edge) => edge.board_id)
      .join(" ");
    return `<option value="${esc(row.geo)}" data-nta-id="${esc(row.nta_id)}" data-board-ids="${esc(boardIds)}" data-neighborhood-label="${esc(row.label)}"${row.geo === selectedValue ? " selected" : ""}>${esc(row.label)} (special area)</option>`;
  }).join("");

  const heading = boardNeighborhoodSelectionHeading(selection);
  const choiceCards = selection.ok && selection.selected
    ? selection.boards.map(renderBoardChoiceCard).join("")
    : "";
  const resultsHidden = !(selection.ok && selection.selected);
  const addressAction = selection.ok && selection.boards.length > 1
    ? `<p class="scorecard-neighborhood-address-action">
        <a href="#board-neighborhood-address" data-board-address-action>Find the board for a specific address</a>
        <span class="scorecard-muted">Use an exact address when a neighborhood overlaps more than one board.</span>
      </p>`
    : "";
  const clearHref = base;
  const clearLink = selection.ok && selection.selected
    ? `<a class="scorecard-neighborhood-clear" data-board-neighborhood-clear href="${esc(clearHref)}">Show all boards</a>`
    : `<a class="scorecard-neighborhood-clear" data-board-neighborhood-clear href="${esc(clearHref)}" hidden>Show all boards</a>`;

  const tableRows = associationTableRows(associations).map((row) => {
    const boardCell = row.has_board
      ? (row.profile_href
        ? `<a href="${esc(row.profile_href)}">${esc(row.board_name || row.board_id)}</a>`
        : esc(row.board_name || row.board_id))
      : `<span class="scorecard-muted">No published community board</span>`;
    return `<tr data-board-association-row data-nta-id="${esc(row.nta_id)}" data-board-id="${esc(row.board_id || "")}" data-has-board="${row.has_board ? "true" : "false"}">
      <th scope="row"><a href="${esc(row.geo_href)}" data-board-neighborhood-link="${esc(row.nta_id)}">${esc(row.neighborhood_label)}</a><span>${esc(row.nta_id)}</span></th>
      <td>${boardCell}</td>
      <td>${esc(row.district_id || "—")}</td>
      <td>${esc(formatPctFrom(row.pct_from))}</td>
    </tr>`;
  }).join("");

  const generationNote = associations.generation_id
    ? `<p class="scorecard-muted" data-board-neighborhood-generation>Association generation ${esc(associations.generation_id.slice(0, 12))}…</p>`
    : "";

  return `<section class="scorecard-neighborhood-entry" data-board-neighborhood-entry data-association-state="ready" data-selected-geo="${esc(selectedValue)}" aria-labelledby="scorecard-neighborhood-heading">
    <div class="scorecard-heading">
      <div>
        <p class="scorecard-kicker">Find a board</p>
        <h2 id="scorecard-neighborhood-heading">Choose a neighborhood</h2>
      </div>
      ${clearLink}
    </div>
    <p class="scorecard-neighborhood-dek">Start from a named neighborhood to see the overlapping community boards. The full directory stays available below.</p>
    <form class="scorecard-neighborhood-form" method="get" action="${esc(base)}" data-board-neighborhood-form>
      <label for="scorecard-neighborhood-select">Neighborhood</label>
      <div class="scorecard-neighborhood-form-row">
        <select id="scorecard-neighborhood-select" name="${esc(GEOGRAPHY_NAVIGATION_GEO_PARAM)}" data-board-neighborhood-select>
          <option value="">All neighborhoods</option>
          <optgroup label="Neighborhoods">${optionMarkup}</optgroup>
          <optgroup label="Special-use areas">${specialMarkup}</optgroup>
        </select>
        <button type="submit">Show boards</button>
      </div>
    </form>
    <div class="scorecard-neighborhood-results" data-board-neighborhood-results${resultsHidden ? " hidden" : ""} aria-live="polite">
      <h3 data-board-neighborhood-results-heading>${esc(heading)}</h3>
      <ol class="scorecard-neighborhood-choices" data-board-neighborhood-choices>${choiceCards || "<li class=\"scorecard-muted\">No published community board overlaps this place.</li>"}</ol>
      <div data-board-neighborhood-address-slot>${addressAction}</div>
    </div>
    ${renderBoardExactAddressPanelHtml()}
    <details class="scorecard-neighborhood-table-wrap" data-board-neighborhood-table-wrap>
      <summary>Neighborhood board associations</summary>
      <p class="scorecard-muted">Complete labeled table for browsing without JavaScript. Overlap percentages use neighborhood area as the denominator.</p>
      <div class="scorecard-table-wrap">
        <table data-board-neighborhood-association-table>
          <thead>
            <tr>
              <th scope="col">Neighborhood</th>
              <th scope="col">Community board</th>
              <th scope="col">District</th>
              <th scope="col">Overlap</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </details>
    ${generationNote}
  </section>`;
}

/**
 * Apply a neighborhood selection to existing scorecard board chrome.
 * Returns the board ids that remain visible; empty means show all boards.
 */
export function visibleBoardIdsForSelection(selection) {
  if (!selection?.ok || !selection.selected) return null;
  return Object.freeze(selection.boards.map((board) => board.board_id));
}

/**
 * Browser binder for progressive enhancement: restore geo URLs, filter board
 * chrome, keep legacy #board- hashes, and surface association-load failure.
 */
export function mountBoardNeighborhoodDirectory(root, {
  associations = null,
  location = globalThis.location,
  history = globalThis.history,
  fetchAssociations = null,
} = {}) {
  if (!root) return null;
  const entry = root.querySelector("[data-board-neighborhood-entry]");
  if (!entry) return null;

  const select = entry.querySelector("[data-board-neighborhood-select]");
  const form = entry.querySelector("[data-board-neighborhood-form]");
  const results = entry.querySelector("[data-board-neighborhood-results]");
  const resultsHeading = entry.querySelector("[data-board-neighborhood-results-heading]");
  const choices = entry.querySelector("[data-board-neighborhood-choices]");
  const clearLink = entry.querySelector("[data-board-neighborhood-clear]");
  const addressSlot = entry.querySelector("[data-board-neighborhood-address-slot]");
  const paths = [...root.querySelectorAll("[data-board-id]")];
  const details = [...root.querySelectorAll("[data-board-detail]")];
  const rows = [...root.querySelectorAll("tbody tr[id^='board-']")];

  let activeAssociations = associations;
  let currentSelection = resolveBoardNeighborhoodSelection(
    parseGeographyNavigationState(location.href || location.search || "").geo,
    activeAssociations || associationsFromBoardNeighborhoodSource({}, { loadFailed: true }),
  );

  function writeGeo(geo, { replace = true } = {}) {
    const url = new URL(location.href || `${location.origin || "https://cityscroll.org"}${location.pathname || BOARD_NEIGHBORHOOD_DIRECTORY_BASE}${location.search || ""}`, "https://cityscroll.org");
    if (geo) url.searchParams.set(GEOGRAPHY_NAVIGATION_GEO_PARAM, geo);
    else url.searchParams.delete(GEOGRAPHY_NAVIGATION_GEO_PARAM);
    const next = `${url.pathname}${url.search}${location.hash || ""}`;
    if (replace && history?.replaceState) history.replaceState(null, "", next);
    else if (history?.pushState) history.pushState(null, "", next);
    if (location.search !== undefined) {
      // Keep injectable location fakes in sync for tests.
      try {
        location.search = url.search;
      } catch {
        /* read-only locations ignore assignment */
      }
    }
  }

  function applyBoardVisibility(boardIds) {
    const allow = boardIds ? new Set(boardIds) : null;
    for (const path of paths) {
      const id = path.dataset.boardId;
      const visible = !allow || allow.has(id);
      path.hidden = !visible;
      if (allow && visible) path.setAttribute("data-neighborhood-filtered", "true");
      else path.removeAttribute("data-neighborhood-filtered");
    }
    for (const detail of details) {
      const id = detail.dataset.boardDetail;
      if (!allow) {
        detail.hidden = detail.dataset.boardDetail !== root.dataset.selectedBoard;
        continue;
      }
      detail.hidden = !allow.has(id);
    }
    for (const row of rows) {
      const id = row.id.replace(/^board-/, "");
      row.hidden = Boolean(allow) && !allow.has(id);
      const classes = new Set(String(row.className || "").split(/\s+/).filter(Boolean));
      if (allow && allow.has(id)) classes.add("is-neighborhood-match");
      else classes.delete("is-neighborhood-match");
      row.className = [...classes].join(" ");
    }
  }

  function renderSelection(selection) {
    currentSelection = selection;
    entry.dataset.selectedGeo = selection.geo || "";
    if (select && selection.geo) select.value = selection.geo;
    if (select && !selection.selected) select.value = "";

    if (selection.recovery?.reason === "association_load_failed") {
      entry.dataset.associationState = "failed";
      if (results) results.hidden = true;
      let failure = entry.querySelector("[data-board-neighborhood-failure]");
      if (!failure) {
        failure = entry.ownerDocument.createElement("p");
        failure.className = "scorecard-neighborhood-failure";
        failure.dataset.boardNeighborhoodFailure = "";
        failure.setAttribute("role", "status");
        entry.insertBefore(failure, entry.querySelector("[data-board-neighborhood-form]") || null);
      }
      failure.textContent = selection.recovery.explanation;
      let retry = entry.querySelector("[data-board-neighborhood-retry]");
      if (!retry) {
        retry = entry.ownerDocument.createElement("a");
        retry.className = "scorecard-neighborhood-retry";
        retry.dataset.boardNeighborhoodRetry = "";
        retry.href = BOARD_NEIGHBORHOOD_DIRECTORY_BASE;
        retry.textContent = "Try loading neighborhood choices again";
        failure.insertAdjacentElement("afterend", retry);
      }
      applyBoardVisibility(null);
      return;
    }

    entry.dataset.associationState = "ready";
    const failure = entry.querySelector("[data-board-neighborhood-failure]");
    if (failure) failure.remove();
    const retry = entry.querySelector("[data-board-neighborhood-retry]");
    if (retry) retry.remove();

    const boardIds = visibleBoardIdsForSelection(selection);
    applyBoardVisibility(boardIds);

    if (!results || !resultsHeading || !choices) return;
    if (!selection.selected) {
      results.hidden = true;
      if (clearLink) clearLink.hidden = true;
      if (addressSlot) addressSlot.innerHTML = "";
      return;
    }
    results.hidden = false;
    if (clearLink) clearLink.hidden = false;
    resultsHeading.textContent = boardNeighborhoodSelectionHeading(selection);
    choices.innerHTML = selection.boards.length
      ? selection.boards.map(renderBoardChoiceCard).join("")
      : "<li class=\"scorecard-muted\">No published community board overlaps this place.</li>";

    if (addressSlot) {
      addressSlot.innerHTML = selection.boards.length > 1
        ? `<p class="scorecard-neighborhood-address-action">
        <a href="#board-neighborhood-address" data-board-address-action>Find the board for a specific address</a>
        <span class="scorecard-muted">Use an exact address when a neighborhood overlaps more than one board.</span>
      </p>`
        : "";
    }
  }

  function selectGeo(geo, { syncUrl = true } = {}) {
    const selection = resolveBoardNeighborhoodSelection(geo, activeAssociations);
    if (syncUrl) writeGeo(selection.ok && selection.selected ? selection.geo : null);
    renderSelection(selection);
    return selection;
  }

  async function retryAssociations() {
    if (typeof fetchAssociations !== "function") {
      selectGeo(parseGeographyNavigationState(location.href || location.search || "").geo);
      return;
    }
    try {
      const next = await fetchAssociations();
      if (!next || next.load_failed) throw new Error("association_load_failed");
      activeAssociations = next;
      selectGeo(parseGeographyNavigationState(location.href || location.search || "").geo);
    } catch {
      activeAssociations = associationsFromBoardNeighborhoodSource({}, { loadFailed: true });
      selectGeo(parseGeographyNavigationState(location.href || location.search || "").geo);
    }
  }

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      selectGeo(select?.value || "");
    });
  }
  if (select) {
    select.addEventListener("change", () => {
      selectGeo(select.value || "");
    });
    select.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      selectGeo(select.value || "");
    });
  }
  if (clearLink) {
    clearLink.addEventListener("click", (event) => {
      event.preventDefault();
      selectGeo("");
    });
  }
  entry.addEventListener("click", (event) => {
    const retry = event.target.closest?.("[data-board-neighborhood-retry]");
    if (!retry) return;
    event.preventDefault();
    retryAssociations();
  });

  if (!activeAssociations || activeAssociations.load_failed) {
    renderSelection(resolveBoardNeighborhoodSelection(
      parseGeographyNavigationState(location.href || location.search || "").geo,
      associationsFromBoardNeighborhoodSource({}, { loadFailed: true }),
    ));
  } else {
    selectGeo(parseGeographyNavigationState(location.href || location.search || "").geo, { syncUrl: false });
  }

  return Object.freeze({
    selectGeo,
    retryAssociations,
    getSelection: () => currentSelection,
    getAssociations: () => activeAssociations,
  });
}

export {
  GEOGRAPHY_NAVIGATION_GEO_PARAM,
  parseGeographyNavigationState,
  esc,
};
