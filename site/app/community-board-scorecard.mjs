const root = document.querySelector("[data-community-board-root]");

if (root) {
  const paths = [...root.querySelectorAll("[data-board-id]")];
  const details = [...root.querySelectorAll("[data-board-detail]")];
  const rows = [...root.querySelectorAll("tbody tr[id^='board-']")];
  const viewLinks = [...root.querySelectorAll("[data-scorecard-view]")];
  const defaultBoardId = root.dataset.selectedBoard || paths[0]?.dataset.boardId || "";

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

  const hashBoard = window.location.hash.match(/^#board-(.+)$/)?.[1] || "";
  selectBoard(paths.some((path) => path.dataset.boardId === hashBoard) ? hashBoard : defaultBoardId);
  setView("map");
}
