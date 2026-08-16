import {
  browseListParams,
  browseListShareSearch,
  filterConfiguredBrowseRows,
  PEOPLE_ORGANIZATIONS_BROWSE_CONFIG,
} from "./browse_list_contract.mjs";
import { renderBrowseView } from "./browse_view.mjs";
import { buildPeopleListBrowseView } from "./browse_reuse_surfaces.mjs";

const root = document.querySelector("[data-people-organizations]");
const input = root?.querySelector("[data-people-organizations-search]");
const type = root?.querySelector("[data-people-organizations-type]");
const summary = root?.querySelector("[data-people-organizations-search-summary]");
const empty = root?.querySelector("[data-people-organizations-no-results]");
const list = root?.querySelector("[data-people-organizations-list]");
const more = root?.querySelector("[data-people-organizations-more]");
const modelScript = root?.querySelector("[data-people-organizations-model]");

function readModel() {
  if (!modelScript) return { rows: [] };
  try {
    const model = JSON.parse(modelScript.textContent || "{}");
    return model && typeof model === "object" ? model : { rows: [] };
  } catch {
    return { rows: [] };
  }
}

function updateShareState() {
  const params = browseListShareSearch({ query: input?.value, facet: type?.value });
  const url = new URL(location.href);
  url.searchParams.delete(PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.queryParam);
  url.searchParams.delete(PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.facetParam);
  for (const [key, value] of params) url.searchParams.set(key, value);
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

if (root && input && type && summary && empty && list) {
  const model = readModel();
  const allRows = Array.isArray(model.rows) ? model.rows : [];
  const initialSummary = summary.textContent;
  let activeRows = allRows;
  let filtered = [];
  let shownLimit = PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.initialPageSize;

  function updateSummary({ shownCount = null } = {}) {
    const { query, facet } = browseListParams(location.search, PEOPLE_ORGANIZATIONS_BROWSE_CONFIG);
    const constrained = Boolean(query || facet);
    if (!constrained) {
      summary.textContent = shownCount == null
        ? initialSummary
        : `Showing ${shownCount.toLocaleString("en-US")} of ${activeRows.length.toLocaleString("en-US")} typed rows`;
    } else {
      summary.textContent = `${filtered.length.toLocaleString("en-US")} matching typed row${filtered.length === 1 ? "" : "s"}`;
      if (shownCount != null && filtered.length > shownCount) {
        summary.textContent = `Showing ${shownCount.toLocaleString("en-US")} of ${filtered.length.toLocaleString("en-US")} matching typed rows`;
      }
    }
  }

  function render({ reset = false, canonicalize = false } = {}) {
    filtered = filterConfiguredBrowseRows(allRows, location.search, PEOPLE_ORGANIZATIONS_BROWSE_CONFIG);
    activeRows = filtered;
    const { facet } = browseListParams(location.search, PEOPLE_ORGANIZATIONS_BROWSE_CONFIG);
    if (type.value !== facet) type.value = facet;
    const { query } = browseListParams(location.search, PEOPLE_ORGANIZATIONS_BROWSE_CONFIG);
    if (input.value !== query) input.value = query;
    if (canonicalize) updateShareState();
    if (reset) shownLimit = PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.initialPageSize;
    list.dataset.browseListStatus = model.generated_at ? (allRows.length ? "published" : "empty") : "unknown";
    list.innerHTML = renderBrowseView(buildPeopleListBrowseView(model, location.search, { limit: shownLimit }));
    const shownCount = Math.min(shownLimit, filtered.length);
    if (more) {
      const remaining = Math.max(0, filtered.length - shownCount);
      more.hidden = remaining === 0;
      more.textContent = remaining ? `Show more (${remaining.toLocaleString("en-US")})` : "Show more";
    }
    updateSummary({ shownCount });
    empty.hidden = filtered.length !== 0;
  }

  input.addEventListener("input", () => {
    updateShareState();
    render({ reset: true });
  });
  type.addEventListener("change", () => {
    updateShareState();
    render({ reset: true });
  });
  more?.addEventListener("click", () => {
    shownLimit += PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.pageSize;
    render();
  });
  root.querySelector("[data-people-organizations-search-form]")?.addEventListener("submit", (event) => event.preventDefault());
  render({ canonicalize: true });
}
