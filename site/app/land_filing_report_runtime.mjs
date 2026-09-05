/**
 * LDP-27: the route-lazy structured filing-report detail view. Fetched only
 * when a reader presses "View full report" -- never on Land entry, never on
 * project selection -- so a full RER extraction never enters the first-paint
 * transfer (A6, A7). Mirrors `map_runtime.mjs`'s activation shape: a plain
 * module with no side effects at import time, registered behind
 * `globalThis.ensureLandFilingReportRuntime` in `main.mjs`.
 *
 * Renders application scope, the proposed-development scope (kept visually
 * and semantically distinct from application scope -- A1), residential and
 * non-residential/employment facts, construction-employment estimates,
 * community geography/vintage, the fair-housing narrative, extraction-quality
 * disclosure per field, and the original document link. Every value carries
 * its page/span/region citation or an explicit abstention reason -- never a
 * bare number.
 */

export const LAND_FILING_REPORT_DATA_DIR = "data/land_filing_reports";

function fmtDate(value) {
  return value ? String(value).slice(0, 10) : null;
}

function citationText(evidence, translate) {
  if (!evidence) return translate("land_filing_no_citation");
  if (evidence.page_number != null) return translate("land_filing_page_citation", { page: evidence.page_number });
  if (evidence.span) return translate("land_filing_span_citation");
  if (evidence.region) return translate("land_filing_region_citation");
  return translate("land_filing_no_citation");
}

function fieldLabel(fieldName, translate) {
  const key = `land_filing_field_${fieldName}`;
  const label = translate(key);
  return label === key ? fieldName : label;
}

function fieldRowHTML(field, { translate, esc }) {
  if (!field) return "";
  const label = esc(fieldLabel(field.field_name, translate));
  if (field.abstained) {
    return `<div class="land-filing-field" data-land-filing-field="${esc(field.field_name)}" data-abstained="1"><dt>${label}</dt><dd data-land-filing-abstained="1">${esc(translate("land_filing_field_abstained"))} — ${esc(field.abstention_reason || "")}</dd></div>`;
  }
  const value = field.value != null ? `${esc(field.value)}${field.unit ? ` ${esc(field.unit)}` : ""}` : esc(field.raw_value || "");
  const citation = esc(citationText(field.evidence, translate));
  const confidence = esc(translate(`land_filing_confidence_${field.confidence || "unknown"}`));
  return `<div class="land-filing-field" data-land-filing-field="${esc(field.field_name)}" data-confidence="${esc(field.confidence || "unknown")}"><dt>${label}</dt><dd><span data-land-filing-field-value="1">${value}</span> <span class="land-filing-citation" data-land-filing-citation="1">(${citation}, ${confidence})</span></dd></div>`;
}

function sectionHTML(sectionKey, section, { translate, esc }) {
  if (!section) return "";
  const rows = Object.values(section).map((field) => fieldRowHTML(field, { translate, esc })).join("");
  if (!rows) return "";
  return `<div class="land-filing-report-section" data-land-filing-report-section="${esc(sectionKey)}"><h4>${esc(translate(`land_filing_section_${sectionKey}`))}</h4><dl>${rows}</dl></div>`;
}

function communityProfileHTML(profile, { translate, esc }) {
  if (!profile) return "";
  const indicatorRows = Object.values(profile.indicators || {}).map((field) => fieldRowHTML(field, { translate, esc })).join("");
  return `<div class="land-filing-report-section" data-land-filing-report-section="community_profile"><h4>${esc(translate("land_filing_section_community_profile"))}</h4>
    <p class="land-filing-as-filed" data-land-filing-as-filed="1">${esc(translate("land_filing_community_profile_as_filed", { geography: profile.geography, vintage: profile.vintage }))}</p>
    <dl>${indicatorRows}</dl>
  </div>`;
}

/** The negative rule: the displacement index is neighbourhood context, never a prediction of this project's effects. */
function displacementRiskHTML(risk, { translate, esc }) {
  if (!risk) return "";
  const indexField = risk.index_value ? fieldRowHTML(risk.index_value, { translate, esc }) : "";
  return `<div class="land-filing-report-section" data-land-filing-report-section="displacement_risk"><h4>${esc(translate("land_filing_section_displacement_risk"))}</h4>
    <p class="land-filing-dri-note" data-land-filing-dri-note="1">${esc(translate("land_filing_displacement_index_note"))}</p>
    <dl>${indexField}</dl>
  </div>`;
}

