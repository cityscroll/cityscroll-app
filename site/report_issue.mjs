import {
  REPORT_TARGET_SCHEMA,
  buildReportTarget,
  buildReportTargetFromAnchor,
  buildRelationshipReportTarget,
  reportTargetIdentity,
  resolveReportTarget,
  serializeReportTarget,
} from "./report_target.mjs";
import { entityRouteRef } from "./entity_pivot.mjs";

export const REPORT_CATEGORIES = Object.freeze([
  { value: "information_wrong", label: "Information is wrong" },
  { value: "connection_wrong", label: "Connection is wrong" },
  { value: "same_thing", label: "These are the same thing" },
  { value: "different_things", label: "These are different things" },
  { value: "something_missing", label: "Something is missing" },
  { value: "interpretation_wrong", label: "Interpretation is wrong" },
  { value: "other", label: "Other" },
]);

const FIELD_REPORT_CATEGORIES = Object.freeze(new Set([
  "information_wrong",
  "something_missing",
  "other",
]));
const RELATIONSHIP_REPORT_CATEGORIES = Object.freeze(new Set([
  "connection_wrong",
  "something_missing",
  "other",
]));

const DEFAULT_FALLBACK_HREF = "/about.html#feedback";
const API_ORIGIN = () => globalThis.CROL_API_ORIGIN || "https://api.cityscroll.org";
const API_FALLBACK_ORIGIN = () => globalThis.CROL_API_FALLBACK_ORIGIN || "https://crol-worker.crol-worker.workers.dev";

