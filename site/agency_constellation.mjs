/**
 * Thin document composer for agency constellations.
 *
 * Capability HTML is owned by the ordered section registry. The view model and
 * its stable public helpers remain available through this facade.
 */

export * from "./agency_constellation_model.mjs";

import {
  agencyConstellationSectionScripts,
  agencyConstellationSectionStyles,
  renderAgencyConstellationSections,
} from "./agency_constellation_section_registry.mjs";
import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeActions,
  renderNodeBack,
  renderNodeFooter,
} from "./civic_document_chrome.mjs";
import {
  asOfFilterCanNarrow,
  asOfHref,
  buildLedgerSummary,
  normalizeAsOfDay,
  projectAgencyConstellationAsOf,
  renderCivicTimeLedgerPanel,
} from "./civic_time_ledger.mjs";
import { buildAgencyEdgeSummary } from "./agency_constellation_model.mjs";
import {
  buildAgencyConstellationClaimReportTarget,
  buildEntityProfileReportTarget,
  renderReportIssueAffordance,
} from "./report_issue.mjs";
import { serializeReportTarget } from "./report_target.mjs";
import { renderPetitionHandoff } from "./rules_petition.mjs";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

const DEMO_AS_OF_DAY = "2024-06-01";

const CONNECTION_PRESENTATION = Object.freeze({
  published_by_agency: Object.freeze({ title: "Contracts", noun: "record", action: "View contracts", relation: "published by this agency" }),
  top_vendor_by_award_12mo: Object.freeze({ title: "Top vendors", noun: "vendor", action: "View vendors", relation: "received awards from this agency" }),
  hosts_meeting: Object.freeze({ title: "Meetings & hearings", noun: "meeting", action: "View meetings", relation: "involving this agency" }),
  issued_rule: Object.freeze({ title: "Rules", noun: "rule", action: "View rules", relation: "issued by this agency" }),
  statute_duty: Object.freeze({ title: "Statutory mandates", noun: "mandate", action: "View mandates", relation: "requirements assigned to this agency" }),
  certified_to_agency: Object.freeze({ title: "Staffing exams", noun: "exam", action: "View staffing exams", relation: "certified to this agency" }),
});

const PRIMARY_RECORD_PRIORITY = Object.freeze([
  "published_by_agency",
  "hosts_meeting",
  "issued_rule",
  "certified_to_agency",
  "top_vendor_by_award_12mo",
  "statute_duty",
]);

function connectionPresentation(record) {
  const configured = CONNECTION_PRESENTATION[record.edge_type] || {};
  const title = configured.title || clean(record.target_name || record.label || "Connected records", 120);
  const noun = configured.noun || "record";
  return {
    title,
    noun,
    action: configured.action || `View ${title.toLowerCase()}`,
    relation: configured.relation || clean(record.relation_label || "connected with this agency", 180),
  };
}

function recordCountLabel(record, noun) {
  if (!Number.isInteger(record.count) || record.count < 0) return "";
  return `${record.count.toLocaleString("en-US")} ${record.count === 1 ? noun : `${noun}s`}`;
}

function recordHref(record) {
  return clean(record.canonical_href || record.href, 1200);
}

export function renderAgencyConnectionCards(records = []) {
  const connected = records.filter((record) => record?.state === "matched" && recordHref(record));
  if (!connected.length) return "";
  const cards = connected.map((record) => {
    const presentation = connectionPresentation(record);
    const count = recordCountLabel(record, presentation.noun);
    const href = recordHref(record);
    return `<article class="agency-connection-card" data-edge-type="${esc(record.edge_type)}" data-edge-state="matched"${record.count == null ? "" : ` data-edge-count="${esc(record.count)}"`}>
      <a class="agency-connection-link" href="${esc(href)}" aria-label="${esc(`${presentation.action}; ${count ? `${count}; ` : ""}${presentation.relation}`)}">
        <span class="agency-connection-heading"><h3 class="agency-connection-title">${esc(presentation.title)}</h3>${count ? `<span class="agency-connection-count">${esc(count)}</span>` : ""}</span>
        <p class="agency-connection-relation">${esc(presentation.relation)}</p>
        <span class="agency-connection-action">${esc(presentation.action)} <span aria-hidden="true">→</span></span>
      </a>
    </article>`;
  }).join("");
  const count = connected.length;
  return `<section class="agency-connections" aria-labelledby="agency-connections-heading">
    <div class="agency-connections-heading">
      <div><p class="agency-connections-kicker">Public relationships</p><h2 id="agency-connections-heading">Connected records</h2></div>
      <p class="agency-connections-summary">${count} ${count === 1 ? "kind of connected record" : "kinds of connected records"}</p>
    </div>
    <div class="agency-connection-grid">${cards}</div>
  </section>`;
}

