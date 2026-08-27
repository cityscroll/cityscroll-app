// Keep the universal Search document, its capability projection, and their
// transitive graph behind the Search route's own code-split boundary.
function showSearchLoadingState() {
  const root = document.querySelector("[data-search-document]");
  if (!root || !new URLSearchParams(location.search).get("q")) return;
  root.querySelector("[data-semantic-lanes]")?.removeAttribute("hidden");
  root.querySelector("[data-keyword-lanes]")?.setAttribute("hidden", "");
  const status = root.querySelector("[data-search-coverage]");
  if (status) {
    status.className = "topic-search-coverage is-loading";
    status.dataset.coverageState = "loading";
    status.removeAttribute("hidden");
    status.setAttribute("aria-busy", "true");
    status.innerHTML = '<p><span class="loading" aria-hidden="true"></span><strong>Searching…</strong></p>';
  }
  for (const lane of root.querySelectorAll("[data-semantic-family] .topic-search-lane-body")) {
    lane.textContent = "Searching…";
    lane.setAttribute("aria-busy", "true");
  }
}

function loadSearchDocument() {
  showSearchLoadingState();
  requestAnimationFrame(() => setTimeout(() => import("./search_document.mjs"), 0));
}

if (location.pathname === "/search" || location.pathname === "/search/") {
  if (document.readyState === "loading") {
    showSearchLoadingState();
    document.addEventListener("DOMContentLoaded", loadSearchDocument, { once: true });
  } else {
    loadSearchDocument();
  }
}
