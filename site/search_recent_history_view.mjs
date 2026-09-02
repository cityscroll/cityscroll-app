/**
 * Recent-search presentation for the canonical Search document.
 *
 * A compact secondary continuation under the search action: it renders the
 * bounded local entries owned by `site/search_recent_history.mjs`, never fetches
 * anything, and never renders a result. Rerun is an ordinary same-origin link to
 * the canonical Search path, so reopening an entry executes Search normally
 * instead of replaying a stored answer.
 *
 * Empty history is quiet: the section stays hidden and announces nothing. Remove
 * and clear take effect immediately, move focus somewhere a keyboard reader can
 * continue from, and report what happened through one polite status region that
 * survives the section being hidden.
 */

import { SEARCH_RECENT_SCOPE_LABELS } from "./search_recent_history.mjs";

const SCOPE_SEPARATOR = " · ";

function fallbackTranslate(_key, vars, fallback) {
  if (!vars) return fallback;
  return Object.entries(vars).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    fallback,
  );
}

/** Resident place context for one entry, read from its canonical path. */
export function recentSearchScopeSummary(scope) {
  return Object.entries(SEARCH_RECENT_SCOPE_LABELS)
    .map(([key, label]) => (scope?.[key] ? `${label}: ${scope[key]}` : null))
    .filter(Boolean)
    .join(SCOPE_SEPARATOR);
}

function regionParts(region) {
  return {
    section: region?.querySelector("[data-search-recent]") || null,
    list: region?.querySelector("[data-search-recent-list]") || null,
    status: region?.querySelector("[data-search-recent-status]") || null,
    clear: region?.querySelector("[data-search-recent-clear]") || null,
  };
}

function announce(status, message) {
  if (status) status.textContent = message || "";
}

function focusFirst(candidates) {
  for (const candidate of candidates) {
    if (candidate && typeof candidate.focus === "function") {
      candidate.focus();
      return true;
    }
  }
  return false;
}

function buildEntry(document, entry, { translate, onRemove }) {
  const item = document.createElement("li");
  item.className = "topic-search-recent-item";
  item.dataset.searchRecentPath = entry.path;

  const run = document.createElement("a");
  run.className = "topic-search-recent-run";
  run.href = entry.path;
  run.dataset.searchRecentRun = "";
  run.setAttribute(
    "aria-label",
    translate("search_recent_rerun_aria", { query: entry.query }, `Search again for ${entry.query}`),
  );

  const query = document.createElement("span");
  query.className = "topic-search-recent-query";
  query.textContent = entry.query;
  run.append(query);

  const summary = recentSearchScopeSummary(entry.scope);
  if (summary) {
    const context = document.createElement("span");
    context.className = "topic-search-recent-scope";
    context.textContent = summary;
    run.append(context);
  }
  item.append(run);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "topic-search-recent-remove";
  remove.dataset.searchRecentRemove = "";
  remove.setAttribute(
    "aria-label",
    translate(
      "search_recent_remove_aria",
      { query: entry.query },
      `Remove ${entry.query} from recent searches`,
    ),
  );
  const glyph = document.createElement("span");
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "×";
  remove.append(glyph);
  remove.addEventListener("click", () => onRemove(entry));
  item.append(remove);

  return item;
}

/**
 * Paint the current history into the Search document.
 *
 * `onRemove` and `onClear` own the persisted state and return the entries that
 * remain; this function repaints from that answer, so the rendered list and the
 * store can never disagree about what a reader just deleted.
 */
export function renderRecentSearches(region, {
  entries = [],
  translate = fallbackTranslate,
  onRemove = () => [],
  onClear = () => [],
  fallbackFocus = null,
} = {}) {
  const { section, list, status, clear } = regionParts(region);
  if (!section || !list) return;
  const document = section.ownerDocument;

  const repaint = (next, message, focusIndex) => {
    renderRecentSearches(region, { entries: next, translate, onRemove, onClear, fallbackFocus });
    announce(status, message);
    // A hidden section can hold no focus, so an emptied list hands it back to
    // the primary search action rather than dropping it on the document.
    const runs = [...list.querySelectorAll("[data-search-recent-run]")];
    if (!runs.length) focusFirst([fallbackFocus]);
    else focusFirst([runs[focusIndex], runs.at(-1), fallbackFocus]);
  };

  list.replaceChildren();
  for (const entry of entries) {
    list.append(buildEntry(document, entry, {
      translate,
      onRemove: (removed) => {
        const index = entries.indexOf(removed);
        repaint(
          onRemove(removed.path),
          translate(
            "search_recent_removed_status",
            { query: removed.query },
            `Removed ${removed.query} from recent searches.`,
          ),
          index,
        );
      },
    }));
  }

  section.hidden = entries.length === 0;
  // Publish how many entries this paint rendered. The Search document already
  // reports its settled state through aria-busy; this is the same idea for the
  // history beside it, so a reader-facing check never has to guess whether the
  // list has painted yet.
  region.dataset.searchRecentCount = String(entries.length);
  if (clear && !clear.dataset.searchRecentBound) {
    clear.dataset.searchRecentBound = "true";
    clear.addEventListener("click", () => {
      const next = onClear();
      renderRecentSearches(region, { entries: next, translate, onRemove, onClear, fallbackFocus });
      announce(
        status,
        translate("search_recent_cleared_status", null, "Recent searches cleared."),
      );
      focusFirst([fallbackFocus]);
    });
  }
}