function narrativeHTML(sectionKey, narrative, { translate, esc }) {
  if (!narrative) return "";
  const sourceLabel = translate(`land_filing_narrative_source_${narrative.source}`);
  return `<div class="land-filing-report-section" data-land-filing-report-section="${esc(sectionKey)}"><h4>${esc(translate(`land_filing_section_${sectionKey}`))}</h4>
    <p class="land-filing-narrative-source" data-land-filing-narrative-source="${esc(narrative.source)}">${esc(sourceLabel)}</p>
    <p class="land-filing-narrative-text">${esc(narrative.text)}</p>
  </div>`;
}

function extractionQualityDisclosureHTML(fieldEvidence, { translate, esc }) {
  if (!fieldEvidence) return "";
  return `<p class="land-filing-extraction-disclosure" data-land-filing-extraction-disclosure="1" data-overall-quality="${esc(fieldEvidence.overall_quality || "unknown")}">${esc(translate("land_filing_extraction_disclosure", {
    observed: fieldEvidence.field_count - fieldEvidence.abstained_count,
    total: fieldEvidence.field_count,
    quality: translate(`land_filing_extraction_quality_${fieldEvidence.overall_quality || "unknown"}`),
  }))}</p>`;
}

export function landFilingReportDetailHTML(detail, { t, escape } = {}) {
  if (!detail || detail.schema !== "cityscroll.land_filing_evidence_report_detail.v1") return "";
  const translate = typeof t === "function" ? t : (key) => key;
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");
  const prepDate = fmtDate(detail.report_preparation_date);
  const originalHref = detail.original_document?.canonical_public_url || detail.original_document?.discovery_endpoint;
  const originalLinkHTML = originalHref
    ? `<a class="ui-official-source-link" href="${esc(originalHref)}" target="_blank" rel="noopener noreferrer">${esc(detail.original_document.original_name || translate("land_outcomes_document_lbl"))}<span aria-hidden="true">↗</span></a>`
    : esc(translate("land_filing_source_unavailable"));

  return `<div class="land-filing-report" data-land-filing-report="1" data-document-ref="${esc(detail.document_ref)}">
    <p class="land-filing-report-meta">${prepDate ? `${esc(translate("land_filing_preparation_date"))}: ${esc(prepDate)} · ` : ""}${originalLinkHTML}</p>
    ${extractionQualityDisclosureHTML(detail.field_evidence, { translate, esc })}
    ${sectionHTML("application_scope", detail.application_scope, { translate, esc })}
    ${sectionHTML("proposed_development_scope", detail.proposed_development_scope, { translate, esc })}
    ${narrativeHTML("executive_summary", detail.executive_summary, { translate, esc })}
    ${sectionHTML("residential", detail.residential, { translate, esc })}
    ${sectionHTML("non_residential", detail.non_residential, { translate, esc })}
    ${sectionHTML("construction_employment", detail.construction_employment, { translate, esc })}
    ${communityProfileHTML(detail.community_profile, { translate, esc })}
    ${displacementRiskHTML(detail.displacement_risk, { translate, esc })}
    ${narrativeHTML("fair_housing_narrative", detail.fair_housing_narrative, { translate, esc })}
  </div>`;
}

export function loadLandFilingReportDetail(documentRef) {
  const url = `${LAND_FILING_REPORT_DATA_DIR}/${encodeURIComponent(documentRef)}.json`;
  return fetch(url, { cache: "force-cache", credentials: "omit" })
    .then((response) => response.ok ? response.json() : null)
    .catch(() => null);
}

export function landFilingReportFailureHTML({ t, escape } = {}) {
  const translate = typeof t === "function" ? t : (key) => key;
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");
  return `<p class="land-filing-report-failure" data-land-filing-report-failure="1">${esc(translate("land_filing_report_load_failed"))}</p>`;
}

/**
 * Mounts the full structured report into `root` (the compact summary's own
 * `[data-land-filing-report-detail-root]` placeholder). Idempotent: a second
 * call for a different document replaces the first mount rather than
 * appending beside it.
 */
export async function mountLandFilingReportDetail(root, documentRef, { t, escape } = {}) {
  if (!root) return;
  root.hidden = false;
  const detail = await loadLandFilingReportDetail(documentRef);
  root.innerHTML = detail
    ? landFilingReportDetailHTML(detail, { t, escape })
    : landFilingReportFailureHTML({ t, escape });
}

export function unmountLandFilingReportDetail(root) {
  if (!root) return;
  root.innerHTML = "";
  root.hidden = true;
}