function primaryRecordAction(records) {
  const connected = records.filter((record) => record?.state === "matched" && recordHref(record));
  const selected = PRIMARY_RECORD_PRIORITY
    .map((edgeType) => connected.find((record) => record.edge_type === edgeType))
    .find(Boolean) || connected[0];
  if (!selected) return null;
  return {
    kind: "link",
    label: connectionPresentation(selected).action,
    href: recordHref(selected),
    className: "civic-object-action",
  };
}

function readerDay(value) {
  return String(value || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
}

function agencyDeferredSectionView(view, displayView, activeClaimId, effectiveAsOf, showAsOf) {
  const sections = renderAgencyConstellationSections({
    view,
    displayView,
    activeClaimId,
    effectiveAsOf,
    showAsOf,
  }, { exclude: ["as-of"] });
  const edgeSummary = buildAgencyEdgeSummary(displayView);
  const surfaceEdgeSummary = sections.includes('id="mandates-conformance"')
    ? edgeSummary
    : edgeSummary.map((record) => record.edge_type === "statute_duty"
      ? { ...record, href: "#agency-statutory-mandates", canonical_href: "#agency-statutory-mandates" }
      : record);
  return { sections, surfaceEdgeSummary };
}

/** Render the relationship/list region for the deferred agency artifact. */
export function renderAgencyConstellationDeferredFragment(view, options = {}) {
  if (!view || view.kind !== "agency-constellation") {
    throw new Error("Unknown agency constellation view");
  }
  const asOf = normalizeAsOfDay(options.asOf);
  const showAsOf = asOfFilterCanNarrow(view);
  const displayView = asOf && showAsOf
    ? projectAgencyConstellationAsOf(view, asOf, { axis: "valid" })
    : view;
  const activeClaimId = clean(options.activeClaimId || options.claim, 200) || null;
  const effectiveAsOf = showAsOf ? asOf : null;
  const { sections, surfaceEdgeSummary } = agencyDeferredSectionView(
    view,
    displayView,
    activeClaimId,
    effectiveAsOf,
    showAsOf,
  );
  const ledgerSlot = showAsOf ? '<div data-civic-time-ledger-slot></div>' : '';
  return `${renderAgencyConnectionCards(surfaceEdgeSummary)}${ledgerSlot}${sections}`;
}

export function agencyConstellationSharePath(viewPath, { claim = null, asOf = null } = {}) {
  const base = String(viewPath || "/");
  const params = new URLSearchParams();
  const day = normalizeAsOfDay(asOf);
  const claimId = clean(claim, 200);
  if (day) params.set("as_of", day);
  if (claimId) params.set("claim", claimId);
  const query = params.toString();
  if (!query) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${query}`;
}

export function renderAgencyConstellationDocument(view, options = {}) {
  if (!view || view.kind !== "agency-constellation") {
    throw new Error("Unknown agency constellation view");
  }
  const asOf = normalizeAsOfDay(options.asOf);
  const showAsOf = asOfFilterCanNarrow(view);
  const displayView = asOf && showAsOf
    ? projectAgencyConstellationAsOf(view, asOf, { axis: "valid" })
    : view;
  const title = view.display_name;
  const activeClaimId = clean(options.activeClaimId || options.claim, 200) || null;
  const effectiveAsOf = showAsOf ? asOf : null;
  const sharePath = agencyConstellationSharePath(view.path, { claim: activeClaimId, asOf: effectiveAsOf });
  const canonical = `https://cityscroll.org${sharePath}`;
  const matched = displayView.summary.matched_categories;
  const lead = effectiveAsOf
    ? (matched
      ? `${matched} ${matched === 1 ? "kind" : "kinds"} of connected public record dated on or before ${effectiveAsOf}.`
      : `No linked records dated on or before ${effectiveAsOf}.`)
    : (matched
      ? `Explore ${matched} ${matched === 1 ? "kind" : "kinds"} of public record connected with this agency.`
      : "Public records for this agency appear here when contracts, vendors, meetings, rules, mandates, or staffing exams join to its published identity.");
  const secondaryActions = renderNodeActions([
    { kind: "link", label: "Interactive profile", href: view.interactive_profile_href, className: "civic-object-action" },
    { kind: "button", label: "Copy link", attrs: { "data-object-copy": true }, className: "civic-object-action" },
    { kind: "button", label: "Print / save PDF", attrs: { "data-object-print": true }, className: "civic-object-action" },
    { kind: "button", label: "Download JSON", attrs: { "data-object-export": "json" }, className: "civic-object-action" },
  ], {
    ariaLabel: "More agency options",
    exportClass: "object_utilities",
    extraClass: "civic-object-actions agency-secondary-actions",
  });
  const { sections, surfaceEdgeSummary } = agencyDeferredSectionView(
    view,
    displayView,
    activeClaimId,
    effectiveAsOf,
    showAsOf,
  );
  const initialLedger = showAsOf
    ? renderCivicTimeLedgerPanel({
      path: view.path,
      asOfDay: effectiveAsOf,
      summary: effectiveAsOf ? buildLedgerSummary(view, displayView) : null,
    })
    : "";
  const sectionView = Object.freeze({
    view,
    displayView,
    activeClaimId,
    effectiveAsOf,
    showAsOf,
  });
  const petitionAction = view.petition_handoff?.state === "ready"
    && view.petition_handoff?.official?.form_url
    ? { kind: "link", label: "Petition this agency", href: view.petition_handoff.official.form_url, primary: false, className: "civic-object-action" }
    : null;
  const primaryActions = renderNodeActions([
    { kind: "link", label: "Follow this agency", href: view.follow_href, primary: true, className: "civic-object-action" },
    petitionAction,
    primaryRecordAction(surfaceEdgeSummary),
    { kind: "link", label: "Connection evidence", href: "#edge-provenance", className: "civic-object-action agency-evidence-action" },
  ].filter(Boolean), {
    ariaLabel: "Primary agency actions",
    exportClass: "object_actions",
    extraClass: "civic-object-actions agency-primary-actions",
  });
  const assetPrefix = options.assetPrefix || "/";
  const identityLookupHref = `${assetPrefix || "/"}data/people_organizations_read_model.json`;
  const profileReportTarget = buildEntityProfileReportTarget({
    entity_ref: view.subject_ref,
    canonical_url: view.path,
    object_label: title,
    identity_lookup_href: identityLookupHref,
  });
  const activeClaim = activeClaimId
    ? (Array.isArray(view.claims) ? view.claims.find((entry) => entry?.claim_id === activeClaimId) : null) || null
    : null;
  const reportTarget = activeClaimId
    ? buildAgencyConstellationClaimReportTarget({
      entity_ref: view.subject_ref,
      canonical_url: view.path,
      object_label: title,
      claim: activeClaim,
      activeClaimId,
    })
    : profileReportTarget;
  const identityReport = renderReportIssueAffordance(reportTarget, { label: "Report an issue" });
  const profileTargetAttr = profileReportTarget ? esc(serializeReportTarget(profileReportTarget)) : "";
  const runtimeSrc = `${assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`}civic_time_ledger_runtime.mjs`;
  const traversalSrc = `${assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`}app/traversal.mjs`;
  const updatedDay = readerDay(displayView.summary.generated_at || view.summary.generated_at);
  const metadata = [
    effectiveAsOf ? `Showing records as of ${effectiveAsOf}` : (updatedDay ? `Records updated ${updatedDay}` : ""),
    showAsOf ? `<a href="${esc(asOfHref(view.path, DEMO_AS_OF_DAY))}" data-ctl-demo-as-of>As of ${DEMO_AS_OF_DAY}</a>` : "",
  ].filter(Boolean).join(" <span aria-hidden=\"true\">·</span> ");
  const petition = renderPetitionHandoff(view.petition_handoff, { mode: "agency" });
  return gateNodePageRender(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}${effectiveAsOf ? ` · as of ${esc(effectiveAsOf)}` : ""} · Agency constellation · CityScroll</title>
  <meta name="description" content="${esc(`Cross-category public records for ${title}: contracts, vendors, meetings, rules, mandates, and staffing exams.`)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta property="og:url" content="${esc(canonical)}">
  ${renderCivicDocumentAssets(assetPrefix)}
  <style>${agencyConstellationSectionStyles()}</style>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  ${renderCivicDocumentMast({ current: "browse", surfaceClass: "civic-object-mast" })}
  <main id="main" class="node-document civic-object-document" data-civic-object-kind="agency-constellation" data-subject-ref="${esc(view.subject_ref)}" data-er-match-basis="${esc(view.summary.er_match_basis)}" data-edge-provenance="1" data-node-document="1" data-as-of="${esc(effectiveAsOf || "")}" data-ctl-useful="${showAsOf ? "1" : "0"}" data-civic-object-deferred-href="${esc(options.deferredDataHref || `${view.path}relationships.json`)}" data-civic-object-view-href="${esc(options.deferredViewHref || `${view.path}relationships-data.json`)}" data-civic-object-settled="false">
    ${renderNodeBack({ href: "/agencies/", label: "Back to agencies", extraClass: "civic-object-back" })}
    <header class="node-hero civic-object-hero agency-constellation-hero" data-export-class="object_identity">
      <p class="node-kicker civic-object-kicker">Agency constellation</p>
      <h1>${esc(title)}</h1>
      <p class="node-lede">${esc(lead)}</p>
      ${metadata ? `<p class="agency-hero-meta">${metadata}</p>` : ""}
    </header>
    ${primaryActions}
    ${petition}
    <div class="agency-identity-report civic-object-actions" data-agency-report="1" data-report-entity-ref="${esc(view.subject_ref || "")}" data-report-canonical-url="${esc(view.path || "")}" data-report-object-label="${esc(title || "")}"${profileTargetAttr ? ` data-report-profile-target="${profileTargetAttr}"` : ""}${activeClaimId && reportTarget ? ` data-report-claim-id="${esc(activeClaimId)}"` : ""}>${identityReport}</div>
    <script>
(() => {
  const params = new URLSearchParams(location.search);
  const claim = (params.get("claim") || "").trim();
  const host = document.querySelector("[data-agency-report]");
  if (!claim || !host) return;
  if (host.getAttribute("data-report-claim-id") === claim) return;
  host.hidden = true;
  host.setAttribute("data-report-awaiting-claim", "1");
})();
    </script>
    ${initialLedger}
    <div data-civic-object-deferred data-civic-object-deferred-state="loading" role="status">Loading public relationships…</div>
    ${secondaryActions}
  </main>
  ${renderNodeFooter({ extraClass: "civic-object-footer" })}
  <script defer src="${esc((assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`) + "export_workflows.js")}"></script>
  <script type="module" src="${esc(traversalSrc)}"></script>
  <script type="module" src="${esc(runtimeSrc)}"></script>
  <script type="module" src="${esc(`${assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`}report_issue.mjs`)}"></script>
  <script>${agencyConstellationSectionScripts(sectionView)}</script>
</body>
</html>`);
}
