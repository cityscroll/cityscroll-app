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
  agencyMandatePredictionsPath,
} from "./mandate_prediction_alerts.mjs";
import {
  agencyMandateReportsPath,
} from "./mandate_reports_receipt.mjs";
import {
  agencyMandateRulesPath,
} from "./mandate_rules_bridge.mjs";
import {
  mandateReportsNavLabel,
  mandateRulesNavLabel,
} from "./mandate_graph_neighbors.mjs";
import { agencyMandatesConformancePath } from "./process_conformance.mjs";
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
  normalizeAsOfDay,
  projectAgencyConstellationAsOf,
} from "./civic_time_ledger.mjs";
import { constellationLink } from "./affordance_grammar.mjs";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

const DEMO_AS_OF_DAY = "2024-06-01";

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
  const payload = JSON.stringify(view).replace(/<\/script/gi, "<\\/script");
  const matched = displayView.summary.matched_categories;
  const lead = effectiveAsOf
    ? (matched
      ? `Records dated on or before ${effectiveAsOf} · ${matched} of ${displayView.summary.category_count} categories.`
      : `No linked records dated on or before ${effectiveAsOf}.`)
    : (matched
      ? `Public records connected with this agency across ${matched} of ${view.summary.category_count} categories.`
      : "Public records for this agency appear here when contracts, meetings, rules, mandates, or staffing exams join to its published identity.");
  const kicker = effectiveAsOf
    ? `Agency constellation · as of ${effectiveAsOf}`
    : "Agency constellation";

  const bridgeSource = displayView.mandates_rules || view.mandates_rules || null;
  const reportsSource = displayView.mandates_reports || view.mandates_reports || null;
  const predictionsSource = displayView.mandates_predictions || view.mandates_predictions || null;
  const obligationsFollow = view.categories.find((category) => category.id === "obligations" && (category.items?.length || category.conformance))?.follow_href || "";
  const mandatesHref = view.mandates_href || agencyMandatesConformancePath(view.canonical_id);
  const mandatesRulesHref = view.mandates_rules_href || agencyMandateRulesPath(view.canonical_id);
  const mandatesReportsHref = view.mandates_reports_href || agencyMandateReportsPath(view.canonical_id);
  const mandatesPredictionsHref = view.mandates_predictions_href
    || agencyMandatePredictionsPath(view.canonical_id);
  const showMandatesRulesNav = bridgeSource?.status === "matched";
  const showMandatesReportsNav = reportsSource?.status === "matched";
  const showMandatesPredictionsNav = predictionsSource?.status === "matched";
  // Honest nav: do not claim filing receipts / Rules activity edges when none.
  const reportsNavLabel = mandateReportsNavLabel(reportsSource?.counts || {});
  const rulesNavLabel = mandateRulesNavLabel(bridgeSource?.counts || {});
  const actions = renderNodeActions([
    { kind: "link", label: "Get updates about this agency's public records", href: view.follow_href, primary: true, className: "civic-object-action" },
    mandatesHref
      ? { kind: "link", label: "Mandates expected vs observed", href: mandatesHref, className: "civic-object-action" }
      : null,
    showMandatesPredictionsNav
      ? { kind: "link", label: "Expected mandate events", href: mandatesPredictionsHref, className: "civic-object-action" }
      : null,
    showMandatesReportsNav
      ? { kind: "link", label: reportsNavLabel, href: mandatesReportsHref, className: "civic-object-action" }
      : null,
    showMandatesRulesNav
      ? { kind: "link", label: rulesNavLabel, href: mandatesRulesHref, className: "civic-object-action" }
      : null,
    obligationsFollow
      ? { kind: "link", label: "Watch mandates and deadlines", href: obligationsFollow, className: "civic-object-action" }
      : null,
    { kind: "button", label: "Copy link", attrs: { "data-object-copy": true }, className: "civic-object-action" },
    { kind: "button", label: "Print / save PDF", attrs: { "data-object-print": true }, className: "civic-object-action" },
    { kind: "button", label: "Download JSON", attrs: { "data-object-export": "json" }, className: "civic-object-action" },
  ].filter(Boolean), {
    ariaLabel: "Document actions",
    exportClass: "object_actions",
    extraClass: "civic-object-actions",
  });
  const sectionView = Object.freeze({
    view,
    displayView,
    activeClaimId,
    effectiveAsOf,
    showAsOf,
  });
  const sections = renderAgencyConstellationSections(sectionView);
  const assetPrefix = options.assetPrefix || "/";
  const runtimeSrc = `${assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`}civic_time_ledger_runtime.mjs`;
  const demoAsOfLink = showAsOf
    ? ` · ${constellationLink({ href: asOfHref(view.path, DEMO_AS_OF_DAY), label: `As of ${DEMO_AS_OF_DAY}`, className: "agency-pivot-link", attributes: { "data-ctl-demo-as-of": "" }, escape: esc })}`
    : "";
  return gateNodePageRender(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}${effectiveAsOf ? ` · as of ${esc(effectiveAsOf)}` : ""} · Agency constellation · CityScroll</title>
  <meta name="description" content="${esc(`Cross-category public records for ${title}: contracts, meetings, rules, mandates, and staffing exams.`)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta property="og:url" content="${esc(canonical)}">
  ${renderCivicDocumentAssets(assetPrefix)}
  <style>${agencyConstellationSectionStyles()}</style>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  ${renderCivicDocumentMast({ current: "browse", surfaceClass: "civic-object-mast" })}
  <main id="main" class="node-document civic-object-document" data-civic-object-kind="agency-constellation" data-subject-ref="${esc(view.subject_ref)}" data-er-match-basis="${esc(view.summary.er_match_basis)}" data-edge-provenance="1" data-node-document="1" data-as-of="${esc(effectiveAsOf || "")}" data-ctl-useful="${showAsOf ? "1" : "0"}">
    ${renderNodeBack({ href: "/agencies/", label: "Back to agencies", extraClass: "civic-object-back" })}
    <header class="node-hero civic-object-hero" data-export-class="object_identity">
      <p class="node-kicker civic-object-kicker">${esc(kicker)}</p>
      <h1>${esc(title)}</h1>
      <p class="node-lede">${esc(lead)}</p>
      <p class="node-pivot civic-object-pivot">
        ${constellationLink({ href: view.scope_href, label: "Open this agency in Contracts", className: "agency-pivot-link", attributes: { "data-subject-ref": view.subject_ref }, escape: esc })}
        · ${constellationLink({ href: mandatesHref, label: "Mandates expected vs observed", className: "agency-pivot-link", escape: esc })}
        ${showMandatesPredictionsNav ? `· ${constellationLink({ href: mandatesPredictionsHref, label: "Expected mandate events", className: "agency-pivot-link", escape: esc })}` : ""}
        ${showMandatesReportsNav ? `· ${constellationLink({ href: mandatesReportsHref, label: reportsNavLabel, className: "agency-pivot-link", escape: esc })}` : ""}
        ${showMandatesRulesNav ? `· ${constellationLink({ href: mandatesRulesHref, label: rulesNavLabel, className: "agency-pivot-link", escape: esc })}` : ""}
        · ${constellationLink({ href: view.interactive_profile_href, label: "Interactive profile", className: "agency-pivot-link", escape: esc })}
        · ${constellationLink({ href: "#edge-provenance", label: "Connection evidence", className: "agency-pivot-link", escape: esc })}${demoAsOfLink}
      </p>
    </header>
    ${actions}
    ${sections}
  </main>
  ${renderNodeFooter({ extraClass: "civic-object-footer" })}
  <script id="civic-object-payload" type="application/json">${payload}</script>
  <script defer src="${esc((assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`) + "export_workflows.js")}"></script>
  <script type="module" src="${esc(runtimeSrc)}"></script>
  <script>${agencyConstellationSectionScripts(sectionView)}</script>
</body>
</html>`);
}
