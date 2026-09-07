/**
 * Browser boot for inspecting one recorded board position in place.
 *
 * The Community Board document is rendered ahead of the reader, so it has no
 * route module to hang this on. This is that entry point and nothing else.
 *
 * It deliberately imports nothing. Every string it paints was already rendered
 * in the reader's language by `community_board_land_positions.mjs` and handed
 * over on the control itself, so this file needs no translation table, no date
 * formatter and no knowledge of the section's vocabulary: it paints text it is
 * given, into text nodes, and never assembles markup from source values.
 *
 * What loading it changes, and all it changes:
 *
 *  - the inspect buttons become visible, because the section is only marked
 *    ready once the behaviour behind them is actually listening. A reader whose
 *    browser never runs this file is left with the project links and the facts
 *    already written into each row, which work on their own.
 *  - activating one opens a bounded summary of that one record. Escape closes
 *    it, Tab stays inside it, and closing returns focus to the button that
 *    opened it. Nothing navigates, subscribes, saves or fetches.
 *
 * The reader's place in the page is never disturbed: this file does not scroll,
 * does not rewrite the URL, and does not touch the overflow disclosure, so the
 * board's own scope, its expanded list and the reader's scroll position survive
 * inspecting a record and dismissing it.
 */

export const BOARD_LAND_POSITION_ATTRIBUTE = "data-board-land-position";
export const BOARD_LAND_POSITION_LABELS_ATTRIBUTE = "data-board-land-position-labels";
export const BOARD_LAND_POSITION_READY_ATTRIBUTE = "data-board-land-positions-ready";
export const BOARD_LAND_POSITION_SECTION_SELECTOR = "[data-community-board-land-positions]";
export const BOARD_LAND_POSITION_DIALOG_ID = "board-land-position-inspect";
export const BOARD_LAND_POSITION_TITLE_ID = "board-land-position-inspect-title";
export const BOARD_LAND_POSITION_PAYLOAD_VERSION = 1;

const FOCUSABLE = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Parse one control's payload; never throws, and never trusts a stale shape. */
export function parseBoardLandPosition(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.v !== BOARD_LAND_POSITION_PAYLOAD_VERSION) return null;
  return parsed.title && parsed.href ? parsed : null;
}

