/**
 * Browser boot for inspecting one community board budget request in place.
 *
 * The board and agency documents are rendered ahead of the reader, so they have
 * no route module to hang this on. This is that entry point and nothing else.
 *
 * It deliberately imports nothing, and it deliberately carries no copy. Every
 * string it paints was already rendered in the reader's language by
 * `community_board_budget_requests.mjs`: the two boundary sentences and the
 * dialog's own labels arrive once per section on the section element, and every
 * fact about a request is read back out of the row the control was pressed in.
 * So this file needs no translation table, no date formatter and no knowledge
 * of the section's vocabulary — it moves text between elements as text.
 *
 * Reading the row rather than a payload attribute is the point, twice over. It
 * makes the inspected view provably the same record the page already shows, and
 * it keeps a board page that lists a hundred requests from carrying every one
 * of them twice.
 *
 * What loading it changes, and all it changes:
 *
 *  - the inspect buttons become visible, because the section is only marked
 *    ready once the behaviour behind them is actually listening. A reader whose
 *    browser never runs this file is left with the complete row — the request,
 *    the board's own words, the priority, and every dated answer — and with the
 *    ordinary links beside it, which work on their own.
 *  - activating one opens that single record away from the rest of the list,
 *    with the request-and-response boundary beside it. Escape closes it, Tab
 *    stays inside it, and closing returns focus to the button that opened it.
 *    Nothing navigates, subscribes, saves or fetches.
 *
 * The reader's place in the page is never disturbed: this file does not scroll,
 * does not rewrite the URL, and does not touch the agency disclosures, so the
 * chosen agency, the expanded list and the reader's scroll position all survive
 * inspecting a record and dismissing it.
 */

export const BUDGET_REQUEST_BOOT_ATTRIBUTE = "data-budget-request";
export const BUDGET_REQUEST_BOOT_LABELS_ATTRIBUTE = "data-budget-request-labels";
export const BUDGET_REQUEST_BOOT_READY_ATTRIBUTE = "data-budget-requests-ready";
/**
 * Every section that renders a request row.
 *
 * The hearing preparation section renders one request with this same row
 * markup and carries the same labels, so it binds through this one behaviour
 * rather than a second copy of it. One inspect implementation means the record
 * a reader opens from the worked example and the record they open from the
 * list below it behave identically, because they are the same code.
 */
export const BUDGET_REQUEST_BOOT_SECTION_SELECTOR = "[data-community-board-budget-requests], [data-agency-budget-requests], [data-community-board-hearing-context]";
export const BUDGET_REQUEST_BOOT_DIALOG_ID = "budget-request-inspect";
export const BUDGET_REQUEST_BOOT_TITLE_ID = "budget-request-inspect-title";
export const BUDGET_REQUEST_BOOT_LABELS_VERSION = 1;

const BUDGET_REQUEST_BOOT_FOCUSABLE = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";
const BUDGET_REQUEST_BOOT_ROW = "li.board-budget-request";
const BUDGET_REQUEST_BOOT_PROJECT = ".board-request-project";

/** Parse one section's labels; never throws, and never trusts a stale shape. */
export function parseBudgetRequestLabels(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.v !== BUDGET_REQUEST_BOOT_LABELS_VERSION) return null;
  return parsed;
}

function budgetRequestBootText(row, selector) {
  const node = row.querySelector(selector);
  const text = node ? String(node.textContent || "").trim() : "";
  return text || null;
}

/**
 * One capital project block, read back as the lines it already displays.
 *
 * The same rule as the rest of this file: the row is the record, so the
 * inspected view quotes it rather than a payload. Every destination is read as
 * the anchor the page already renders, so the dialog cannot offer a link the
 * page does not have.
 */
function readBudgetRequestProject(node) {
  return {
    heading: budgetRequestBootText(node, ".board-request-project-heading"),
    identity: budgetRequestBootText(node, ".board-request-project-identity"),
    named: budgetRequestBootText(node, ".board-request-project-named"),
    passage: budgetRequestBootText(node, ".board-request-project-passage"),
    spelling: budgetRequestBootText(node, ".board-request-project-spelling"),
    scope: budgetRequestBootText(node, ".board-request-project-scope"),
    observations: [...node.querySelectorAll(".board-request-project-observation")]
      .map((row) => String(row.textContent || "").trim())
      .filter(Boolean),
    difference: budgetRequestBootText(node, ".board-request-project-difference"),
    boundary: budgetRequestBootText(node, ".board-request-project-boundary"),
    actions: [...node.querySelectorAll(".board-request-project-action")]
      .map((anchor) => ({
        href: anchor.getAttribute("href"),
        label: String(anchor.textContent || "").trim(),
      }))
      .filter((action) => action.href && action.label),
  };
}

/**
 * One row, read back as the facts it already displays.
 *
 * Returns `null` for a row that carries no title, so a control on markup this
 * file does not recognise opens nothing rather than opening an empty record.
 */
