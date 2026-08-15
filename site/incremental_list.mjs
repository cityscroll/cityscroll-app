/** Small DOM-only renderer for bounded, incrementally revealed lists. */

export const INCREMENTAL_LIST_PAGE_SIZE = 24;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

/**
 * Create a list controller without knowing anything about the records it renders.
 * The caller owns filtering and row markup; this module owns page growth and the
 * accessible native button that requests it.
 */
export function createIncrementalList({
  container,
  initialPageSize = 16,
  pageSize = INCREMENTAL_LIST_PAGE_SIZE,
  getItems = () => [],
  renderItems = (items) => items.join(""),
  renderEmpty = () => "",
  renderMore = (remaining) => `Show more (${remaining})`,
  moreId = "",
  moreClass = "incremental-list-more",
  onMore = () => {},
} = {}) {
  const firstPageSize = positiveInteger(initialPageSize, 16);
  const growth = positiveInteger(pageSize, INCREMENTAL_LIST_PAGE_SIZE);
  let limit = firstPageSize;

  function render({ items = getItems(), reset = false } = {}) {
    if (reset) limit = firstPageSize;
    const allItems = Array.isArray(items) ? items : [];
    const shown = allItems.slice(0, limit);
    const remaining = Math.max(0, allItems.length - shown.length);
    if (!container) return { allItems, shown, remaining, limit };

    const moreAttributes = [
      'type="button"',
      `class="${moreClass}-button"`,
      'data-incremental-list-more',
      moreId ? `id="${moreId}"` : "",
    ].filter(Boolean).join(" ");
    const more = remaining
      ? `<div class="${moreClass}"><button ${moreAttributes}>${renderMore(remaining)}</button></div>`
      : "";
    container.innerHTML = shown.length
      ? `${renderItems(shown)}${more}`
      : renderEmpty();

    const button = container.querySelector("[data-incremental-list-more]");
    button?.addEventListener("click", () => {
      const previousLimit = limit;
      limit += growth;
      const next = render({ items: getItems() });
      onMore({ ...next, previousLimit });
    });
    return { allItems, shown, remaining, limit };
  }

  return Object.freeze({
    render,
    reset: (items = getItems()) => render({ items, reset: true }),
    get limit() { return limit; },
  });
}
