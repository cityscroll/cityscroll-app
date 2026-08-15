const root = document.querySelector("[data-people-organizations]");
const input = root?.querySelector("[data-people-organizations-search]");
const rows = [...(root?.querySelectorAll("[data-people-organization-row]") || [])];
const summary = root?.querySelector("[data-people-organizations-search-summary]");
const empty = root?.querySelector("[data-people-organizations-no-results]");

if (root && input && summary && empty) {
  const initialSummary = summary.textContent;
  const update = () => {
    const query = input.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const row of rows) {
      const matches = !query || (row.dataset.searchText || "").toLocaleLowerCase().includes(query);
      row.hidden = !matches;
      if (matches) visible += 1;
    }
    summary.textContent = query
      ? `${visible.toLocaleString("en-US")} matching typed row${visible === 1 ? "" : "s"}`
      : initialSummary;
    empty.hidden = visible !== 0;
  };
  input.addEventListener("input", update);
  root.querySelector("[data-people-organizations-search-form]")?.addEventListener("submit", (event) => event.preventDefault());
}
