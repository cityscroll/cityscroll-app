/**
 * Recognized-account search-history island for the canonical Search document.
 *
 * A compact continuation, not a second surface. It reopens canonical Search
 * URLs and does nothing else: no results are stored here, no account is named
 * here, and it is never a navigation destination of its own.
 *
 * Only a recognized reader with remembered searches renders anything to act on.
 * Anonymous, unavailable, and failed states render NOTHING — a reader whose
 * session is gone keeps ordinary Search plus whatever their own browser
 * remembers, and is not asked to sign in a second time to read a convenience.
 *
 * This module is pure: it maps a state and a list of entries to markup. The
 * network, the DOM, and the session all live outside it.
 */

export const SEARCH_HISTORY_UI_STATES = Object.freeze([
  "loading",
  "unrecognized",
  "empty",
  "recognized",
  "unavailable",
  "error",
]);

const HEADING = "Your recent searches";
const EMPTY_MESSAGE =
  "Searches you run while your email link recognizes you will show up here, on any device you open with the same link.";
const RECOGNIZED_MESSAGE =
  "Searches you ran while your email link recognized you. Open one to run it again.";

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

/**
 * Which state one read of the personal endpoint puts the island in.
 * `responseState` is the server's own word for the request; the rest describe
 * what happened to the request itself.
 */
export function searchHistoryUiState({
  loading = false,
  fetchFailed = false,
  responseOk = true,
  responseState = null,
  entryCount = 0,
} = {}) {
  if (loading) return "loading";
  if (fetchFailed) return "error";
  if (responseState === "unrecognized") return "unrecognized";
  if (responseOk === false || responseState === "unavailable") return "unavailable";
  if (responseState !== "recognized") return "loading";
  return Number(entryCount) > 0 ? "recognized" : "empty";
}

/** The scope a reader can read, in the order the canonical route carries it. */
function scopeLabel(scope) {
  const values = Object.values(scope || {}).filter(Boolean);
  return values.length ? values.join(" · ") : "";
}

/** The UTC day the search ran. Deliberately not reader-local: an account's
 *  history is read from more than one device, and a date that shifts between
 *  them would be reporting the device, not the search. */
function ranOn(occurredAt) {
  const text = String(occurredAt || "");
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 10) : "";
}

function entryHtml(entry) {
  const query = esc(entry.query);
  const place = scopeLabel(entry.scope);
  const day = ranOn(entry.occurred_at);
  return `<li class="topic-search-history-item" data-search-history-entry="${esc(entry.id)}">
    <a class="topic-search-history-link" href="${esc(entry.href)}">${query}</a>
    ${place ? `<span class="topic-search-history-scope">${esc(place)}</span>` : ""}
    ${day ? `<time class="topic-search-history-when" datetime="${esc(entry.occurred_at)}">${esc(day)}</time>` : ""}
    <button type="button" class="topic-search-history-remove" data-search-history-remove="${esc(entry.id)}">Remove<span class="sr-only"> the saved search for ${query}</span></button>
  </li>`;
}

/**
 * The island's markup for one state. An empty string means the island stays
 * hidden, which is the correct answer for every state a reader cannot act on.
 */
export function searchHistoryIslandHtml(state, { entries = [] } = {}) {
  if (state === "empty") {
    return `<h2 class="topic-search-history-heading">${HEADING}</h2>
      <p class="topic-search-history-note">${EMPTY_MESSAGE}</p>`;
  }
  if (state !== "recognized" || !entries.length) return "";
  return `<h2 class="topic-search-history-heading">${HEADING}</h2>
    <p class="topic-search-history-note">${RECOGNIZED_MESSAGE}</p>
    <ul class="topic-search-history-list">${entries.map(entryHtml).join("")}</ul>
    <button type="button" class="topic-search-history-clear" data-search-history-clear>Remove all saved searches</button>`;
}
