import { constellationLink, filterChip, staticFact } from "./affordance_grammar.mjs";

/**
 * Cardinality-adaptive facet controls: small N uses inline chips; large N uses
 * a searchable typeahead with entity deep-links instead of an option wall.
 */

export const INLINE_FACET_LIMIT = 8;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function defaultEscape(value) {
  return clean(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderCardinalityAdaptiveFacet({
  id,
  label,
  choices = [],
  selectedId = "",
  allLabel = "All",
  allHref = "#",
  entityHref = (choice) => choice.href || "#",
  scopeHref = (choice) => choice.href || "#",
  escape = defaultEscape,
  limit = INLINE_FACET_LIMIT,
} = {}) {
  const safeId = clean(id) || "facet";
  const normalized = choices.filter((choice) => choice?.id && choice?.label);
  const allActive = !selectedId;
  const all = filterChip({ label: allLabel, pressed: allActive, className: "agency-scope-link", attributes: { "data-agency-scope-link": "all", "data-filter-href": allHref }, escape });
  if (normalized.length <= limit) {
    const links = normalized.map((choice) => {
      const active = choice.id === selectedId;
      return filterChip({ label: choice.label, pressed: active, className: "agency-scope-link", attributes: { "data-agency-scope-link": choice.id, "data-filter-href": scopeHref(choice), "data-scope-edge": choice.scopeEdge }, escape });
    }).join("");
    return `<div class="agency-scope-links cardinality-facet cardinality-facet-small" data-cardinality-facet="small" role="group" aria-label="${escape(label)}">${all}${links}</div>`;
  }

  const listId = `${safeId}-matches`;
  const rows = normalized.map((choice, index) => {
    const active = choice.id === selectedId;
    return `<li class="facet-typeahead-option" data-facet-option data-facet-label="${escape(choice.label.toLocaleLowerCase())}"${index >= 5 && !active ? " hidden" : ""}>
      ${constellationLink({ href: entityHref(choice), label: choice.label, className: "facet-entity-link", attributes: { "data-agency-entity-link": choice.id }, escape })}
      ${filterChip({ label: active ? "Filtered" : "Filter", pressed: active, attributes: { "data-agency-scope-link": choice.id, "data-filter-href": scopeHref(choice), "data-scope-edge": choice.scopeEdge }, escape })}
    </li>`;
  }).join("");
  return `<div class="cardinality-facet cardinality-facet-large" data-cardinality-facet="large">
    <div class="facet-typeahead-head">${all}<input type="search" class="facet-typeahead-input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${escape(listId)}" aria-label="${escape(`Type to filter ${label.toLocaleLowerCase()}`)}" placeholder="${escape(`Type to filter ${label.toLocaleLowerCase()}`)}"></div>
    <ul class="facet-typeahead-list" id="${escape(listId)}" data-facet-results aria-label="${escape(`${label} matches`)}">${rows}</ul>
    <p class="facet-typeahead-empty" data-facet-empty hidden>${staticFact({ label: `No matching ${label.toLocaleLowerCase()}.`, escape })}</p>
  </div>`;
}

export function bindCardinalityAdaptiveFacets(root = document) {
  root.querySelectorAll('[data-cardinality-facet]:not([data-cardinality-bound])').forEach((facet) => {
    facet.dataset.cardinalityBound = "true";
    const input = facet.querySelector(".facet-typeahead-input");
    const options = [...facet.querySelectorAll("[data-facet-option]")];
    const empty = facet.querySelector("[data-facet-empty]");
    const filter = () => {
      const query = clean(input.value).toLocaleLowerCase();
      let shown = 0;
      for (const [index, option] of options.entries()) {
        const match = option.dataset.facetLabel.includes(query);
        const visible = match && (query || index < 5 || option.querySelector('[aria-pressed="true"]'));
        option.hidden = !visible;
        if (visible) shown += 1;
      }
      input.setAttribute("aria-expanded", query ? "true" : "false");
      if (empty) empty.hidden = shown > 0;
    };
    input?.addEventListener("input", filter);
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        input.value = "";
        filter();
      } else if (event.key === "ArrowDown") {
        const first = options.find((option) => !option.hidden)?.querySelector("a");
        if (first) { event.preventDefault(); first.focus(); }
      }
    });
    facet.querySelectorAll("[data-filter-href]").forEach((button) => button.addEventListener("click", () => {
      globalThis.location.href = button.dataset.filterHref;
    }));
  });
}
