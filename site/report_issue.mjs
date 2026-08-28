import {
  REPORT_TARGET_SCHEMA,
  buildReportTarget,
  buildReportTargetFromAnchor,
  buildRelationshipReportTarget,
  REPORT_IDENTITY_INTENTS,
  reportTargetIdentity,
  resolveReportTarget,
  serializeReportTarget,
} from "./report_target.mjs";
import { landRegulatoryEffectForRow } from "./land_regulatory_effect.mjs";

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
const GROUPING_REPORT_CATEGORIES = Object.freeze(new Set([
  "connection_wrong",
  "something_missing",
  "other",
]));
const INTERPRETATION_REPORT_CATEGORIES = Object.freeze(new Set([
  "interpretation_wrong",
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

const IDENTITY_CATEGORY_LABELS = Object.freeze({
  same_thing: "Same person or organization",
  different_things: "Different people or organizations",
});

function identityRef(value) {
  const ref = reportClean(value, 320);
  if (!ref || /\s/.test(ref)) return null;
  if (/^entity:official:[^\s]+$/.test(ref)) return ref;
  if (/^agency:id:[a-z0-9][a-z0-9-]*(?:-[a-z0-9]+)*$/i.test(ref)) return ref;
  if (/^vendor:stem:[^\s]+$/.test(ref)) return ref;
  return null;
}

function identityCanonicalUrl(ref, href) {
  const value = reportClean(href, 600);
  if (!value || !value.startsWith("/")) return null;
  if (ref?.startsWith("entity:official:") && !value.startsWith("/officials/")) return null;
  if (ref?.startsWith("agency:id:") && !value.startsWith("/agencies/")) return null;
  if (ref?.startsWith("vendor:stem:") && !value.startsWith("/vendors/")) return null;
  return value;
}

/** Keep comparison context explicit: a candidate for the current profile is
 * not a comparison choice, and an object report has no identity picker. */
export function identityComparisonCandidates(target, candidates = target?.identity_candidates) {
  if (target?.claim_anchor?.claim_type !== "identity") return [];
  const current = target.object_id;
  return [...new Map((Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.entity_id && candidate.entity_id !== current)
    .map((candidate) => [candidate.entity_id, candidate])).values()];
}

export function hasIdentityComparisonCandidates(target, candidates = target?.identity_candidates) {
  return identityComparisonCandidates(target, candidates).length > 0;
}

/** Build the initial identity-report target for an existing person or
 * organization profile. The second profile is selected in the shared report
 * dialog, then added to the final immutable target at submission time. */
export function buildEntityProfileReportTarget({
  entity_ref,
  entity_id,
  canonical_url,
  object_label,
  identity_lookup_href = "/data/people_organizations_read_model.json",
  identity_candidates = null,
} = {}) {
  const ref = identityRef(entity_ref || entity_id);
  const href = identityCanonicalUrl(ref, canonical_url);
  const label = reportClean(object_label, 1_000);
  if (!ref || !href || !label) return null;
  try {
    return buildReportTarget({
      object_type: "entity",
      object_id: ref,
      canonical_url: href,
      object_label: label,
      claim_anchor: {
        anchor: `${ref}#identity`,
        claim_type: "identity",
        field_or_semantic_key: "identity",
        subject_id: ref,
        subject_label: label,
      },
      identity_lookup_href,
      identity_candidates,
    });
  } catch {
    return null;
  }
}

/** Add the expert's explicit same/different hypothesis and the selected
 * existing profile to an identity target. This function changes only the
 * report payload, never a canonical entity record. */
export function buildEntityIdentityReportTarget({
  source_target = null,
  entity_ref,
  entity_id,
  canonical_url,
  object_label,
  other_entity_ref,
  other_entity_id,
  other_entity_label,
  identity_intent,
  identity_lookup_href = null,
  identity_candidates = null,
  provenance = null,
  source = null,
} = {}) {
  const sourceTarget = source_target || buildEntityProfileReportTarget({
    entity_ref,
    entity_id,
    canonical_url,
    object_label,
    identity_lookup_href,
    identity_candidates,
  });
  const subject = identityRef(sourceTarget?.object_id || entity_ref || entity_id);
  const object = identityRef(other_entity_ref || other_entity_id);
  const intent = reportClean(identity_intent, 80);
  const subjectLabel = reportClean(sourceTarget?.object_label || object_label, 1_000);
  const objectLabel = reportClean(other_entity_label, 1_000);
  if (!sourceTarget || !subject || !object || subject === object || !objectLabel
    || !REPORT_IDENTITY_INTENTS.includes(intent)) return null;
  try {
    return buildReportTarget({
      object_type: "entity",
      object_id: subject,
      canonical_url: sourceTarget.canonical_url,
      object_label: subjectLabel,
      claim_anchor: {
        ...(sourceTarget.claim_anchor || {}),
        anchor: `${subject}#identity`,
        claim_type: "identity",
        field_or_semantic_key: "identity",
        subject_id: subject,
        subject_label: subjectLabel,
        object_id: object,
        object_label: objectLabel,
        identity_intent: intent,
      },
      identity_lookup_href: identity_lookup_href || sourceTarget.identity_lookup_href,
      identity_candidates: identity_candidates || sourceTarget.identity_candidates,
      provenance: provenance || sourceTarget.provenance,
      source,
    });
  } catch {
    return null;
  }
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

function vendorIdentityRef(value) {
  const pivots = globalThis.CrolEntityPivots;
  if (typeof pivots?.entityRouteRef === "function") {
    return reportClean(pivots.entityRouteRef("vendor", value), 320);
  }
  // Direct module consumers may not have loaded the browser identity namespace.
  // Keep the same typed fallback shape; the application path above remains the
  // authoritative vendor identity model.
  const stem = reportClean(value, 320)
    ?.toUpperCase()
    .replace(/[.,'’&]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(INCORPORATED|INC|LLC|L\.L\.C|CORPORATION|CORP|COMPANY|CO|LTD|LIMITED|LP|LLP|PLLC|P\.C|PC|USA|OF NY|OF NEW YORK)\.?$/, "")
    .trim();
  return stem ? `vendor:stem:${encodeURIComponent(stem)}` : null;
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
  const vendorRef = existingVendorRef(source, details) || (vendor ? vendorIdentityRef(vendor) : null);
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

function sourceRecordId(record) {
  return reportClean(
    record?.source_record_id
      || record?.source_record_identifier
      || record?.source_observation_ref
      || record?.request_id
      || record?.project_id,
    500,
  );
}

function sourcePayload(records, extra = null) {
  return (Array.isArray(records) ? records : [])
    .filter(record => record && typeof record === "object")
    .map(record => {
      const id = sourceRecordId(record);
      return id ? { ...record, source_record_id: id } : record;
    })
    .concat(extra && typeof extra === "object" ? [extra] : []);
}

function constituentNoticeIds(records) {
  return [...new Set((Array.isArray(records) ? records : [])
    .map(record => {
      const requestId = reportClean(record?.request_id, 320);
      if (requestId) return `notice:${requestId}`;
      return reportClean(record?.meeting_id || record?.object_id, 500);
    })
    .filter(Boolean))];
}

function meetingReportObjectId(entry) {
  const primary = entry?.primary || {};
  const candidate = reportClean(primary.meeting_id || entry?.meeting_id || entry?.subject_ref, 500);
  if (candidate?.startsWith("meeting:")) return candidate;
  if (candidate?.startsWith("meeting-object:meeting:")) return candidate.slice("meeting-object:".length);
  return null;
}

/** Build a hypothesis about a collapsed meeting while retaining every notice. */
export function buildMeetingGroupingReportTarget(entry = {}) {
  if (!entry || !["event", "matter"].includes(entry.kind) || Number(entry.notice_count) < 2) return null;
  const objectId = meetingReportObjectId(entry);
  const members = Array.isArray(entry.members) ? entry.members : [];
  const constituentIds = constituentNoticeIds(members);
  if (!objectId || constituentIds.length < 2) return null;
  const label = reportClean(entry.title || entry.primary?.title || entry.primary?.decides, 1_000)
    || `Meeting ${objectId.slice("meeting:".length)}`;
  const scope = reportClean(entry.place_scope || entry.primary?.affected_area?.scope, 80);
  const assertedMeaning = `The published notices are presented as one meeting${scope ? ` with ${scope} place semantics` : ""}: ${label}.`;
  try {
    return buildReportTarget({
      object_type: "meeting",
      object_id: objectId,
      canonical_url: `/meetings/${encodeURIComponent(objectId)}`,
      object_label: label,
      claim_anchor: {
        anchor: `${objectId}#collapsed_notices`,
        claim_type: "grouping",
        subject_id: objectId,
        field_or_semantic_key: "collapsed_notices",
        rendered_value: `${members.length} notices presented as one meeting`,
      },
      asserted_meaning: assertedMeaning,
      constituent_object_ids: constituentIds,
      source: sourcePayload(members),
    });
  } catch {
    return null;
  }
}

/** Build a hypothesis about a multi-notice rulemaking lifecycle. */
export function buildRulemakingLifecycleReportTarget(entry = {}) {
  if (!entry || entry.kind !== "rulemaking" || Number(entry.notice_count) < 2) return null;
  const objectId = reportClean(entry.subject_ref, 500);
  const members = Array.isArray(entry.members) ? entry.members : [];
  const constituentIds = constituentNoticeIds(members);
  if (!objectId?.startsWith("rulemaking:") || constituentIds.length < 2) return null;
  const label = reportClean(entry.title || entry.primary?.short_title, 1_000) || objectId;
  const sources = sourcePayload(members, entry.rule_url ? { source_url: entry.rule_url } : null);
  try {
    return buildReportTarget({
      object_type: "rulemaking",
      object_id: objectId,
      canonical_url: "/#rules",
      object_label: label,
      claim_anchor: {
        anchor: `${objectId}#lifecycle`,
        claim_type: "lifecycle",
        subject_id: objectId,
        field_or_semantic_key: "lifecycle",
        rendered_value: `${members.length} notices presented as one rulemaking lifecycle`,
      },
      asserted_meaning: `The published notices are presented as one rulemaking lifecycle: ${label}.`,
      constituent_object_ids: constituentIds,
      source: sources,
    });
  } catch {
    return null;
  }
}

/** Build a hypothesis about a plain-English land-use effect derived from source material. */
export function buildLandRegulatoryEffectReportTarget(record = {}) {
  const projectId = reportClean(record?.project_id || record?.object_id, 320);
  const effect = landRegulatoryEffectForRow(record);
  if (!projectId || !effect || !["upzone", "downzone", "mixed", "no_density_change"].includes(effect.effect)
    || !["high", "medium"].includes(effect.confidence)) return null;
  const objectId = projectId.startsWith("project:") ? projectId : `project:${projectId}`;
  const sourceUrls = [
    ...(effect.existing?.districts || []),
    ...(effect.proposed?.districts || []),
  ].map(district => district?.citation?.url).filter(Boolean);
  const source = sourcePayload([record], { source_urls: sourceUrls });
  try {
    const effectLabel = effect.effect.replaceAll("_", " ");
    const target = buildReportTarget({
      object_type: "land_use_project",
      object_id: objectId,
      canonical_url: `/browse/zoning/#land/${encodeURIComponent(projectId.replace(/^project:/, ""))}`,
      object_label: reportClean(record?.project_name || record?.title, 1_000) || `Land-use project ${projectId.replace(/^project:/, "")}`,
      claim_anchor: {
        anchor: `landuse:${projectId.replace(/^project:/, "")}#regulatory-effect`,
        claim_type: "interpretation",
        subject_id: objectId,
        field_or_semantic_key: "regulatory-effect",
        rendered_value: effectLabel,
      },
      asserted_meaning: `The project source material is interpreted as ${effectLabel} for ${reportClean(record?.project_name || record?.title, 1_000) || `Land-use project ${projectId.replace(/^project:/, "")}`}.`,
      constituent_object_ids: [objectId],
      source,
    });
    return target.provenance?.source_urls?.length ? target : null;
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
  if (claimType === "identity") {
    return REPORT_CATEGORIES
      .filter((item) => Object.hasOwn(IDENTITY_CATEGORY_LABELS, item.value))
      .map((item) => `<option value="${esc(item.value)}">${esc(IDENTITY_CATEGORY_LABELS[item.value])}</option>`)
      .join("");
  }
  const allowed = claimType === "relationship"
    ? RELATIONSHIP_REPORT_CATEGORIES
    : ["grouping", "lifecycle"].includes(claimType)
      ? GROUPING_REPORT_CATEGORIES
      : claimType === "interpretation"
        ? INTERPRETATION_REPORT_CATEGORIES
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
        <fieldset class="report-identity-picker" data-report-identity-picker hidden>
          <legend>Which existing profile is this report about?</legend>
          <p class="report-identity-help">Choose the other person or organization profile you are comparing. Selecting a profile records a hypothesis for review; it does not change either profile.</p>
          <label for="report-identity-search">Find a profile</label>
          <input id="report-identity-search" type="search" autocomplete="off" data-report-identity-search placeholder="Search names and organizations">
          <div class="report-identity-results" role="list" aria-label="Existing people and organization profiles" data-report-identity-results></div>
          <p class="report-identity-selected" data-report-identity-selected role="status" aria-live="polite"></p>
        </fieldset>
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
  const identityPicker = dialog.querySelector("[data-report-identity-picker]");
  const identitySearch = dialog.querySelector("[data-report-identity-search]");
  const identityResults = dialog.querySelector("[data-report-identity-results]");
  const identitySelected = dialog.querySelector("[data-report-identity-selected]");
  let identityCandidates = [];
  let selectedIdentity = null;
  let identityLoadToken = 0;

  function identityKindLabel(kind) {
    return ({ official: "Person profile", agency: "Agency profile", vendor: "Organization profile" })[kind] || "Profile";
  }

  function renderIdentityCandidates() {
    if (!identityResults) return;
    const query = String(identitySearch?.value || "").trim().toLowerCase();
    const shown = identityCandidates.filter((candidate) => !query
      || `${candidate.label} ${identityKindLabel(candidate.kind)}`.toLowerCase().includes(query));
    identityResults.innerHTML = shown.length
        ? shown.map((candidate) => `<div class="report-identity-result" role="listitem">
          <button type="button" data-report-identity-candidate="${esc(candidate.entity_id)}" data-report-identity-label="${esc(candidate.label)}" data-report-identity-href="${esc(candidate.href)}" data-report-identity-kind="${esc(candidate.kind || "profile")}">
            <span>${esc(candidate.label)}</span><small>${esc(identityKindLabel(candidate.kind))}</small>
          </button>
          <a href="${esc(candidate.href)}" target="_blank" rel="noopener noreferrer"><span>Open profile</span><span class="sr-only"> (opens in new tab)</span></a>
        </div>`).join("")
      : `<p class="report-identity-empty" role="listitem">No matching existing profiles. Try a broader search; nothing is selected automatically.</p>`;
  }

  function setSelectedIdentity(candidate) {
    selectedIdentity = candidate;
    if (identitySelected) identitySelected.textContent = candidate
      ? `Selected: ${candidate.label} (${identityKindLabel(candidate.kind)}).`
      : "";
    identityResults?.querySelectorAll("[data-report-identity-candidate]").forEach((button) => {
      button.setAttribute("aria-pressed", button.dataset.reportIdentityCandidate === candidate?.entity_id ? "true" : "false");
    });
  }

  async function loadIdentityCandidates(target) {
    const token = ++identityLoadToken;
    identityCandidates = Array.isArray(target.identity_candidates) ? target.identity_candidates : [];
    if (!identityCandidates.length && target.identity_lookup_href) {
      try {
        const response = await fetch(target.identity_lookup_href, { cache: "force-cache", credentials: "omit" });
        const model = response.ok ? await response.json() : null;
        identityCandidates = Array.isArray(model?.rows) ? model.rows
          .filter((row) => ["official", "agency", "vendor"].includes(row?.kind) && row?.entity_ref && row?.label && row?.href)
          .map((row) => ({ entity_id: row.entity_ref, label: row.label, href: row.href, kind: row.kind })) : [];
      } catch {
        identityCandidates = [];
      }
    }
    if (token !== identityLoadToken) return;
    identityCandidates = identityComparisonCandidates(target, identityCandidates);
    const comparisonAvailable = hasIdentityComparisonCandidates(target, identityCandidates);
    identityPicker.hidden = !comparisonAvailable;
    if (comparisonAvailable) renderIdentityCandidates();
    else identityResults.innerHTML = "";
  }

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
    const isIdentity = target.claim_anchor?.claim_type === "identity";
    identityPicker.hidden = true;
    selectedIdentity = null;
    identitySearch.value = "";
    identitySelected.textContent = "";
    identityResults.innerHTML = "";
    if (isIdentity) loadIdentityCandidates(target);
    message.value = "";
    form.elements.evidence.value = "";
    form.elements.email.value = "";
    status.textContent = "";
    form.dataset.targetId = target.target_id;
    showDialog(dialog);
    category.focus();
  }

  category.addEventListener("change", () => {
    if (activeTarget?.claim_anchor?.claim_type === "identity") setSelectedIdentity(selectedIdentity);
  });
  identitySearch?.addEventListener("input", renderIdentityCandidates);
  identityResults?.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-report-identity-candidate]");
    if (!button) return;
    setSelectedIdentity({
      entity_id: button.dataset.reportIdentityCandidate,
      label: button.dataset.reportIdentityLabel,
      href: button.dataset.reportIdentityHref,
      kind: button.dataset.reportIdentityKind || "profile",
    });
  });

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
    if (activeTarget.claim_anchor?.claim_type === "identity") {
      if (selectedIdentity) {
        const identityTarget = buildEntityIdentityReportTarget({
          source_target: activeTarget,
          other_entity_ref: selectedIdentity.entity_id,
          other_entity_label: selectedIdentity.label,
          identity_intent: category.value === "same_thing" ? "same_entity" : "different_entities",
        });
        if (!identityTarget) {
          showFailureState();
          return;
        }
        activeTarget = identityTarget;
        form.dataset.targetId = identityTarget.target_id;
        form.elements.report_target.value = serializeReportTarget(identityTarget);
        form.elements.report_target_id.value = identityTarget.target_id;
        form.elements.object_id.value = identityTarget.object_id;
        form.elements.canonical_url.value = identityTarget.canonical_url;
      } else if (identityCandidates.length) {
        status.textContent = "Choose an existing profile before sending this identity report.";
        identitySearch?.focus();
        return;
      } else {
        // A profile report with no comparison context remains a normal
        // current-subject report; only an explicit selection creates a
        // same/different identity hypothesis.
        activeTarget = buildReportTarget({
          object_type: activeTarget.object_type,
          object_id: activeTarget.object_id,
          canonical_url: activeTarget.canonical_url,
          object_label: activeTarget.object_label,
          provenance: activeTarget.provenance,
        });
        form.dataset.targetId = activeTarget.target_id;
        form.elements.report_target.value = serializeReportTarget(activeTarget);
        form.elements.report_target_id.value = activeTarget.target_id;
      }
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
