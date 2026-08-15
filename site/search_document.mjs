const MAX_QUERY_LENGTH = 240;
const SEARCH_TIMEOUT_MS = 12000;
const SEARCH_API_ORIGIN = "https://api.cityscroll.org";
const SEARCH_API_FALLBACK_ORIGIN = "https://crol-worker.crol-worker.workers.dev";
const LANES = Object.freeze(["contracts", "rules", "meetings", "obligations"]);
const LANE_LABELS = Object.freeze({
  contracts: "Contracts",
  rules: "Rules",
  meetings: "Meetings",
  obligations: "Obligations",
});
const PLACE_KEYS = Object.freeze([
  ["boro", "Borough"],
  ["cd", "Community district"],
  ["council", "Council district"],
  ["neighborhood", "Neighborhood"],
  ["scope", "Area"],
]);

function clean(value, max = MAX_QUERY_LENGTH) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function queryFromLocation() {
  const params = new URLSearchParams(location.search);
  return clean(params.get("q"));
}

function placeFromLocation() {
  const params = new URLSearchParams(location.search);
  return PLACE_KEYS
    .map(([key, label]) => [label, clean(params.get(key), 80)])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join(" · ");
}

function preservePlaceFields(form) {
  const params = new URLSearchParams(location.search);
  for (const [key] of PLACE_KEYS) {
    const value = clean(params.get(key), 80);
    if (!value) continue;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = key;
    input.value = value;
    form.append(input);
  }
}

function apiOrigins() {
  return [...new Set([
    window.CROL_API_ORIGIN || SEARCH_API_ORIGIN,
    window.CROL_API_FALLBACK_ORIGIN || SEARCH_API_FALLBACK_ORIGIN,
  ])];
}

function laneElements(root, lane) {
  const section = root.querySelector(`[data-search-lane="${lane}"]`);
  return {
    section,
    status: section?.querySelector(".topic-search-lane-status"),
    body: section?.querySelector(".topic-search-lane-body"),
  };
}

function setLaneState(root, lane, statusText, bodyText, className = "") {
  const elements = laneElements(root, lane);
  if (elements.status) elements.status.textContent = statusText;
  if (elements.body) {
    elements.body.className = `topic-search-lane-body${className ? ` ${className}` : ""}`;
    elements.body.textContent = bodyText;
  }
}

function resultLink(record) {
  const id = clean(record?.id, 80);
  const href = typeof record?.href === "string" && record.href.startsWith("/notices/")
    ? record.href
    : `/notices/${encodeURIComponent(id)}`;
  return { id, href };
}

function renderResult(record) {
  const article = document.createElement("article");
  article.className = "topic-search-result";
  article.dataset.searchResult = "";
  const heading = document.createElement("h4");
  const link = document.createElement("a");
  const target = resultLink(record);
  link.href = target.href;
  link.textContent = clean(record?.title) || `Notice ${target.id}`;
  heading.append(link);
  article.append(heading);

  const type = document.createElement("p");
  type.className = "topic-search-result-type";
  type.textContent = LANE_LABELS[record?.type] || "Public record";
  article.append(type);

  if (record?.snippet) {
    const snippet = document.createElement("p");
    snippet.className = "topic-search-result-snippet";
    snippet.textContent = clean(record.snippet, 320);
    article.append(snippet);
  }
  return article;
}

function renderResults(root, results) {
  const grouped = Object.fromEntries(LANES.map((lane) => [lane, []]));
  for (const record of results) {
    const lane = grouped[record?.type] ? record.type : "obligations";
    grouped[lane].push(record);
  }
  for (const lane of LANES) {
    const items = grouped[lane];
    const elements = laneElements(root, lane);
    if (!elements.body) continue;
    elements.status.textContent = items.length ? `${items.length} result${items.length === 1 ? "" : "s"}` : "No matches";
    elements.body.className = "topic-search-lane-body";
    elements.body.replaceChildren();
    if (!items.length) {
      elements.body.textContent = `No matching ${LANE_LABELS[lane].toLowerCase()} records were found.`;
      continue;
    }
    const list = document.createElement("div");
    list.className = "topic-search-results";
    for (const record of items) list.append(renderResult(record));
    elements.body.append(list);
  }
}

function renderInitialState(root, query) {
  for (const lane of LANES) {
    setLaneState(root, "" + lane, "Waiting", query ? "Searching public records…" : "Enter a topic to search public records.");
  }
}

async function fetchSearchResults(query) {
  let lastError = null;
  for (const origin of apiOrigins()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${origin}/search?q=${encodeURIComponent(query)}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (response.ok) {
        const payload = await response.json();
        if (!payload || !Array.isArray(payload.results)) throw new Error("invalid search response");
        return payload.results;
      }
      if (response.status !== 404 && response.status < 500) throw new Error(`search HTTP ${response.status}`);
      lastError = new Error(`search HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("search unavailable");
}

async function loadResults(root, query) {
  if (!query) return;
  for (const lane of LANES) setLaneState(root, lane, "Loading", "Searching public records…", "is-loading");
  try {
    renderResults(root, await fetchSearchResults(query));
  } catch {
    for (const lane of LANES) setLaneState(root, lane, "Unavailable", "Search is unavailable right now. Please try again.", "is-error");
  }
}

function render() {
  const root = document.querySelector("[data-search-document]");
  if (!root) return;
  const query = queryFromLocation();
  const heading = root.querySelector("#search-heading");
  const input = root.querySelector("#search-query");
  const context = root.querySelector("[data-search-place]");
  if (heading) heading.textContent = query ? `Results for “${query}”` : "What are you looking for?";
  if (input) input.value = query;
  const place = placeFromLocation();
  if (context && place) {
    context.textContent = `Place context · ${place}`;
    context.hidden = false;
  }
  const form = root.querySelector("[data-search-form]");
  if (form) preservePlaceFields(form);
  renderInitialState(root, query);
  void loadResults(root, query);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render, { once: true });
else render();
