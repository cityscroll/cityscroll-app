/**
 * Browser-local Passed / Pursuing controls for procurement and notice detail.
 *
 * The controls annotate one matter in this browser only. They never sync an
 * account, never hide or rerank a list, and never claim a save succeeded when
 * local storage refused the write.
 */

import {
  PURSUIT_DECISIONS,
  PURSUIT_REASON_CODES,
  clearPursuitDecision,
  defaultPursuitStateStorage,
  migrateUnambiguousPursuitKeys,
  pursuitBadge,
  pursuitStateFor,
  recordPursuitDecision,
  renderPursuitStateNoteHtml,
  tryClearPursuitDecision,
} from "./procurement_pursuit_state.mjs";
import { resolvePursuitMatterRef } from "./procurement_pursuit_identity.mjs";

export const PURSUIT_CONTROLS_ATTRIBUTE = "data-pursuit-controls";
export const PURSUIT_CONTROLS_READY_ATTRIBUTE = "data-pursuit-controls-ready";
export const PURSUIT_CONTROLS_STORAGE_LABEL = "Saved in this browser";
export const PURSUIT_CONTROLS_HEADING = "Your pursuit note";
export const PURSUIT_CONTROLS_UNSAVED_MESSAGE =
  "Could not save in this browser. Try again.";
export const PURSUIT_CONTROLS_CLEARED_MESSAGE = "Cleared for this browser.";

const CONTROL_DECISIONS = Object.freeze(["passed", "pursuing"]);

const REASON_OPTIONS = Object.freeze([
  { value: "", label: "Reason (optional)" },
  { value: "capability_fit", label: "Capability fit" },
  { value: "capacity", label: "Capacity" },
  { value: "timing", label: "Timing" },
  { value: "amount", label: "Amount" },
  { value: "certification", label: "Certification" },
  { value: "relationship", label: "Relationship" },
  { value: "other", label: "Other" },
]);

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function clean(value, max = 240) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