function reportClean(value, max = 500) {
  const result = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return result || null;
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function contractParts(record = {}) {
  const source = record && typeof record === "object" ? record : {};
  const procurementId = reportClean(source.procurement_id || source.object_id, 320);
  const match = procurementId?.match(/^procurement:contract:([^:]+)$/i);
  if (!match) return null;
  const canonicalUrl = reportClean(
    source.canonical_href
      || source.canonical_url
      || source.compatibility?.canonical_href,
    600,
  );
  if (!canonicalUrl || !canonicalUrl.startsWith("/procurements/")) return null;
  return { procurementId, contractId: match[1], canonicalUrl };
}

/** Build the Card 2 target only from an already-addressable Contract record. */
export function buildContractReportTarget(record = {}, facts = {}) {
  const parts = contractParts(record);
  if (!parts) return null;
  const source = record && typeof record === "object" ? record : {};
  const details = facts && typeof facts === "object" ? facts : {};
  const objectLabel = reportClean(
    details.title || source.short_title || source.title || source.object_label,
    1_000,
  ) || `Contract ${parts.contractId}`;
  const vendor = reportClean(
    details.vendor || source.vendor_name || source.vendor || source.prime_vendor,
    500,
  );
  const context = {
    object_type: "procurement",
    object_id: parts.procurementId,
    canonical_url: parts.canonicalUrl,
    object_label: objectLabel,
    object: {
      ...source,
      object_type: "procurement",
      procurement_id: parts.procurementId,
      title: objectLabel,
      compatibility: {
        ...(source.compatibility || {}),
        canonical_href: parts.canonicalUrl,
      },
    },
    source,
  };
  try {
    return vendor
      ? buildReportTargetFromAnchor(`contract:${parts.contractId}#vendor`, {
        ...context,
        claim_anchor: { rendered_value: vendor },
      })
      : buildReportTarget(context);
  } catch {
    return null;
  }
}

function existingVendorRef(record, facts) {
  const values = [
    facts?.vendor_ref,
    facts?.vendor_entity_ref,
    facts?.vendor_subject_ref,
    record?.vendor_ref,
    record?.vendor_entity_ref,
    record?.vendor_subject_ref,
    ...(Array.isArray(record?.entity_refs_all) ? record.entity_refs_all : []),
  ];
  return values.map((value) => reportClean(value, 320))
    .find((value) => /^vendor:stem:[^\s]+$/.test(value || "")) || null;
}

/** Build the durable Contract ↔ vendor edge target from the vendor identity model. */
export function buildContractVendorRelationshipReportTarget(record = {}, facts = {}) {
  const parts = contractParts(record);
  if (!parts) return null;
  const source = record && typeof record === "object" ? record : {};
  const details = facts && typeof facts === "object" ? facts : {};
  const contractLabel = reportClean(
    details.title || source.short_title || source.title || source.object_label,
    1_000,
  ) || `Contract ${parts.contractId}`;
  const vendor = reportClean(
    details.vendor || source.vendor_name || source.vendor || source.prime_vendor,
    500,
  );
  const vendorRef = existingVendorRef(source, details) || (vendor ? entityRouteRef("vendor", vendor) : null);
  if (!vendor || !vendorRef) return null;
  try {
    return buildRelationshipReportTarget({
      object_type: "procurement",
      object_id: parts.procurementId,
      canonical_url: parts.canonicalUrl,
      object_label: contractLabel,
      anchor: `contract:${parts.contractId}#vendor`,
      relation_type: "named_vendor",
      subject_id: parts.procurementId,
      subject_label: contractLabel,
      related_object_id: vendorRef,
      related_object_label: vendor,
      field_or_semantic_key: "vendor",
      source,
    });
  } catch {
    return null;
  }
}

/** Build the durable Land project ↔ exact parcel edge target. */
export function buildProjectParcelRelationshipReportTarget(evidence = {}, item = {}) {
  const projectId = reportClean(evidence?.project_id || evidence?.project_ref, 80).replace(/^project:/, "");
  const projectRef = projectId ? `project:${projectId}` : null;
  const parcelRef = reportClean(item?.ref || item?.object_id, 80);
  const bbl = parcelRef?.match(/^bbl:(\d{10})$/)?.[1] || null;
  if (!projectId || !projectRef || !bbl) return null;
  const projectLabel = reportClean(evidence?.project_name || evidence?.project_label) || `Land-use project ${projectId}`;
  const parcelLabel = reportClean(item?.label) || `Parcel BBL ${bbl}`;
  try {
    return buildRelationshipReportTarget({
      object_type: "land_use_project",
      object_id: projectRef,
      canonical_url: `/browse/zoning/#land/${encodeURIComponent(projectId)}`,
      object_label: projectLabel,
      anchor: `landuse:${projectId}#parcel:${bbl}`,
      relation_type: reportClean(item?.relation) || "sited_on_parcel",
      subject_id: projectRef,
      subject_label: projectLabel,
      related_object_id: parcelRef,
      related_object_label: parcelLabel,
      field_or_semantic_key: "parcel",
      edge: item,
      source: evidence,
    });
  } catch {
    return null;
  }
}

export function reportIssueAction(target, options = {}) {
  const fallbackHref = options?.fallbackHref || DEFAULT_FALLBACK_HREF;
  if (!target) {
    return {
      kind: "link",
      label: "Feedback",
      href: fallbackHref,
      className: "ui-report-issue ui-report-issue-fallback",
      attrs: { "data-report-fallback": "target-construction-failed" },
    };
  }
  try {
    return {
      kind: "button",
      label: options?.label || "Report an issue",
      className: "ui-report-issue",
      attrs: {
        "data-report-target": serializeReportTarget(target),
        "aria-haspopup": "dialog",
      },
    };
  } catch {
    return {
      kind: "link",
      label: "Feedback",
      href: fallbackHref,
      className: "ui-report-issue ui-report-issue-fallback",
      attrs: { "data-report-fallback": "target-construction-failed" },
    };
  }
}

export function renderReportIssueAffordance(target, options = {}) {
  if (!target || typeof target !== "object") return "";
  try {
    const resolved = resolveReportTarget(target);
    if (!resolved || reportTargetIdentity(resolved) !== target.target_id) return "";
    const action = reportIssueAction(target, options);
    const attributes = Object.entries(action.attrs || {})
      .map(([key, value]) => ` ${esc(key)}="${esc(value)}"`)
      .join("");
    if (action.kind === "link") {
      return `<a class="${esc(action.className)}" href="${esc(action.href)}"${attributes}>${esc(action.label)}</a>`;
    }
    return `<button class="${esc(action.className)}" type="button"${attributes}>${esc(action.label)}</button>`;
  } catch {
    return "";
  }
}

function categoryOptions(target) {
  const claimType = target?.claim_anchor?.claim_type;
  const allowed = claimType === "relationship"
    ? RELATIONSHIP_REPORT_CATEGORIES
    : target?.claim_anchor?.field_or_semantic_key === "vendor"
      ? FIELD_REPORT_CATEGORIES
      : null;
  return REPORT_CATEGORIES
    .filter((item) => !allowed || allowed.has(item.value))
    .map((item) => `<option value="${esc(item.value)}">${esc(item.label)}</option>`)
    .join("");
}

function dialogHtml() {
  return `<dialog class="report-issue-dialog" data-report-issue-dialog aria-labelledby="report-issue-heading">
    <div class="report-issue-dialog-inner">
      <button class="report-issue-close" type="button" data-report-close aria-label="Close report form">×</button>
      <h2 id="report-issue-heading">Report an issue</h2>
      <p class="report-issue-intro">Tell us what is wrong with this CityScroll record. Your report is evidence of a disagreement, not an automatic change to the record.</p>
      <div class="report-issue-target" data-report-target-panel>
        <span class="report-issue-target-label" data-report-target-label>Reporting</span>
        <strong data-report-target-description></strong>
        <a data-report-target-link target="_blank" rel="noopener noreferrer"><span data-report-target-link-label>Open this record</span><span class="sr-only"> (opens in new tab)</span></a>
      </div>
      <p class="report-issue-failure" data-report-failure hidden></p>
      <form data-report-form novalidate>
        <input type="hidden" name="report_target">
        <input type="hidden" name="report_target_id">
        <input type="hidden" name="object_id">
        <input type="hidden" name="canonical_url">
        <label for="report-issue-category">Category</label>
        <select id="report-issue-category" name="category" required data-report-category></select>
        <label for="report-issue-message">What is wrong?</label>
        <textarea id="report-issue-message" name="message" required minlength="10" maxlength="2000" data-report-message></textarea>
        <label for="report-issue-evidence">Source or evidence <span class="report-issue-optional">— optional</span></label>
        <textarea id="report-issue-evidence" name="evidence" maxlength="4000" data-report-evidence></textarea>
        <label for="report-issue-email">Email <span class="report-issue-optional">— optional, only if you would like a reply</span></label>
        <input id="report-issue-email" type="email" name="email" autocomplete="email" data-report-email>
        <div class="report-issue-actions">
          <button class="ui-report-issue-submit" type="submit" data-report-submit>Send report</button>
          <button class="ui-report-issue-cancel" type="button" data-report-close>Cancel</button>
        </div>
        <p class="report-issue-status" role="status" aria-live="polite" data-report-status></p>
      </form>
    </div>
  </dialog>`;
}

function showDialog(dialog) {
  try {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  } catch {
    dialog.setAttribute("open", "");
  }
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}

async function postReport(body) {
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  try {
    return await fetch(`${API_ORIGIN()}/feedback`, options);
  } catch {
    return fetch(`${API_FALLBACK_ORIGIN()}/feedback`, options);
  }
}

function installHandlers(dialog, documentRef) {
  let activeTarget = null;
  const form = dialog.querySelector("[data-report-form]");
  const failure = dialog.querySelector("[data-report-failure]");
  const status = dialog.querySelector("[data-report-status]");
  const targetPanel = dialog.querySelector("[data-report-target-panel]");
  const targetLabel = dialog.querySelector("[data-report-target-label]");
  const targetDescription = dialog.querySelector("[data-report-target-description]");
  const targetLink = dialog.querySelector("[data-report-target-link]");
  const category = dialog.querySelector("[data-report-category]");
  const message = dialog.querySelector("[data-report-message]");
  const submit = dialog.querySelector("[data-report-submit]");

  function showFailureState() {
    activeTarget = null;
    targetPanel.hidden = true;
    form.hidden = true;
    failure.hidden = false;
    failure.innerHTML = `This report could not be attached to a specific civic record. Use <a href="${esc(DEFAULT_FALLBACK_HREF)}">generic Feedback</a> instead.`;
    status.textContent = "";
    showDialog(dialog);
  }

  function openForButton(button) {
    let parsed;
    try { parsed = JSON.parse(button.dataset.reportTarget || ""); } catch { parsed = null; }
    const target = resolveReportTarget(parsed);
    if (!target || parsed?.schema !== REPORT_TARGET_SCHEMA || parsed?.target_id !== reportTargetIdentity(target)) {
      showFailureState();
      return;
    }
    activeTarget = target;
    targetPanel.hidden = false;
    form.hidden = false;
    failure.hidden = true;
    targetLabel.textContent = target.claim_anchor?.claim_type === "relationship"
      ? `Reporting ${typeof globalThis.t === "function" ? globalThis.t("scope_relation_connection") : "connection"}`
      : "Reporting";
    targetDescription.textContent = target.description;
    targetLink.href = target.canonical_url;
    form.elements.report_target.value = serializeReportTarget(target);
    form.elements.report_target_id.value = target.target_id;
    form.elements.object_id.value = target.object_id;
    form.elements.canonical_url.value = target.canonical_url;
    category.innerHTML = categoryOptions(target);
    message.value = "";
    form.elements.evidence.value = "";
    form.elements.email.value = "";
    status.textContent = "";
    form.dataset.targetId = target.target_id;
    showDialog(dialog);
    category.focus();
  }

  documentRef.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-report-target]");
    if (!button || !documentRef.contains(button)) return;
    event.preventDefault();
    openForButton(button);
  });
  dialog.querySelectorAll("[data-report-close]").forEach((button) => {
    button.addEventListener("click", () => closeDialog(dialog));
  });
  dialog.addEventListener("close", () => { activeTarget = null; });
  const closeForNavigation = () => closeDialog(dialog);
  globalThis.addEventListener?.("popstate", closeForNavigation);
  globalThis.addEventListener?.("hashchange", closeForNavigation);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeTarget || form.dataset.targetId !== activeTarget.target_id) {
      showFailureState();
      return;
    }
    const explanation = message.value.trim();
    if (explanation.length < 10) {
      status.textContent = "Please explain the issue in at least 10 characters.";
      message.focus();
      return;
    }
    if (!form.reportValidity()) return;
    submit.disabled = true;
    status.textContent = "Sending…";
    try {
      const evidence = form.elements.evidence.value.trim();
      const response = await postReport({
        category: category.value,
        message: explanation,
        evidence,
        email: form.elements.email.value.trim(),
        report_target: activeTarget,
        report: { category: category.value, explanation, evidence },
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.reason || "send-failed");
      status.textContent = "Thanks — your report was sent with this civic record attached.";
      message.value = "";
      form.elements.evidence.value = "";
    } catch (error) {
      status.textContent = error.message === "rate-limited"
        ? "Please try again later."
        : "The report could not be sent. Please try again.";
    } finally {
      submit.disabled = false;
    }
  });
}

let installed = false;

/** Install one delegated handler so SPA re-renders cannot strand report buttons. */
export function installReportIssueUI(documentRef = globalThis.document) {
  if (installed || !documentRef?.body) return false;
  installed = true;
  const wrapper = documentRef.createElement("div");
  wrapper.innerHTML = dialogHtml();
  const dialog = wrapper.firstElementChild;
  documentRef.body.appendChild(dialog);
  installHandlers(dialog, documentRef);
  return true;
}

if (typeof document !== "undefined") {
  if (document.body) installReportIssueUI(document);
  else document.addEventListener("DOMContentLoaded", () => installReportIssueUI(document), { once: true });
}
