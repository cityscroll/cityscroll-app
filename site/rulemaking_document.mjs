import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeActions,
  renderNodeBack,
  renderNodeFooter,
  renderNodeSection,
} from "./civic_document_chrome.mjs";
import { rulesCardInteractionProjection } from "./rules_card_interaction.mjs";
import { buildRulesPhaseView } from "./rules_phase_spine.mjs";
import { renderPetitionHandoff } from "./rules_petition.mjs";
import { renderRulesExceptionModes } from "./rules_exception_modes.mjs";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const clean = (value, max = 2_000) => String(value ?? "")
  .replace(/<[^>]*>/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function date(value) {
  const match = clean(value, 80).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function prettyDate(value) {
  const day = date(value);
  if (!day) return "Date not stated";
  const parsed = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? day : parsed.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

function hrefAttrs(href) {
  return /^https?:\/\//i.test(href)
    ? ' target="_blank" rel="noopener noreferrer"'
    : "";
}

function historyEventMarkup(event) {
  if (!event?.trace_href) return "";
  const dateMarkup = event.date_state === "known"
    ? prettyDate(event.observed_date)
    : event.unknown_date_label;
  const recordLink = event.record_href && event.record_href !== event.trace_href
    ? ` · <a href="${esc(event.record_href)}">${esc(event.record_label)}</a>`
    : "";
  const sourceDetail = [event.source_label, event.source_field].filter(Boolean).join(" · ");
  return `<li class="rule-history-event" data-event-kind="observed" data-date-state="${esc(event.date_state)}" data-event-type="${esc(event.event_type)}">
    <div class="rule-history-event-heading">
      <span class="tag rule-history-marker">${esc(event.marker)}</span>
      <strong><a href="${esc(event.trace_href)}"${hrefAttrs(event.trace_href)}>${esc(event.label)}</a></strong>
      <time class="rule-history-date" datetime="${esc(event.observed_date || "")}">${esc(dateMarkup)}</time>
    </div>
    <p class="rule-history-event-meta">${esc(sourceDetail)} · <a href="${esc(event.trace_href)}"${hrefAttrs(event.trace_href)}>${esc(event.trace_label)}</a>${recordLink}</p>
  </li>`;
}

function derivedHistoryMarkup(derived) {
  if (!derived) return "";
  const basis = (derived.basis_event_refs || []).filter((ref) => ref?.href).map((ref) =>
    `<li><a href="${esc(ref.href)}"${hrefAttrs(ref.href)}>${esc(ref.label)}</a></li>`
  ).join("");
  return `<li class="rule-history-event rule-history-derived" data-event-kind="derived">
    <div class="rule-history-event-heading">
      <span class="tag rule-history-marker">${esc(derived.marker || "Derived")}</span>
      <strong>${esc(derived.label)}</strong>
    </div>
    <p class="rule-history-event-meta">${esc(derived.basis)}</p>
    ${basis ? `<p class="rule-history-basis-label">${esc(derived.basis_label)}</p><ul class="rule-history-basis">${basis}</ul>` : ""}
  </li>`;
}

function historyTimelineMarkup(object) {
  const model = object.history_timeline || buildRulesPhaseView(object, { skipStitch: true }).history_timeline;
  if (!model) return "";
  const events = (model.events || []).map(historyEventMarkup).filter(Boolean).join("");
  const missing = (model.missing_events || []).map((event) => event.label).join(", ");
  const coverage = model.coverage || {};
  const missingMarkup = missing
    ? `<p class="rule-history-missing" data-missing-events="${esc((coverage.missing_event_types || []).join(","))}">${esc(coverage.missing_note)}</p>`
    : "";
  return `<div class="rule-history" data-history-coverage="${esc(coverage.state || "unknown")}">
    <p class="rule-history-coverage">${esc(coverage.note)}</p>
    <ol class="rule-history-timeline" aria-label="${esc(model.label)}">
      ${events}${derivedHistoryMarkup(model.derived)}
    </ol>
    ${missingMarkup}
  </div>`;
}

const VERSION_LABELS = Object.freeze({
  proposed: "Proposed version",
  revised: "Revised proposed version",
  adopted: "Adopted version",
  emergency: "Emergency version",
});

function versionAnchor(version) {
  const value = `${version?.kind || "version"}-${version?.source_id || "unknown"}`;
  return `rule-version-${value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function versionDateMarkup(version) {
  if (version.effective_date) {
    const basis = version.effective_date_basis === "source_stated" ? "Source-stated" : "Observed";
    return `<div><dt>Effective date</dt><dd>${esc(prettyDate(version.effective_date))} <span class="muted">(${esc(basis)})</span></dd></div>`;
  }
  return `<div><dt>Effective date</dt><dd>Not stated in the retained version source</dd></div>`;
}

function versionMarkup(version) {
  const source = version.source_url
    ? `<a class="ui-official-source-link" href="${esc(version.source_url)}" target="_blank" rel="noopener noreferrer">Open source document<span aria-hidden="true">↗</span></a>`
    : `<span class="muted">Source link not retained</span>`;
  const text = version.text_status === "available"
    ? `<details class="rule-version-text"><summary>Read retained text</summary><p>${esc(version.text)}</p></details>`
    : `<p class="muted">Version text not acquired; the source remains visible as an incomplete document record.</p>`;
  const authority = (version.authority || []).map((item) => `<li>${esc(item.label)} <span class="muted">· source-stated</span></li>`).join("");
  const effects = (version.legal_effects || []).map((effect) => {
    const target = effect.target || {};
    const targetMarkup = target.href
      ? `<a href="${esc(target.href)}">${esc(target.label)}</a>`
      : `<span>${esc(target.label || "Legal-code target")}</span>`;
    return `<li><strong>${esc(effect.kind)}</strong> ${targetMarkup} <span class="muted">· source-stated</span></li>`;
  }).join("");
  const held = (version.held_references || []).length
    ? `<p class="muted">${version.held_references.length} citation/effect reference${version.held_references.length === 1 ? "" : "s"} held because the source did not provide an exact supported target.</p>`
    : "";
  return `<article id="${esc(versionAnchor(version))}" class="rule-version" data-version-kind="${esc(version.kind)}" data-text-status="${esc(version.text_status)}">
    <header><p class="node-kicker">${esc(VERSION_LABELS[version.kind] || "Rule version")}</p><h3>${esc(version.source_label || VERSION_LABELS[version.kind] || "Rule version")}</h3></header>
    <dl class="rule-version-facts"><div><dt>Published</dt><dd>${esc(version.published_at ? prettyDate(version.published_at) : "Date not stated")}</dd></div>${versionDateMarkup(version)}</dl>
    ${version.text_preview ? `<p class="rule-version-preview">${esc(version.text_preview)}</p>` : ""}
    ${text}
    ${authority ? `<section class="rule-version-authority"><h4>Authority stated in source</h4><ul>${authority}</ul></section>` : ""}
    ${effects ? `<section class="rule-version-effects"><h4>What this version changes</h4><ul>${effects}</ul></section>` : ""}
    ${held}${source}
  </article>`;
}

function diffReason(reason) {
  return {
    unpaired_versions: "A proposed and adopted version could not be paired from retained source evidence.",
    ambiguous_pairing: "More than one proposed or adopted document matched the pairing key, so the comparison is held.",
    non_text_proposed: "The proposed document is scanned or otherwise non-text; a text comparison is unavailable.",
    non_text_adopted: "The adopted document is scanned or otherwise non-text; a text comparison is unavailable.",
    text_unavailable_proposed: "The proposed document text was not acquired; a text comparison is unavailable.",
    text_unavailable_adopted: "The adopted document text was not acquired; a text comparison is unavailable.",
    ambiguous_section_alignment: "The retained sections could not be aligned deterministically; a text comparison is unavailable.",
    section_alignment_limit: "The retained documents contain too many sections for a bounded deterministic comparison.",
    missing_text: "One or both retained documents contain no comparable text.",
  }[reason] || "The retained documents cannot be compared yet.";
}

function sourceLinkMarkup(link, label) {
  return link?.href
    ? `<a class="ui-official-source-link" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">${esc(label)}<span aria-hidden="true">↗</span></a>`
    : `<span class="muted">${esc(label)} link not retained</span>`;
}

function diffRegionMarkup(region, index) {
  const proposed = region.proposed_span;
  const adopted = region.adopted_span;
  const proposedText = proposed?.text || "No corresponding proposed text";
  const adoptedText = adopted?.text || "No corresponding adopted text";
  const proposedSource = proposed ? sourceLinkMarkup({ href: proposed.source_url }, "Proposed source") : "";
  const adoptedSource = adopted ? sourceLinkMarkup({ href: adopted.source_url }, "Adopted source") : "";
  return `<li class="rule-version-diff-region" data-region-kind="${esc(region.kind)}">
    <h4>Changed region ${index + 1}${region.section_label ? ` · ${esc(region.section_label)}` : ""}</h4>
    <div class="rule-version-diff-columns">
      <div><p class="muted">Proposed</p><p class="rule-version-diff-text rule-version-diff-removed">${esc(proposedText)}</p><p class="rule-version-diff-source">${proposedSource}</p></div>
      <div><p class="muted">Adopted</p><p class="rule-version-diff-text rule-version-diff-added">${esc(adoptedText)}</p><p class="rule-version-diff-source">${adoptedSource}</p></div>
    </div>
  </li>`;
}

function ruleVersionDiffMarkup(object) {
  const diffs = Array.isArray(object.diffs) ? object.diffs : [];
  const versions = Array.isArray(object.versions) ? object.versions : [];
  const comments = Array.isArray(object.comment_observations) ? object.comment_observations : [];
  const explanations = Array.isArray(object.agency_explanations) ? object.agency_explanations : [];
  if (!versions.length) return "";
  const diffMarkup = diffs.map((diff) => {
    const proposed = versions.find((version) => version.id === diff.proposed_version_id);
    const adopted = versions.find((version) => version.id === diff.adopted_version_id);
    const proposedAnchor = proposed ? `<a href="#${esc(versionAnchor(proposed))}">Proposed version</a>` : "Proposed version";
    const adoptedAnchor = adopted ? `<a href="#${esc(versionAnchor(adopted))}">Adopted version</a>` : "Adopted version";
    if (diff.status !== "available") {
      const links = (diff.source_links || []).map((link) => sourceLinkMarkup(link, link.kind === "adopted" ? "Adopted source" : "Proposed source")).join(" · ");
      return `<article class="rule-version-diff" data-diff-state="unavailable"><h3>Proposed-to-adopted text comparison</h3><p class="rule-version-diff-state">${esc(diffReason(diff.reason_code))}</p><p class="rule-version-diff-navigation">${proposedAnchor} · ${adoptedAnchor}${links ? ` · ${links}` : ""}</p></article>`;
    }
    const count = Number(diff.changed_region_count) || 0;
    const regions = (diff.regions || []).map((region, index) => diffRegionMarkup(region, index)).join("");
    return `<article class="rule-version-diff" data-diff-state="available" data-changed-region-count="${count}">
      <h3>What changed between proposed and adopted text?</h3>
      <p class="rule-version-diff-summary">${count ? `${count} changed region${count === 1 ? "" : "s"} found in deterministically aligned sections.` : "No text changes found in the deterministically aligned retained sections."}</p>
      <p class="rule-version-diff-navigation">${proposedAnchor} · ${adoptedAnchor}</p>
      ${regions ? `<ol class="rule-version-diff-regions">${regions}</ol>` : ""}
    </article>`;
  }).join("");
  const evidence = comments.length || explanations.length
    ? `<section class="rule-change-evidence"><h3>Separate change evidence</h3>
      ${comments.length ? `<p data-change-evidence="comments">Comments observed in ${comments.length} retained source${comments.length === 1 ? "" : "s"}; this is reported separately from text changes.</p>` : ""}
      ${explanations.map((item) => `<p data-change-evidence="agency-explanation">Agency explanation published: “${esc(item.text)}” ${sourceLinkMarkup({ href: item.source_url }, "Open source")}</p>`).join("")}
      <p class="muted">Observed comments and text changes are separate facts; this comparison does not establish that comments caused a change.</p>
    </section>`
    : "";
  return `${diffMarkup}${evidence}`;
}

function ruleVersionsMarkup(object) {
  const versions = Array.isArray(object.versions) ? object.versions : [];
  const effects = Array.isArray(object.legal_effects) ? object.legal_effects : [];
  if (!versions.length) {
    return `<p class="muted" data-rule-version-state="not_yet_acquired">No proposed or adopted rule documents are retained for this case file yet.</p>`;
  }
  const coverage = object.version_coverage || {};
  const coverageNote = `${coverage.proposed_documents || 0} proposed, ${coverage.adopted_documents || 0} adopted; ${coverage.paired_versions || 0} paired version${coverage.paired_versions === 1 ? "" : "s"}.`;
  return `<div class="rule-versions" data-rule-version-count="${versions.length}" data-legal-effect-count="${effects.length}">
    <p class="rule-version-coverage">${esc(coverageNote)} Exact source citations are shown only when retained in the version document.</p>
    ${ruleVersionDiffMarkup(object)}
    ${versions.map(versionMarkup).join("")}
  </div>`;
}

export function renderRulemakingDocument(object, { currentHref = "", now = null } = {}) {
  if (!object || object.schema !== "cityscroll.rulemaking.v1" || !object.rulemaking_id) return "";
  const title = clean(object.title, 500) || "Rulemaking";
  const agency = clean(object.agency, 300);
  const sourceDocs = Array.isArray(object.source_documents) ? object.source_documents : [];
  // The materialized object carries a build-time projection, but a cached page
  // must still retire a deadline when it is rendered after that date.
  const interaction = rulesCardInteractionProjection({
    request_id: object.notices?.[0]?.request_id,
    rulemaking_id: object.rulemaking_id,
    title,
    fine_stage: object.current_stage,
    rule_url: object.nyc_rules?.url,
    comment_url: object.nyc_rules?.comment_url,
    comment_by_date: object.nyc_rules?.comment_by_date,
    hearing_date: object.nyc_rules?.hearing_date,
    events: object.events,
    now: now || new Date().toISOString().slice(0, 10),
    nyc_rules: object.nyc_rules,
    source_documents: sourceDocs,
    proposed_rule_url: object.proposed_rule_url || object.nyc_rules?.proposed_rule_url,
    final_rule_url: object.final_rule_url || object.nyc_rules?.final_rule_url,
    hearing_url: object.hearing_url,
    hearing_record_url: object.hearing_record_url,
    comments_url: object.comments_url,
    comment_channel_url: object.comment_channel_url,
    testimony_url: object.testimony_url,
    petition_url: object.petition_url,
    petition_handoff: object.petition_handoff,
    follow_href: object.follow_href,
    history_url: object.history_url || object.canonical_href,
  });
  const participationItems = (interaction.kinetic_actions || [])
    .filter((action) => action?.href && action?.label)
    .map((action) => ({
      kind: /^https?:\/\//i.test(action.href) ? "source" : "link",
      href: action.href,
      label: action.label,
      primary: action.primary,
    }));
  const participation = participationItems.length
    ? renderNodeSection({
      heading: "What you can do",
      body: renderNodeActions(participationItems, { ariaLabel: "Participation actions", extraClass: "rulemaking-participation-actions" }),
      extraClass: "rulemaking-participation",
    })
    : "";
  const petition = interaction.lifecycle_state === "effective"
    ? renderPetitionHandoff(object.petition_handoff, { mode: "rule" })
    : "";
  const exceptions = renderRulesExceptionModes(object.exception_modes);
  const actionItems = [];
  const officialHref = clean(object.nyc_rules?.url || object.nyc_rules?.comment_url);
  if (officialHref) actionItems.push({ kind: "source", href: officialHref, label: "Open official rule page" });
  const actions = renderNodeActions(actionItems, { ariaLabel: "Rulemaking actions", extraClass: "civic-object-actions" });
  const lifecycleStatus = (() => {
    const state = interaction.lifecycle_state;
    const dates = interaction.lifecycle_dates || {};
    if (state === "effective") {
      return dates.effective_date ? `In effect since ${prettyDate(dates.effective_date)}` : "In effect";
    }
    if (state === "adopted") {
      return dates.effective_date
        ? `Adopted · Takes effect ${prettyDate(dates.effective_date)}`
        : "Adopted";
    }
    if (state === "comment_hearing_open") return "Comment/hearing open";
    if (state === "comment_closed_awaiting_action") return "Comment closed · Awaiting agency action";
    return "Proposed";
  })();
  const noticeItems = sourceDocs.filter((item) => item.kind === "city_record_notice").map((item) =>
    `<li><a href="${esc(item.href)}">${esc(item.role === "proposal" ? "Proposal" : item.role === "hearing" ? "Hearing" : item.role === "adoption" ? "Adoption" : "City Record notice")} · ${esc(item.request_id)}</a></li>`
  ).join("");
  const ruleItems = sourceDocs.filter((item) => item.kind === "nyc_rules").map((item) =>
    `<li><a class="ui-official-source-link" href="${esc(item.href)}" target="_blank" rel="noopener noreferrer">${esc(item.label)}<span aria-hidden="true">↗</span></a></li>`
  ).join("");
  const timeline = historyTimelineMarkup(object);
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · CityScroll</title><link rel="canonical" href="https://cityscroll.org${esc(object.canonical_href)}">
<meta property="og:title" content="${esc(title)} · CityScroll"><meta property="og:url" content="https://cityscroll.org${esc(object.canonical_href)}">
${renderCivicDocumentAssets()}</head>
<body>${renderCivicDocumentMast({ current: "browse" })}
<main id="main" class="node-document civic-object-document rulemaking-document" data-civic-object-kind="rulemaking" data-rulemaking-id="${esc(object.rulemaking_id)}" tabindex="-1">
${renderNodeBack({ href: "/browse/rules/", label: "Back to Rules", currentHref })}
<header class="node-hero civic-object-hero" data-export-class="object_identity">
<p class="node-kicker civic-object-kicker">Rulemaking case file</p>
<h1>${esc(title)}</h1>
${agency ? `<p class="node-lede">${esc(agency)}</p>` : ""}
<p class="rulemaking-lifecycle-status" data-rulemaking-lifecycle-state="${esc(interaction.lifecycle_state)}"><strong>${esc(lifecycleStatus)}</strong></p>
<p class="node-lede">One case file for the published proposal, public process, adoption, and effective date.</p>
</header>
${actions}
${renderNodeSection({ heading: "What the agency proposes", body: object.proposal_summary ? `<p>${esc(object.proposal_summary)}</p>` : "" })}
${renderNodeSection({ heading: "What this changes", body: ruleVersionsMarkup(object), extraClass: "rulemaking-versions" })}
${renderNodeSection({
  body: exceptions,
  extraClass: "rulemaking-exceptions",
})}
${participation}
${petition}
${renderNodeSection({ heading: "Process", body: timeline, extraClass: "rulemaking-process" })}
${renderNodeSection({ heading: "Source documents", body: `<ul>${noticeItems}${ruleItems}</ul>` })}
${renderNodeFooter({})}
</main></body></html>`;
  return gateNodePageRender(html);
}
