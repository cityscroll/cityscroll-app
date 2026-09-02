/**
 * Land Map selection state.
 *
 * One canonical `project_id` naming a row the current filter already produced. It is
 * presentation state twice over: it never narrows the result set, and it is never serialized
 * into the shareable Land route, so a copied Map link still describes a filtered population
 * rather than one resident's last click.
 *
 * Selection lives on the history entry, and the history entry is the only copy.
 *
 * `history.state` is per-entry and is not part of what a resident copies, shares, or saves as a
 * watch, which is exactly the property this needs: the URL beside it still describes only the
 * filtered population and the view. Putting the id in the query instead would make a shared Map
 * link carry one resident's click, and would push a presentation key through a scope serializer
 * that deliberately refuses to carry one.
 *
 * It is the only copy because the canonical project route is a document of its own: following a
 * marker's detail action leaves the browse document and Back reloads it, so a selection kept in
 * a module variable would not survive the round trip this state exists to make reversible.
 * Reading the entry every time also means the route and the map can never hold different
 * answers about which project is selected.
 *
 * This module is pure. It decides what a remembered id means; it owns no history object, no
 * renderer, and no request.
 */

import { landProjectPath } from "./land_project_route.mjs";

export const LAND_MAP_SELECTION_SCHEMA = "cityscroll.land_map_selection.v1";

/** The history-state key. Deliberately not a route key: see the module note above. */
export const LAND_MAP_SELECTION_HISTORY_KEY = "landSelection";

/**
 * Read the selection a history entry remembers.
 *
 * A remembered id is a request, never a result. It is accepted here only if it is shaped like a
 * canonical project id; whether the current filter actually holds that project is a question
 * only a painted model can answer, and `nextLandMapSelection` answers it.
 *
 * @param {unknown} state a `history.state` value
 * @returns {string|null}
 */
export function landSelectionFromHistoryState(state) {
  const route = state && typeof state === "object" && !Array.isArray(state)
    ? state.cityscrollRoute
    : null;
  const remembered = route && typeof route === "object" ? route[LAND_MAP_SELECTION_HISTORY_KEY] : null;
  const id = String(remembered ?? "").trim();
  return id && landProjectPath(id) ? id : null;
}

/**
 * The history-state patch that remembers, or forgets, one selection.
 *
 * @param {unknown} projectId
 * @returns {{landSelection: string|null}}
 */
export function landSelectionHistoryPatch(projectId) {
  const id = String(projectId ?? "").trim();
  return { [LAND_MAP_SELECTION_HISTORY_KEY]: id && landProjectPath(id) ? id : null };
}

/**
 * What the selection is after a paint, given what the paint actually showed.
 *
 * The Map model refuses a selection whose project the current filter does not hold, so a paint
 * that came back without one is the model reporting that the id has left scope. Forgetting it
 * then is what stops a filtered-out project from reappearing, selected, the moment the resident
 * widens the filter again -- a selection the resident never re-made.
 *
 * Silence is not a verdict. A paint with no rows behind it -- the cold `view=map` load, before
 * the search has returned -- has not decided anything about this project, so the remembered id
 * survives it. Treating that as a refusal would drop the selection on every cold Map load, which
 * is exactly the trip back from a project detail.
 *
 * @param {{requested?: unknown, painted?: unknown, population?: unknown}} input
 * @returns {string|null}
 */
export function nextLandMapSelection({ requested, painted, population } = {}) {
  const id = String(requested ?? "").trim();
  if (!id) return null;
  const rows = Number(population);
  if (!Number.isFinite(rows) || rows <= 0) return id;
  return String(painted ?? "").trim() === id ? id : null;
}

/**
 * Where focus belongs after the next Map paint.
 *
 * `selection` follows an activation: the resident asked for something and it appeared, so focus
 * moves to it. `marker` is the return trip, putting focus back on the control that sent the
 * resident away. `panel` is the floor: a cleared selection has no control to hold focus, and
 * the panel is where it goes instead of the document root.
 *
 * @param {{projectId?: unknown, kind?: "selection"|"marker"}} input
 * @returns {{kind: "selection"|"marker"|"panel", projectId?: string}}
 */
export function landMapSelectionFocusIntent({ projectId, kind = "selection" } = {}) {
  const id = String(projectId ?? "").trim();
  if (!id) return { kind: "panel" };
  return { kind: kind === "marker" ? "marker" : "selection", projectId: id };
}