export function readBudgetRequestRow(row) {
  if (!row || typeof row.querySelector !== "function") return null;
  const title = budgetRequestBootText(row, ".board-budget-request-title");
  if (!title) return null;
  const facts = [...row.querySelectorAll(".board-budget-request-fact")]
    .map((node) => String(node.textContent || "").trim())
    .filter(Boolean);
  const support = budgetRequestBootText(row, ".board-budget-request-support");
  if (support) facts.push(support);
  const destination = row.querySelector(".board-budget-request-agency-link");
  return {
    code: budgetRequestBootText(row, ".board-budget-request-code"),
    title,
    facts,
    explanation: budgetRequestBootText(row, ".board-budget-request-explanation"),
    answers: [...row.querySelectorAll(".board-budget-request-answer")].map((node) => ({
      date: budgetRequestBootText(node, ".board-budget-request-answer-date"),
      text: budgetRequestBootText(node, ".board-budget-request-answer-text"),
      note: budgetRequestBootText(node, ".board-budget-request-answer-note"),
    })),
    projects: [...row.querySelectorAll(BUDGET_REQUEST_BOOT_PROJECT)].map(readBudgetRequestProject),
    href: destination ? destination.getAttribute("href") : null,
    href_label: destination ? String(destination.textContent || "").trim() : null,
  };
}