export function pursuitControlsAssetTags(assetPrefix = "/") {
  const prefix = assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`;
  return [
    `<link rel="stylesheet" href="${esc(`${prefix}procurement_pursuit_controls.css`)}" data-route-style="procurement_pursuit_controls.css">`,
    `<script type="module" src="${esc(`${prefix}procurement_pursuit_controls_boot.mjs`)}"></script>`,
  ].join("");
}

/**
 * Static host markup stamped with the resolved matter key. The boot module
 * binds behaviour; without scripting the label and empty status remain honest.
 */
export function renderPursuitControlsHtml({
  matterRef,
  heading = PURSUIT_CONTROLS_HEADING,
  storageLabel = PURSUIT_CONTROLS_STORAGE_LABEL,
  noticeId = null,
  aliasBasis = null,
} = {}) {
  const key = clean(matterRef, 200);
  if (!key) return "";
  const reasonOptions = REASON_OPTIONS.map((option) => (
    `<option value="${esc(option.value)}">${esc(option.label)}</option>`
  )).join("");
  const noticeAttr = noticeId ? ` data-pursuit-notice-id="${esc(noticeId)}"` : "";
  const aliasAttr = aliasBasis ? ` data-pursuit-alias-basis="${esc(aliasBasis)}"` : "";
  return `<section class="pursuit-controls" ${PURSUIT_CONTROLS_ATTRIBUTE}="1" data-pursuit-matter-ref="${esc(key)}"${noticeAttr}${aliasAttr} aria-labelledby="pursuit-controls-heading">
  <div class="pursuit-controls-header">
    <h2 id="pursuit-controls-heading" class="pursuit-controls-heading">${esc(heading)}</h2>
    <p class="pursuit-controls-storage-label">${esc(storageLabel)}</p>
  </div>
  <div class="pursuit-controls-actions" role="group" aria-label="${esc(heading)}">
    <button type="button" class="act pursuit-controls-decision" data-pursuit-decision="passed">Passed</button>
    <button type="button" class="act primary pursuit-controls-decision" data-pursuit-decision="pursuing">Pursuing</button>
    <button type="button" class="act pursuit-controls-clear" data-pursuit-clear hidden>Clear</button>
  </div>
  <div class="pursuit-controls-fields">
    <label class="pursuit-controls-reason-label"><span class="pursuit-controls-field-label">Reason</span>
      <select data-pursuit-reason>${reasonOptions}</select>
    </label>
    <label class="pursuit-controls-note-label"><span class="pursuit-controls-field-label">Note</span>
      <textarea data-pursuit-note rows="2" maxlength="500" placeholder="Optional note"></textarea>
    </label>
  </div>
  <div class="pursuit-controls-current" data-pursuit-current></div>
  <p class="pursuit-controls-status" data-pursuit-status role="status" aria-live="polite"></p>
  <p class="pursuit-controls-error" data-pursuit-error hidden>
    <span data-pursuit-error-text>${esc(PURSUIT_CONTROLS_UNSAVED_MESSAGE)}</span>
    <button type="button" class="act pursuit-controls-retry" data-pursuit-retry>Try again</button>
  </p>
</section>`;
}

function hostParts(host) {
  return {
    host,
    matterRef: clean(host?.getAttribute?.("data-pursuit-matter-ref"), 200),
    status: host?.querySelector?.("[data-pursuit-status]") || null,
    error: host?.querySelector?.("[data-pursuit-error]") || null,
    errorText: host?.querySelector?.("[data-pursuit-error-text]") || null,
    current: host?.querySelector?.("[data-pursuit-current]") || null,
    reason: host?.querySelector?.("[data-pursuit-reason]") || null,
    note: host?.querySelector?.("[data-pursuit-note]") || null,
    clear: host?.querySelector?.("[data-pursuit-clear]") || null,
    decisions: [...(host?.querySelectorAll?.("[data-pursuit-decision]") || [])],
  };
}

function setStatus(parts, message, { unsaved = false } = {}) {
  if (parts.status) parts.status.textContent = message || "";
  if (parts.error) {
    if (unsaved) {
      parts.error.hidden = false;
      if (parts.errorText && message) parts.errorText.textContent = message;
    } else {
      parts.error.hidden = true;
    }
  }
}

function paintCurrent(parts, store) {
  const record = pursuitStateFor(store, parts.matterRef);
  const badge = pursuitBadge(record);
  if (parts.current) {
    parts.current.innerHTML = renderPursuitStateNoteHtml(badge);
  }
  for (const button of parts.decisions) {
    const decision = button.getAttribute("data-pursuit-decision");
    const pressed = Boolean(record && record.decision === decision);
    button.setAttribute("aria-pressed", pressed ? "true" : "false");
  }
  if (parts.clear) parts.clear.hidden = !record;
  if (parts.reason && record) {
    parts.reason.value = record.reason_code || "";
  }
  if (parts.note && record && parts.note.value === "") {
    parts.note.value = record.note || "";
  }
  return record;
}

function readOptionalFields(parts) {
  const reasonCode = clean(parts.reason?.value, 40);
  const note = parts.note?.value == null ? null : parts.note.value;
  return {
    reason_code: PURSUIT_REASON_CODES.includes(reasonCode) ? reasonCode : null,
    note,
  };
}

/**
 * Bind one stamped controls host. Returns false when the host lacks a matter
 * key or has already been bound.
 */
export function bindPursuitControls(host, {
  store = defaultPursuitStateStorage(),
  aliasMap = null,
  now = new Date(),
} = {}) {
  if (!host || host.getAttribute(PURSUIT_CONTROLS_READY_ATTRIBUTE) === "1") return false;
  const parts = hostParts(host);
  if (!parts.matterRef) return false;

  if (aliasMap && typeof aliasMap === "object") {
    migrateUnambiguousPursuitKeys(store, aliasMap);
  }

  let pendingDecision = null;

  const saveDecision = (decision) => {
    if (!CONTROL_DECISIONS.includes(decision) && !PURSUIT_DECISIONS.includes(decision)) {
      return false;
    }
    pendingDecision = decision;
    const fields = readOptionalFields(parts);
    const stored = recordPursuitDecision(store, {
      matter_ref: parts.matterRef,
      decision,
      reason_code: fields.reason_code,
      note: fields.note,
    }, { now });
    if (!stored) {
      setStatus(parts, PURSUIT_CONTROLS_UNSAVED_MESSAGE, { unsaved: true });
      paintCurrent(parts, store);
      return false;
    }
    pendingDecision = null;
    setStatus(parts, `${PURSUIT_CONTROLS_STORAGE_LABEL}: ${pursuitBadge(stored)?.label || stored.decision}.`);
    paintCurrent(parts, store);
    return true;
  };

  const clearDecision = () => {
    pendingDecision = "clear";
    const result = tryClearPursuitDecision(store, parts.matterRef);
    if (!result.ok) {
      setStatus(parts, PURSUIT_CONTROLS_UNSAVED_MESSAGE, { unsaved: true });
      paintCurrent(parts, store);
      return false;
    }
    pendingDecision = null;
    if (parts.reason) parts.reason.value = "";
    if (parts.note) parts.note.value = "";
    setStatus(parts, PURSUIT_CONTROLS_CLEARED_MESSAGE);
    paintCurrent(parts, store);
    return true;
  };

  for (const button of parts.decisions) {
    button.addEventListener("click", () => {
      saveDecision(button.getAttribute("data-pursuit-decision"));
    });
  }
  if (parts.clear) {
    parts.clear.addEventListener("click", () => {
      clearDecision();
    });
  }
  const retry = host.querySelector("[data-pursuit-retry]");
  if (retry) {
    retry.addEventListener("click", () => {
      if (pendingDecision === "clear") clearDecision();
      else if (pendingDecision) saveDecision(pendingDecision);
      else setStatus(parts, "");
    });
  }

  host.setAttribute(PURSUIT_CONTROLS_READY_ATTRIBUTE, "1");
  paintCurrent(parts, store);
  return true;
}

/** Bind every stamped controls host under a root. */
export function bindAllPursuitControls(root = typeof document === "undefined" ? null : document, options = {}) {
  if (!root || typeof root.querySelectorAll !== "function") return 0;
  const hosts = root.querySelectorAll(`[${PURSUIT_CONTROLS_ATTRIBUTE}]`);
  let bound = 0;
  for (const host of hosts) {
    if (bindPursuitControls(host, options)) bound += 1;
  }
  return bound;
}

/**
 * Resolve and render controls for a procurement or notice row. Returns "" when
 * the row has no trustworthy matter identity for pursuit state.
 */
export function renderPursuitControlsForRow(row = {}, {
  subjectsLookup = null,
  sourceAliasIndex = null,
} = {}) {
  const resolved = resolvePursuitMatterRef(row, { subjectsLookup, sourceAliasIndex });
  if (!resolved?.matter_ref) return "";
  return renderPursuitControlsHtml({
    matterRef: resolved.matter_ref,
    noticeId: resolved.notice_id,
    aliasBasis: resolved.alias_basis,
  });
}

// Re-export clear for callers that still import the void-style helper through controls.
export { clearPursuitDecision };
