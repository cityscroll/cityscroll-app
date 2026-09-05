/**
 * Result-family jump control for /search/.
 *
 * A compact, keyboard-operable list of the result-family headings already
 * rendered on the page. Choosing an item moves keyboard focus to that
 * family's existing heading. It never issues a search, changes the query,
 * or reads anything beyond the DOM state the page already painted — every
 * label shown here is copied verbatim from the family section it describes,
 * so the control cannot invent a count or a state the section does not
 * already show.
 */

const MAX_LABEL_LENGTH = 80;
const MAX_STATUS_LENGTH = 80;
const MAX_ID_LENGTH = 80;
export const FAMILY_NAV_STATES = Object.freeze(["", "loading", "error"]);

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Read the truthful per-family state already applied to a lane body's className. */
export function laneStateFromBodyClassName(className) {
  const value = String(className || "");
  if (value.includes("is-loading")) return "loading";
  if (value.includes("is-error")) return "error";
  return "";
}

/**
 * Validate and sanitize one lane's already-rendered state into a nav item.
 * Returns null for a lane missing the minimum a jump target needs (an id,
 * a focus target, and a label) rather than rendering a broken control.
 */
export function familyNavItemFromLane(lane) {
  if (!lane) return null;
  const id = clean(lane.id, MAX_ID_LENGTH);
  const headingId = clean(lane.headingId, MAX_ID_LENGTH);
  const label = clean(lane.label, MAX_LABEL_LENGTH);
  if (!id || !headingId || !label) return null;
  const statusText = clean(lane.statusText, MAX_STATUS_LENGTH);
  const state = FAMILY_NAV_STATES.includes(lane.state) ? lane.state : "";
  return { id, headingId, label, statusText, state };
}

export function familyNavItemsFromLanes(lanes) {
  return (Array.isArray(lanes) ? lanes : []).map(familyNavItemFromLane).filter(Boolean);
}

/** Read one already-rendered `.topic-search-lane` section's current truth. */
export function laneDescriptorFromSection(section) {
  if (!section) return null;
  const heading = section.querySelector("h3");
  const status = section.querySelector(".topic-search-lane-status");
  const body = section.querySelector(".topic-search-lane-body");
  return {
    id: section.dataset?.semanticFamily || section.dataset?.searchLane || "",
    headingId: heading?.id || "",
    label: heading?.textContent || "",
    statusText: status?.textContent || "",
    state: laneStateFromBodyClassName(body?.className),
  };
}

/**
 * The one lane group the reader is actually looking at. Only the semantic
 * lanes or the keyword lanes are ever visible at once (see search_document.mjs
 * paintResults); an individually hidden section within it (a narrowed scope,
 * for instance) is excluded the same way it is excluded from view.
 */
export function visibleLaneSections(root) {
  if (!root) return [];
  const semantic = root.querySelector("[data-semantic-lanes]");
  const container = semantic && !semantic.hasAttribute("hidden")
    ? semantic
    : root.querySelector("[data-keyword-lanes]");
  if (!container || container.hasAttribute("hidden")) return [];
  return [...container.querySelectorAll(".topic-search-lane")]
    .filter((section) => !section.hasAttribute("hidden"));
}

/** Move keyboard focus to an existing result-family heading. No search, no navigation. */
export function activateFamilyNavHeading(heading) {
  if (!heading) return false;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus();
  heading.scrollIntoView?.({ block: "start", behavior: "smooth" });
  return true;
}

/**
 * Rebuild the jump list from the currently visible lane sections. Each
 * button's click handler closes over the section's own heading element, so
 * activation never depends on an id lookup and can never target a family
 * other than the one whose label and state it displays.
 */
export function renderFamilyNav(root, doc = root?.ownerDocument || globalThis.document) {
  const nav = root?.querySelector?.("[data-search-family-nav]");
  const list = nav?.querySelector?.("[data-search-family-nav-list]");
  if (!nav || !list || !doc) return [];
  const sections = visibleLaneSections(root);
  const items = [];
  list.replaceChildren();
  for (const section of sections) {
    const heading = section.querySelector("h3");
    const item = familyNavItemFromLane(laneDescriptorFromSection(section));
    if (!item || !heading) continue;
    items.push(item);
    const li = doc.createElement("li");
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "topic-search-family-nav-item";
    if (item.state) button.dataset.state = item.state;
    button.addEventListener("click", (event) => {
      event.preventDefault?.();
      activateFamilyNavHeading(heading);
    });
    const label = doc.createElement("span");
    label.className = "topic-search-family-nav-label";
    label.textContent = item.label;
    const status = doc.createElement("span");
    status.className = "topic-search-family-nav-status";
    status.textContent = item.statusText;
    button.append(label, status);
    li.append(button);
    list.append(li);
  }
  nav.hidden = items.length === 0;
  return items;
}