function budgetRequestBootElement(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  // Text is set as text, never as markup: the publisher's own wording reaches
  // the dialog as the characters the publisher wrote and nothing else.
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function budgetRequestBootDialog(doc) {
  const existing = doc.getElementById(BUDGET_REQUEST_BOOT_DIALOG_ID);
  if (existing) return existing;
  const dialog = doc.createElement("dialog");
  dialog.id = BUDGET_REQUEST_BOOT_DIALOG_ID;
  dialog.className = "budget-request-dialog";
  doc.body.appendChild(dialog);
  return dialog;
}

/**
 * Paint one request into the dialog.
 *
 * The board's page stays one explicit, visible choice away; this is the record
 * the row already shows, isolated, never an embedded copy of another page.
 */
export function paintBudgetRequestDialog(dialog, record, labels) {
  const doc = dialog.ownerDocument;
  const inner = budgetRequestBootElement(doc, "div", "budget-request-dialog-inner");

  const close = budgetRequestBootElement(doc, "button", "budget-request-dialog-close", labels.close || "Close");
  close.type = "button";
  close.setAttribute("data-budget-request-close", "");
  inner.appendChild(close);

  if (labels.kicker) inner.appendChild(budgetRequestBootElement(doc, "p", "budget-request-dialog-kicker", labels.kicker));

  const title = budgetRequestBootElement(doc, "h2", "budget-request-dialog-title", record.title);
  title.id = BUDGET_REQUEST_BOOT_TITLE_ID;
  title.setAttribute("lang", "en");
  title.setAttribute("dir", "ltr");
  inner.appendChild(title);

  if (record.code) {
    const code = budgetRequestBootElement(doc, "p", "budget-request-dialog-code", record.code);
    code.setAttribute("lang", "en");
    code.setAttribute("dir", "ltr");
    inner.appendChild(code);
  }

  if (record.facts.length) {
    const list = budgetRequestBootElement(doc, "ul", "budget-request-dialog-facts");
    for (const fact of record.facts) list.appendChild(budgetRequestBootElement(doc, "li", null, fact));
    inner.appendChild(list);
  }

  if (record.explanation) {
    if (labels.explanation) {
      inner.appendChild(budgetRequestBootElement(doc, "h3", "budget-request-dialog-subhead", labels.explanation));
    }
    const explanation = budgetRequestBootElement(doc, "p", "budget-request-dialog-explanation", record.explanation);
    explanation.setAttribute("lang", "en");
    explanation.setAttribute("dir", "ltr");
    inner.appendChild(explanation);
  }

  if (record.answers.length) {
    if (labels.answers) {
      inner.appendChild(budgetRequestBootElement(doc, "h3", "budget-request-dialog-subhead", labels.answers));
    }
    const list = doc.createElement("ol");
    list.className = "budget-request-dialog-answers";
    for (const answer of record.answers) {
      const item = budgetRequestBootElement(doc, "li", "budget-request-dialog-answer");
      if (answer.date) item.appendChild(budgetRequestBootElement(doc, "p", "budget-request-dialog-answer-date", answer.date));
      const text = budgetRequestBootElement(doc, "p", "budget-request-dialog-answer-text", answer.text || "");
      text.setAttribute("lang", "en");
      text.setAttribute("dir", "ltr");
      item.appendChild(text);
      if (answer.note) item.appendChild(budgetRequestBootElement(doc, "p", "budget-request-dialog-answer-note", answer.note));
      list.appendChild(item);
    }
    inner.appendChild(list);
  }

  // The capital project a request names travels with the record, because the
  // reference is part of what the reader opened the record to read. It keeps
  // its own boundary sentence and its own destinations rather than borrowing
  // the request's.
  for (const project of Array.isArray(record.projects) ? record.projects : []) {
    if (project.heading) {
      inner.appendChild(budgetRequestBootElement(doc, "h3", "budget-request-dialog-subhead", project.heading));
    }
    for (const [className, value] of [
      ["budget-request-dialog-project-identity", project.identity],
      ["budget-request-dialog-project-named", project.named],
      ["budget-request-dialog-project-passage", project.passage],
      ["budget-request-dialog-project-spelling", project.spelling],
      ["budget-request-dialog-project-scope", project.scope],
    ]) {
      if (value) inner.appendChild(budgetRequestBootElement(doc, "p", className, value));
    }
    if (project.observations.length) {
      const list = budgetRequestBootElement(doc, "ul", "budget-request-dialog-project-observations");
      for (const observation of project.observations) {
        list.appendChild(budgetRequestBootElement(doc, "li", null, observation));
      }
      inner.appendChild(list);
    }
    if (project.difference) {
      inner.appendChild(budgetRequestBootElement(doc, "p", "budget-request-dialog-project-difference", project.difference));
    }
    if (project.boundary) {
      inner.appendChild(budgetRequestBootElement(doc, "p", "budget-request-dialog-note", project.boundary));
    }
    if (project.actions.length) {
      const actions = budgetRequestBootElement(doc, "p", "budget-request-dialog-project-actions");
      for (const action of project.actions) {
        const anchor = budgetRequestBootElement(doc, "a", "budget-request-dialog-open", action.label);
        anchor.href = action.href;
        actions.appendChild(anchor);
      }
      inner.appendChild(actions);
    }
  }

  for (const note of Array.isArray(labels.notes) ? labels.notes : []) {
    inner.appendChild(budgetRequestBootElement(doc, "p", "budget-request-dialog-note", note));
  }

  if (record.href && record.href_label) {
    const actions = budgetRequestBootElement(doc, "p", "budget-request-dialog-actions");
    const open = budgetRequestBootElement(doc, "a", "budget-request-dialog-open", record.href_label);
    open.href = record.href;
    actions.appendChild(open);
    inner.appendChild(actions);
  }

  dialog.textContent = "";
  dialog.appendChild(inner);
  dialog.setAttribute("aria-labelledby", BUDGET_REQUEST_BOOT_TITLE_ID);
  return dialog;
}

const budgetRequestBoundRoots = new WeakSet();

/**
 * Mount the inspect behaviour on one section. Idempotent and delegated: one
 * listener per section, so a container bound twice installs nothing twice.
 *
 * Returns a controller (`{ open, close, destroy }`) or `null` when there is no
 * document to bind to, so rendering on the server is safe.
 */
export function bindCommunityBoardBudgetRequests(section) {
  const doc = section?.ownerDocument;
  if (!doc || typeof doc.createElement !== "function" || !doc.body) return null;
  if (budgetRequestBoundRoots.has(section)) return null;
  const labels = parseBudgetRequestLabels(section.getAttribute(BUDGET_REQUEST_BOOT_LABELS_ATTRIBUTE));
  // Labels this file does not recognise mean a section rendered by a different
  // version of the module. Leaving it unbound keeps its buttons hidden, which
  // is the correct outcome: the rows are already complete without them.
  if (!labels) return null;
  budgetRequestBoundRoots.add(section);

  const dialog = budgetRequestBootDialog(doc);
  let invoker = null;

  const close = () => {
    if (!dialog.open) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  };

  const open = (record, control) => {
    if (!record) return null;
    invoker = control || null;
    paintBudgetRequestDialog(dialog, record, labels);
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
    const first = dialog.querySelector("[data-budget-request-close]");
    if (first && typeof first.focus === "function") first.focus();
    return dialog;
  };

  const onClick = (event) => {
    const closer = event.target.closest?.("[data-budget-request-close]");
    if (closer) {
      event.preventDefault();
      close();
      return;
    }
    const control = event.target.closest?.(`[${BUDGET_REQUEST_BOOT_ATTRIBUTE}]`);
    if (!control) return;
    // The control is a button, not a link: nothing here cancels a navigation,
    // because a button never started one.
    open(readBudgetRequestRow(control.closest?.(BUDGET_REQUEST_BOOT_ROW)), control);
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
    const focusable = [...dialog.querySelectorAll(BUDGET_REQUEST_BOOT_FOCUSABLE)]
      .filter((node) => !node.hasAttribute("hidden"));
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
  section.setAttribute(BUDGET_REQUEST_BOOT_READY_ATTRIBUTE, "");

  return {
    open,
    close,
    destroy() {
      section.removeEventListener("click", onClick);
      dialog.removeEventListener("click", onClick);
      dialog.removeEventListener("keydown", onKeydown);
      dialog.removeEventListener("close", onClose);
      dialog.textContent = "";
      section.removeAttribute(BUDGET_REQUEST_BOOT_READY_ATTRIBUTE);
      budgetRequestBoundRoots.delete(section);
    },
  };
}

/** Mount every budget request section in one document. */
export function bindCommunityBoardBudgetRequestSections(doc) {
  const sections = doc?.querySelectorAll?.(BUDGET_REQUEST_BOOT_SECTION_SELECTOR) || [];
  const bound = [];
  for (const section of sections) {
    const controller = bindCommunityBoardBudgetRequests(section);
    if (controller) bound.push(controller);
  }
  return bound;
}

if (typeof document !== "undefined") bindCommunityBoardBudgetRequestSections(document);
