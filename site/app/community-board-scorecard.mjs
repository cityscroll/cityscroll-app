const root = document.querySelector("[data-community-board-root]");

if (root) {
  const paths = [...root.querySelectorAll("[data-board-id]")];
  const details = [...root.querySelectorAll("[data-board-detail]")];
  const rows = [...root.querySelectorAll("tbody tr[id^='board-']")];
  const viewLinks = [...root.querySelectorAll("[data-scorecard-view]")];
  const mapLayerLinks = [...root.querySelectorAll("[data-scorecard-map-layer]")];
  const moneyMapOnly = root.querySelector("[data-money-map-only]");
  const moneyMapPaths = [...root.querySelectorAll("[data-money-projection]")];
  const moneyMapFiscalSelect = root.querySelector("[data-money-map-fiscal-select]");
  const moneyFiscalSelect = root.querySelector("[data-money-fiscal-select]");
  const moneyPanels = [...root.querySelectorAll("[data-money-comparison-panel]")];
  const moneySortButtons = [...root.querySelectorAll("[data-money-sort]")];
  const defaultBoardId = root.dataset.selectedBoard || paths[0]?.dataset.boardId || "";

  function moneyProjection(path, fiscalKey) {
    try {
      return JSON.parse(path.dataset.moneyProjection || "{}")[fiscalKey] || {};
    } catch {
      return {};
    }
  }

  function setMoneyMetric(metric) {
    const fiscalKey = moneyMapFiscalSelect?.value || "latest";
    const label = root.querySelector("[data-money-map-label]");
    const button = root.querySelector(`[data-money-map-metric="${CSS.escape(metric)}"]`);
    for (const candidate of root.querySelectorAll("[data-money-map-metric]")) {
      const active = candidate === button;
      candidate.setAttribute("aria-pressed", String(active));
    }
    if (label && button) label.textContent = button.textContent;
    for (const path of moneyMapPaths) {
      const level = moneyProjection(path, fiscalKey).levels?.[metric];
      for (let index = 1; index <= 5; index += 1) path.classList.remove(`scorecard-money-level-${index}`);
      path.classList.toggle("scorecard-money-no-data", level == null);
      if (level != null) path.classList.add(`scorecard-money-level-${level}`);
      path.dataset.moneyMetric = metric;
      path.dataset.moneyFiscal = fiscalKey;
    }
  }

  function setMapLayer(mode) {
    const nextMode = mode === "money" && moneyMapPaths.length ? "money" : "sources";
    root.dataset.mapLayer = nextMode;
    for (const link of mapLayerLinks) {
      const active = link.dataset.scorecardMapLayer === nextMode;
      link.setAttribute("aria-pressed", String(active));
    }
    if (moneyMapOnly) moneyMapOnly.hidden = nextMode !== "money";
    setMoneyMetric(root.querySelector("[data-money-map-metric][aria-pressed='true']")?.dataset.moneyMapMetric || "adopted_budget");
  }

  function setMoneyFiscal(key) {
    const panel = moneyPanels.find((candidate) => candidate.dataset.moneyComparisonPanel === key);
    if (!panel) return;
    for (const candidate of moneyPanels) candidate.hidden = candidate !== panel;
    if (moneyFiscalSelect) moneyFiscalSelect.value = key;
    if (moneyMapFiscalSelect) moneyMapFiscalSelect.value = key;
    setMoneyMetric(root.querySelector("[data-money-map-metric][aria-pressed='true']")?.dataset.moneyMapMetric || "adopted_budget");
  }

  function sortMoneyTable(button) {
    const table = button.closest("table");
    const body = table?.querySelector("tbody");
    if (!body) return;
    const key = button.dataset.moneySort;
    const previous = table.dataset.sortKey === key ? table.dataset.sortDirection : null;
    const direction = previous === "ascending" ? "descending" : "ascending";
    const tableRows = [...body.querySelectorAll("[data-money-row]")];
    tableRows.sort((left, right) => {
      const leftCell = left.querySelector(`[data-money-cell="${CSS.escape(key)}"]`);
      const rightCell = right.querySelector(`[data-money-cell="${CSS.escape(key)}"]`);
      const leftMissing = leftCell?.dataset.sortMissing === "true";
      const rightMissing = rightCell?.dataset.sortMissing === "true";
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
      if (leftMissing && rightMissing) return left.dataset.moneyRow.localeCompare(right.dataset.moneyRow);
      const difference = Number(leftCell.dataset.sortValue) - Number(rightCell.dataset.sortValue);
      return (difference || left.dataset.moneyRow.localeCompare(right.dataset.moneyRow)) * (direction === "ascending" ? 1 : -1);
    });
    tableRows.forEach((row) => body.append(row));
    table.dataset.sortKey = key;
    table.dataset.sortDirection = direction;
    for (const heading of table.querySelectorAll("[data-sort-heading]")) {
      heading.setAttribute("aria-sort", heading.dataset.sortHeading === key ? direction : "none");
    }
  }

  function selectBoard(boardId, { focus = false } = {}) {
    const path = paths.find((candidate) => candidate.dataset.boardId === boardId);
    if (!path) return;
    root.dataset.selectedBoard = boardId;
    for (const candidate of paths) {
      const selected = candidate === path;
      candidate.classList.toggle("is-selected", selected);
      candidate.setAttribute("aria-pressed", String(selected));
    }
    for (const detail of details) detail.hidden = detail.dataset.boardDetail !== boardId;
    for (const row of rows) row.classList.toggle("is-selected", row.id === `board-${boardId}`);
    if (focus) path.focus({ preventScroll: true });
    if (window.location.hash !== `#board-${boardId}`) {
      window.history.replaceState(null, "", `#board-${boardId}`);
    }
  }

  function setView(mode) {
    const nextMode = mode === "table" ? "table" : "map";
    root.dataset.activeView = nextMode;
    for (const link of viewLinks) {
      const active = link.dataset.scorecardView === nextMode;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    for (const panel of root.querySelectorAll("[data-view-panel]")) {
      panel.hidden = panel.dataset.viewPanel !== nextMode;
    }
  }

  for (const path of paths) {
    path.addEventListener("click", () => selectBoard(path.dataset.boardId));
    path.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectBoard(path.dataset.boardId, { focus: true });
    });
  }
  for (const link of viewLinks) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      setView(link.dataset.scorecardView);
    });
  }
  for (const link of mapLayerLinks) link.addEventListener("click", () => setMapLayer(link.dataset.scorecardMapLayer));
  for (const button of root.querySelectorAll("[data-money-map-metric]")) {
    button.addEventListener("click", () => setMoneyMetric(button.dataset.moneyMapMetric));
  }
  if (moneyMapFiscalSelect) moneyMapFiscalSelect.addEventListener("change", () => setMoneyFiscal(moneyMapFiscalSelect.value));
  if (moneyFiscalSelect) moneyFiscalSelect.addEventListener("change", () => setMoneyFiscal(moneyFiscalSelect.value));
  for (const button of moneySortButtons) button.addEventListener("click", () => sortMoneyTable(button));

  const hashBoard = window.location.hash.match(/^#board-(.+)$/)?.[1] || "";
  selectBoard(paths.some((path) => path.dataset.boardId === hashBoard) ? hashBoard : defaultBoardId);
  setView("map");
  setMapLayer("sources");
  if (moneyFiscalSelect) setMoneyFiscal(moneyFiscalSelect.value);
}
