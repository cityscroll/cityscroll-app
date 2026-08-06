/** Render the current Property agency facet without owning Property state. */
export function renderPropertyAgencySelect(el, options, selected, { label, escape, onChange }) {
  if (!el) return "";
  el.innerHTML = `<option value="" data-i18n="all_agencies">${escape(label)}</option>`
    + options.map((option) => `<option value="${escape(option.id)}">${escape(option.name)} (${option.count})</option>`).join("");
  el.value = options.some((option) => option.id === selected) ? selected : "";
  if (!el.dataset.bound) {
    el.dataset.bound = "1";
    el.addEventListener("change", () => onChange(el.value));
  }
  return el.value;
}

function propertyAgencyResultKeys(rows) {
  return new Set(rows.flatMap((entry) =>
    (entry.members || [entry.primary]).map((row) => String(row?.request_id || entry.subject_ref || ""))
      .filter(Boolean)));
}

export function propertyAgencySelectionChanges(scope, selected) {
  if (!selected) return false;
  const all = propertyAgencyResultKeys(scope({ agency: "" }));
  const filtered = propertyAgencyResultKeys(scope());
  return all.size !== filtered.size || [...all].some((key) => !filtered.has(key));
}
