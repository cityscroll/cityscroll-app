/**
 * Browser enhancement for the public-body directory.
 *
 * The static document already lists every institution, so this file only
 * narrows what is shown. It never creates a destination, and it never removes
 * one from the document — a row it hides is still in the markup, and a reader
 * without scripting sees the whole directory rather than an empty page.
 *
 * The state a reader builds up is kept in the URL, which is what makes it
 * survive: a shared link, a reload, opening a profile and pressing Back, and a
 * restored session all replay the same query and group. The row a reader
 * opened is remembered for this page only, so returning puts focus back where
 * they left instead of at the top of the document.
 */

import {
  AGENCY_DIRECTORY_CONFIG,
  agencyDirectoryParams,
  agencyDirectoryShareSearch,
  agencyDirectorySummary,
} from "./agency_directory_contract.mjs";

const directory = document.querySelector("[data-agency-directory]");
const form = directory?.querySelector("[data-directory-form]");
const input = directory?.querySelector("[data-directory-query]");
const summary = directory?.querySelector("[data-directory-summary]");
const empty = directory?.querySelector("[data-directory-empty]");
const clear = directory?.querySelector("[data-directory-clear]");

if (directory && form && input && summary && empty) {
  const groupLinks = [...directory.querySelectorAll("[data-directory-group]")];
  const sections = [...directory.querySelectorAll("[data-directory-section]")];
  const rows = [...directory.querySelectorAll("[data-directory-row]")].map((element) => ({
    element,
    canonicalId: element.getAttribute("data-canonical-id") || "",
    haystack: ` ${element.getAttribute("data-haystack") || ""}`,
    group: element.getAttribute("data-group") || "",
    secondary: (element.getAttribute("data-secondary-groups") || "").split(" ").filter(Boolean),
  }));
  const groupIds = groupLinks.map((link) => link.getAttribute("data-directory-group")).filter(Boolean);
  const groupLabels = new Map(groupLinks.map((link) => [
    link.getAttribute("data-directory-group") || "",
    (link.textContent || "").replace(/\s+\d+\s*$/, "").trim(),
  ]));
  const total = rows.length;
  const focusKey = `cityscroll:agency-directory:focus:${location.pathname}`;

  function foldQuery(value) {
    return String(value ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ")
      .replace(/[’']/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  // A token matches the start of a word, never the middle of one, so one
  // body's shorthand cannot pull in another body whose name contains it.
  function keeps(row, tokens, group) {
    if (group && row.group !== group && !row.secondary.includes(group)) return false;
    return tokens.every((token) => row.haystack.includes(` ${token}`));
  }

  function apply(state, { announce = true } = {}) {
    const tokens = foldQuery(state.query).split(" ").filter(Boolean);
    let matched = 0;
    for (const row of rows) {
      const keep = keeps(row, tokens, state.group);
      row.element.hidden = !keep;
      if (keep) matched += 1;
    }
    for (const section of sections) {
      const id = section.getAttribute("data-directory-section");
      const visible = rows.filter((row) => row.element.closest("[data-directory-section]") === section
        && !row.element.hidden).length;
      section.hidden = visible === 0;
      const count = section.querySelector(`[data-directory-section-count="${CSS.escape(id)}"]`);
      if (count) count.textContent = String(visible);
    }
    for (const link of groupLinks) {
      const id = link.getAttribute("data-directory-group") || "";
      if (id === state.group) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
    const text = agencyDirectorySummary({
      matched,
      total,
      query: state.query,
      groupLabel: groupLabels.get(state.group) === "All" ? "" : groupLabels.get(state.group) || "",
    });
    if (announce || summary.textContent !== text) summary.textContent = text;
    empty.hidden = matched !== 0;
    return matched;
  }

  function stateFromUrl() {
    return agencyDirectoryParams(location.search, groupIds);
  }

  function writeUrl(state, { replace = true } = {}) {
    const url = new URL(location.href);
    url.search = agencyDirectoryShareSearch(state, groupIds).toString();
    const next = `${url.pathname}${url.search}`;
    const method = replace ? "replaceState" : "pushState";
    history[method](history.state, "", next);
  }

  let state = stateFromUrl();
  input.value = state.query;
  apply(state, { announce: false });

  // A submit without scripting is a real navigation; here it is the same state
  // change, kept on the page so the reader does not lose their place.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    state = { ...state, query: input.value.trim() };
    writeUrl(state);
    apply(state);
  });

  let typing = 0;
  input.addEventListener("input", () => {
    globalThis.clearTimeout(typing);
    typing = globalThis.setTimeout(() => {
      state = { ...state, query: input.value.trim() };
      writeUrl(state);
      apply(state);
    }, 150);
  });

  clear?.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    state = { query: "", group: "" };
    input.value = "";
    writeUrl(state);
    apply(state);
    input.focus();
  });

  for (const link of groupLinks) {
    link.addEventListener("click", (event) => {
      // A modified click is the browser's: it opens the group's own URL in a
      // separate context, where this same enhancement reads it back.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      state = { ...state, group: link.getAttribute("data-directory-group") || "" };
      writeUrl(state);
      apply(state);
    });
  }

  // Remember which destination was opened, so Back restores the reader's place
  // in the list rather than the top of the page.
  directory.addEventListener("click", (event) => {
    const anchor = event.target.closest?.("a.agency-index-link");
    const row = anchor?.closest("[data-directory-row]");
    if (!row) return;
    try {
      sessionStorage.setItem(focusKey, row.getAttribute("data-canonical-id") || "");
    } catch {
      // A browser that refuses session storage still navigates; only the
      // focus restoration below is lost, and never the destination.
    }
  });

  function restoreFocus() {
    let canonicalId = "";
    try {
      canonicalId = sessionStorage.getItem(focusKey) || "";
      sessionStorage.removeItem(focusKey);
    } catch {
      canonicalId = "";
    }
    if (!canonicalId) return;
    const row = directory.querySelector(`[data-canonical-id="${CSS.escape(canonicalId)}"]`);
    const anchor = row && !row.hidden ? row.querySelector("a.agency-index-link") : null;
    if (!anchor) return;
    anchor.focus({ preventScroll: true });
  }

  // Back can arrive as a restored page or as a history entry on the live one.
  // Both re-read the URL, so the reader returns to the state they left.
  globalThis.addEventListener("pageshow", () => {
    state = stateFromUrl();
    input.value = state.query;
    apply(state, { announce: false });
    restoreFocus();
  });
  globalThis.addEventListener("popstate", () => {
    state = stateFromUrl();
    input.value = state.query;
    apply(state, { announce: false });
  });
}
