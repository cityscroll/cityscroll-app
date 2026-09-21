import { bindCompactMonthCalendar } from "./compact_calendar.mjs";

const root = typeof document === "undefined" ? null : document.querySelector("[data-observe-root]");

function detailLoader(facts) {
  const url = new URL(facts.href, globalThis.location?.origin || "https://cityscroll.org");
  url.searchParams.set("preview", "1");
  return fetch(url, { headers: { Accept: "application/json" } }).then((response) => {
    if (!response.ok) throw new Error(`detail status ${response.status}`);
    return response.json();
  });
}

function currentObserveUrl() {
  const url = new URL(globalThis.location.href);
  const selected = root?.querySelector?.("[data-observe-id]")?.getAttribute("data-observe-id");
  if (selected) url.searchParams.set("selection", selected);
  if (globalThis.scrollY) url.searchParams.set("scroll", String(Math.round(globalThis.scrollY)));
  url.searchParams.set("focus", "selection");
  return `${url.pathname}${url.search}`;
}

function rememberDetailReturn(event) {
  const link = event.target?.closest?.(".observe-detail, .compact-month-occ-full-record, .compact-month-occ-link");
  if (!link || !root || !root.contains(link) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = link.getAttribute("href");
  if (!href || !/^\/meetings\//.test(href)) return;
  const destination = new URL(href, globalThis.location.href);
  destination.searchParams.set("return_to", currentObserveUrl());
  link.setAttribute("href", `${destination.pathname}${destination.search}`);
  const current = history.state && typeof history.state === "object" ? history.state : {};
  history.replaceState({ ...current, observeReturn: { href: currentObserveUrl(), focus: "selection", scroll: Math.round(globalThis.scrollY || 0) } }, "", globalThis.location.href);
}

function restoreReturn() {
  const state = history.state?.observeReturn;
  if (!state || !root) return;
  if (Number.isFinite(state.scroll)) globalThis.scrollTo?.(0, state.scroll);
  root.querySelector("[data-observe-heading]")?.focus?.({ preventScroll: true });
}

if (root) {
  root.addEventListener("click", rememberDetailReturn);
  bindCompactMonthCalendar(root, { loadDetail: detailLoader });
  globalThis.addEventListener?.("pageshow", restoreReturn);
}