function parseLabels(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  // Text is set as text, never as markup: a publisher's project name reaches
  // the dialog as the characters the publisher wrote and nothing else.
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function ensureDialog(doc) {
  const existing = doc.getElementById(BOARD_LAND_POSITION_DIALOG_ID);
  if (existing) return existing;
  const dialog = doc.createElement("dialog");
  dialog.id = BOARD_LAND_POSITION_DIALOG_ID;
  dialog.className = "board-land-position-dialog";
  doc.body.appendChild(dialog);
  return dialog;
}

/**
 * Paint one record into the dialog.
 *
 * The full project page stays one explicit, visible choice away; this is a
 * summary of the record, never an embedded copy of the project document.
 */
export function paintBoardLandPositionDialog(dialog, facts, labels) {
  const doc = dialog.ownerDocument;
  const inner = element(doc, "div", "board-land-position-dialog-inner");

  const close = element(doc, "button", "board-land-position-dialog-close", labels.close || "Close");
  close.type = "button";
  close.setAttribute("data-board-land-position-close", "");
  inner.appendChild(close);

  if (labels.kicker) inner.appendChild(element(doc, "p", "board-land-position-dialog-kicker", labels.kicker));

  const title = element(doc, "h2", "board-land-position-dialog-title", facts.title);
  title.id = BOARD_LAND_POSITION_TITLE_ID;
  title.setAttribute("lang", "en");
  title.setAttribute("dir", "ltr");
  inner.appendChild(title);

  const factRows = Array.isArray(facts.facts) ? facts.facts : [];
  if (factRows.length) {
    const factList = element(doc, "ul", "board-land-position-dialog-facts");
    for (const fact of factRows) factList.appendChild(element(doc, "li", null, fact));
    inner.appendChild(factList);
  }

  if (Array.isArray(facts.others) && facts.others.length) {
    if (labels.others) inner.appendChild(element(doc, "h3", "board-land-position-dialog-subhead", labels.others));
    const list = doc.createElement("dl");
    list.className = "board-land-position-dialog-others";
    for (const row of facts.others) {
      const group = element(doc, "div", "board-land-position-dialog-other");
      group.appendChild(element(doc, "dt", null, row.term));
      group.appendChild(element(doc, "dd", null, row.value));
      if (row.note) group.appendChild(element(doc, "dd", "board-land-position-dialog-other-note", row.note));
      list.appendChild(group);
    }
    inner.appendChild(list);
  } else if (facts.others_none) {
    inner.appendChild(element(doc, "p", "board-land-position-dialog-others-none", facts.others_none));
  }

  for (const note of Array.isArray(facts.notes) ? facts.notes : []) {
    inner.appendChild(element(doc, "p", "board-land-position-dialog-note", note));
  }

  const actions = element(doc, "p", "board-land-position-dialog-actions");
  const open = element(doc, "a", "board-land-position-dialog-open", labels.open || facts.title);
  open.href = facts.href;
  actions.appendChild(open);
  if (facts.portal && labels.portal) {
    const portal = element(doc, "a", "board-land-position-dialog-portal", labels.portal);
    portal.href = facts.portal;
    // A publisher's own record leaves this site, so it is announced as the
    // handoff it is rather than as a link indistinguishable from the one above.
    portal.rel = "noopener";
    portal.target = "_blank";
    actions.appendChild(portal);
  }
  inner.appendChild(actions);

  if (facts.record) inner.appendChild(element(doc, "p", "board-land-position-dialog-record", facts.record));

  dialog.textContent = "";
  dialog.appendChild(inner);
  dialog.setAttribute("aria-labelledby", BOARD_LAND_POSITION_TITLE_ID);
  return dialog;
}

const boundRoots = new WeakSet();

/**
 * Mount the inspect behaviour on one section. Idempotent and delegated: one
 * listener per section, so a container bound twice installs nothing twice.
 *
 * Returns a controller (`{ open, close, destroy }`) or `null` when there is no
 * document to bind to, so rendering on the server is safe.
 */
export function bindCommunityBoardLandPositions(section) {
  const doc = section?.ownerDocument;
  if (!doc || typeof doc.createElement !== "function" || !doc.body) return null;
  if (boundRoots.has(section)) return null;
  boundRoots.add(section);

  const labels = parseLabels(section.getAttribute(BOARD_LAND_POSITION_LABELS_ATTRIBUTE));
  const dialog = ensureDialog(doc);
  let invoker = null;

  const close = () => {
    if (!dialog.open) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  };

  const open = (facts, control) => {
    if (!facts) return null;
    invoker = control || null;
    paintBoardLandPositionDialog(dialog, facts, labels);
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else {
        dialog.setAttribute("open", "");
        // Without `showModal` there is no native modality to inherit, so the
        // dialog states its own semantics rather than looking modal silently.
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
      }
    }
    const first = dialog.querySelector("[data-board-land-position-close]");
    if (first && typeof first.focus === "function") first.focus();
    return dialog;
  };

  const onClick = (event) => {
    const closer = event.target.closest?.("[data-board-land-position-close]");
    if (closer) {
      event.preventDefault();
      close();
      return;
    }
    const control = event.target.closest?.(`[${BOARD_LAND_POSITION_ATTRIBUTE}]`);
    if (!control) return;
    // The control is a button, not a link: nothing here cancels a navigation,
    // because a button never started one.
    open(parseBoardLandPosition(control.getAttribute(BOARD_LAND_POSITION_ATTRIBUTE)), control);
  };

  // A native modal dialog already closes on Escape and contains Tab. This keeps
  // the same contract on the non-modal fallback path, where nothing else would.
  const onKeydown = (event) => {
    if (!dialog.open) return;
    if (event.key === "Escape" && typeof dialog.showModal !== "function") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll(FOCUSABLE)].filter((node) => !node.hasAttribute("hidden"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  };

  // Focus goes back to the control the reader opened the record from, so
  // dismissing returns them exactly where they were rather than to the top of
  // the document.
  const onClose = () => {
    if (invoker && invoker.isConnected && typeof invoker.focus === "function") invoker.focus();
    invoker = null;
  };

  section.addEventListener("click", onClick);
  dialog.addEventListener("click", onClick);
  dialog.addEventListener("keydown", onKeydown);
  dialog.addEventListener("close", onClose);

  // Revealing the buttons is the last step, so an affordance is only ever
  // visible once the behaviour behind it is listening.
  section.setAttribute(BOARD_LAND_POSITION_READY_ATTRIBUTE, "");

  return {
    open,
    close,
    destroy() {
      section.removeEventListener("click", onClick);
      dialog.removeEventListener("click", onClick);
      dialog.removeEventListener("keydown", onKeydown);
      dialog.removeEventListener("close", onClose);
      dialog.textContent = "";
      section.removeAttribute(BOARD_LAND_POSITION_READY_ATTRIBUTE);
      boundRoots.delete(section);
    },
  };
}

/** Mount every recorded-position section in one document. */
export function bindCommunityBoardLandPositionSections(doc) {
  const sections = doc?.querySelectorAll?.(BOARD_LAND_POSITION_SECTION_SELECTOR) || [];
  const bound = [];
  for (const section of sections) {
    const controller = bindCommunityBoardLandPositions(section);
    if (controller) bound.push(controller);
  }
  return bound;
}

if (typeof document !== "undefined") bindCommunityBoardLandPositionSections(document);
