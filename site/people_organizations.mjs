import {
  browseListParams,
  browseListShareSearch,
  PEOPLE_ORGANIZATIONS_BROWSE_CONFIG,
} from "./browse_list_contract.mjs";
import { renderBrowseView } from "./browse_view.mjs";
import {
  buildPeopleListCapabilityPage,
  buildPeopleListBrowseView,
} from "./people_organizations_surface.mjs";
import {
  parseSearchLensHandoff,
  renderSearchLensHandoffHtml,
} from "./search_lens_handoff.mjs";

const root = document.querySelector("[data-people-organizations]");
const input = root?.querySelector("[data-people-organizations-search]");
const type = root?.querySelector("[data-people-organizations-type]");
const institution = root?.querySelector("[data-people-organizations-institution]");
const role = root?.querySelector("[data-people-organizations-role]");
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
  const params = browseListShareSearch({ query: input?.value, facet: type?.value, institution: institution?.value, role: role?.value });
  const url = new URL(location.href);
  url.searchParams.delete(PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.queryParam);
  url.searchParams.delete(PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.facetParam);
  url.searchParams.delete(PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.institutionParam);
  url.searchParams.delete(PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.roleParam);
  for (const [key, value] of params) url.searchParams.set(key, value);
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

if (root && input && type && institution && role && summary && empty && list) {
  const handoff = parseSearchLensHandoff(location.search);
  if (handoff?.destination.surface === "people-organizations") {
    root.insertAdjacentHTML("afterbegin", renderSearchLensHandoffHtml(handoff, { t: globalThis.t }));
  }
  const model = readModel();
  const allRows = Array.isArray(model.rows) ? model.rows : [];
  const initialSummary = summary.textContent;
  let filteredCount = allRows.length;
  let shownLimit = PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.initialPageSize;

  function updateSummary({ shownCount = null } = {}) {
    const { query, facet, institution: institutionFilter, role: roleFilter } = browseListParams(location.search, PEOPLE_ORGANIZATIONS_BROWSE_CONFIG);
    const constrained = Boolean(query || facet || institutionFilter || roleFilter);
    if (!constrained) {
      summary.textContent = shownCount == null
        ? initialSummary
        : `Showing ${shownCount.toLocaleString("en-US")} of ${allRows.length.toLocaleString("en-US")} typed rows`;
    } else {
      summary.textContent = `${filteredCount.toLocaleString("en-US")} matching typed row${filteredCount === 1 ? "" : "s"}`;
      if (shownCount != null && filteredCount > shownCount) {
        summary.textContent = `Showing ${shownCount.toLocaleString("en-US")} of ${filteredCount.toLocaleString("en-US")} matching typed rows`;
      }
    }
  }

  function render({ reset = false, canonicalize = false } = {}) {
    if (reset) shownLimit = PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.initialPageSize;
    const { query, facet, institution: institutionFilter, role: roleFilter } = browseListParams(location.search, PEOPLE_ORGANIZATIONS_BROWSE_CONFIG);
    if (type.value !== facet) type.value = facet;
    if (institution.value !== institutionFilter) institution.value = institutionFilter;
    if (role.value !== roleFilter) role.value = roleFilter;
    if (input.value !== query) input.value = query;
    // Hydrate the controls from the incoming document URL before rewriting it;
    // otherwise a legacy deep link such as #people?q=RODRIGUEZ is erased by
    // canonicalization before the shared capability sees its query.
    if (canonicalize) updateShareState();
    const capabilityResult = buildPeopleListCapabilityPage(model, location.search, { limit: shownLimit });
    filteredCount = capabilityResult.total_matches;
    list.dataset.browseListStatus = model.generated_at ? (allRows.length ? "published" : "empty") : "unknown";
    list.innerHTML = renderBrowseView(buildPeopleListBrowseView(model, location.search, {
      limit: shownLimit,
      capabilityResult,
    }));
    const shownCount = Math.min(shownLimit, filteredCount);
    if (more) {
      const remaining = Math.max(0, filteredCount - shownCount);
      more.hidden = remaining === 0;
      more.textContent = remaining ? `Show more (${remaining.toLocaleString("en-US")})` : "Show more";
    }
    updateSummary({ shownCount });
    empty.hidden = filteredCount !== 0;
  }

  input.addEventListener("input", () => {
    updateShareState();
    render({ reset: true });
  });
  type.addEventListener("change", () => {
    updateShareState();
    render({ reset: true });
  });
  institution.addEventListener("change", () => {
    updateShareState();
    render({ reset: true });
  });
  role.addEventListener("change", () => {
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
