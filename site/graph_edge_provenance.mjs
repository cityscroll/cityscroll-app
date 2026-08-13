import {
  CROSS_SPINE_CONFIDENCE,
  normalizeCrossSpineConfidence,
} from "./cross_spine_confidence.mjs";

/**
 * Evidence-bearing civic graph — edge / claim provenance inspection (first iteration).
 *
 * Surfaces where a connection came from and how it was joined (warrant class).
 * Public pages only list standable connections; tentative or unclassifiable
 * edges stay off the reader surface rather than shipping wrapped in hedges.
 * Missing enrichment fields stay omitted. Hosted first on the agency
 * cross-category graph; other hosts may reuse the claim model and deep-link grammar.
 */

export const GRAPH_EDGE_PROVENANCE_SCHEMA = "cityscroll.graph_edge_provenance.v1";
export const GRAPH_EDGE_PROVENANCE_METHOD = "graph_edge_provenance_v1";
export { CROSS_SPINE_CONFIDENCE };

/** Exact publisher key / registry match vs score-based linkage vs person-accepted review. */
export const WARRANT_CLASSES = Object.freeze({
  exact: Object.freeze({
    id: "exact",
    label: "Exact match",
    short: "Exact",
    token: "exact",
  }),
  probabilistic: Object.freeze({
    id: "probabilistic",
    label: "Record-linkage match",
    short: "Linked",
    token: "probable",
  }),
  reviewed: Object.freeze({
    id: "reviewed",
    label: "Person-accepted",
    short: "Reviewed",
    token: "reviewed",
  }),
  not_yet_classified: Object.freeze({
    id: "not_yet_classified",
    label: "Not yet classified",
    short: "Unclassified",
    token: "unclassified",
  }),
});

export const WARRANT_CLASS_ORDER = Object.freeze([
  "exact",
  "probabilistic",
  "reviewed",
  "not_yet_classified",
]);

/** Reader-facing connection stance (positive labels for standable edges). */
export const IDENTITY_STANCES = Object.freeze({
  publisher_key: Object.freeze({
    id: "publisher_key",
    label: "Publisher key match",
  }),
  strong_link: Object.freeze({
    id: "strong_link",
    label: "Strong connection",
  }),
  possible_link: Object.freeze({
    id: "possible_link",
    label: "Record-linkage connection",
  }),
  not_scored: Object.freeze({
    id: "not_scored",
    label: "Link not scored",
  }),
});

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const SOURCE_SYSTEM_READER_LABELS = Object.freeze({
  city_record: "City Record",
  warehouse: "Warehouse materialization",
  socrata: "NYC Open Data",
  legistar: "NYC Council Legistar",
  passport: "PASSPort Public",
  checkbook: "Checkbook NYC",
  enacted_local_law: "Enacted local law",
});

export function sourceSystemReaderLabel(value) {
  const key = clean(value, 120);
  if (!key) return null;
  if (SOURCE_SYSTEM_READER_LABELS[key]) return SOURCE_SYSTEM_READER_LABELS[key];
  const lower = key.toLowerCase();
  if (SOURCE_SYSTEM_READER_LABELS[lower]) return SOURCE_SYSTEM_READER_LABELS[lower];
  if (key.includes(" ") || /[A-Z]/.test(key)) return key; // already human
  return key.replace(/_/g, " ");
}

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

const MISSING = Object.freeze({
  available: false,
});

/**
 * Normalize public confidence bands carried on graph edges.
 * `publisher_record` is a strong publisher stamp, not a numeric score.
 */
export function normalizePublicConfidence(value) {
  const raw = typeof value === "object" && value !== null
    ? value.status || value.band || value.confidence
    : value;
  const confidence = clean(raw, 40).toLowerCase();
  if (confidence === "strong" || confidence === "publisher_record") return "strong";
  if (confidence === "tentative" || confidence === "possible") return "tentative";
  if (confidence === "not_scored" || confidence === "unknown") return "not_scored";
  return null;
}

/**
 * Map existing method + confidence (+ optional ER decision) to a warrant class.
 * Does not invent methods — unknown combinations stay not_yet_classified.
 */
export function warrantClassForEdge(input = {}) {
  const method = clean(input.method || input.basis || "", 120).toLowerCase();
  const decision = clean(input.decision || input.review_status || "", 80).toLowerCase();
  const confidence = normalizePublicConfidence(input.confidence);

  if (
    decision === "reviewed"
    || decision === "review_accepted"
    || decision === "manual_review"
    || method.includes("manual_review")
    || method.includes("human_review")
    || method.includes("reviewed")
  ) {
    return WARRANT_CLASSES.reviewed;
  }

  if (confidence === "tentative") {
    return WARRANT_CLASSES.probabilistic;
  }

  // Exact publisher / registry methods already stamped on public edges.
  if (
    method.includes("publisher_certification")
    || method.includes("agency_canonical")
    || method.includes("agency_browse_snapshot")
    || method.includes("pin_exact")
    || method.includes("exact_")
    || method.endsWith("_exact")
    || method.includes("vendor_stem_v1") // exact-stem auto path (stem equality, not fuzzy)
    || method.includes("enacted_law_mandate")
    || method.includes("auto_certified_quote")
    || method.includes("statute_actor_alias")
  ) {
    // Exact-stem auto-link is exact key equality on the stem, not probabilistic
    // token scoring. Fuzzy / proximity methods fall through below.
    if (method.includes("fuzzy") || method.includes("probabilistic") || method.includes("proximity")) {
      return WARRANT_CLASSES.probabilistic;
    }
    return WARRANT_CLASSES.exact;
  }

  if (
    method.includes("fuzzy")
    || method.includes("probabilistic")
    || method.includes("similarity")
    || method.includes("token")
    || method.includes("conventional_v2")
  ) {
    return WARRANT_CLASSES.probabilistic;
  }

  if (!method && confidence === "strong") {
    return WARRANT_CLASSES.not_yet_classified;
  }
  if (!method && confidence === "tentative") {
    return WARRANT_CLASSES.probabilistic;
  }
  return WARRANT_CLASSES.not_yet_classified;
}

/**
 * Connection stance for a standable public edge.
 * Tentative / unclassified edges are filtered before render rather than hedged.
 */
export function identityStanceForEdge(input = {}) {
  const warrant = warrantClassForEdge(input);
  const confidence = normalizePublicConfidence(input.confidence);
  const method = clean(input.method || "", 120).toLowerCase();

  if (warrant.id === "probabilistic" || confidence === "tentative") {
    return IDENTITY_STANCES.possible_link;
  }
  if (
    warrant.id === "exact"
    && (
      method.includes("publisher_certification")
      || method.includes("agency_canonical")
      || method.includes("agency_browse_snapshot")
      || method.includes("pin_exact")
      || method.includes("enacted_law_mandate")
      || method.includes("auto_certified_quote")
    )
  ) {
    return IDENTITY_STANCES.publisher_key;
  }
  if (confidence === "strong" || warrant.id === "exact" || warrant.id === "reviewed") {
    return IDENTITY_STANCES.strong_link;
  }
  return IDENTITY_STANCES.not_scored;
}

/** Whether a claim is strong enough to list on a public graph surface. */
export function isStandablePublicClaim(claim) {
  if (!claim) return false;
  if (claim.cross_spine?.explicit && claim.cross_spine.confidence !== "confirmed") return false;
  const warrant = claim.how?.warrant_class;
  const band = claim.confidence?.band;
  if (warrant === "not_yet_classified") return false;
  if (band === "tentative" || warrant === "probabilistic") return false;
  if (band === "not_scored" && warrant !== "reviewed" && warrant !== "exact") return false;
  return true;
}

/** Stable claim id for deep links (category + subject). */
export function edgeClaimId({ category_id, subject_ref, id } = {}) {
  const category = clean(category_id, 40) || "edge";
  const subject = clean(subject_ref || id, 120);
  if (!subject) return null;
  return `${category}:${subject}`;
}

/**
 * Shareable path on a host document: `/agencies/<id>/?claim=<claim_id>`
 * Keeps query form so static documents and edge hosts share one grammar.
 */
export function claimInspectHref(documentPath, claimId) {
  const path = clean(documentPath, 200) || "/";
  const claim = clean(claimId, 200);
  if (!claim) return path;
  const base = path.endsWith("/") ? path : `${path}/`;
  return `${base}?claim=${encodeURIComponent(claim)}`;
}

export function parseClaimParam(search) {
  const raw = String(search || "");
  const query = raw.startsWith("?") ? raw.slice(1) : raw;
  if (!query) return null;
  try {
    const params = new URLSearchParams(query);
    const claim = clean(params.get("claim"), 200);
    return claim || null;
  } catch {
    return null;
  }
}

function fieldOrMissing(value, max = 240) {
  const text = clean(value, max);
  if (!text) return { ...MISSING };
  return { available: true, value: text };
}

function firstPresent(records, key) {
  for (const record of records) {
    if (record && Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function firstValue(records, key, fallback = undefined) {
  const value = firstPresent(records, key);
  return value === undefined ? fallback : value;
}

function crossSpineConfidenceForItem(item, provenance, evidence) {
  const nested = item.cross_spine && typeof item.cross_spine === "object"
    ? item.cross_spine
    : {};
  const provenanceCrossSpine = provenance.cross_spine && typeof provenance.cross_spine === "object"
    ? provenance.cross_spine
    : {};
  const confidence = firstPresent([nested, provenanceCrossSpine], "confidence");
  const joinConfidence = firstPresent([nested, item, provenance, evidence], "join_confidence");
  const crossSpineConfidence = firstPresent([nested, item, provenance, evidence], "cross_spine_confidence");
  const raw = confidence !== undefined
    ? confidence
    : (joinConfidence !== undefined ? joinConfidence : crossSpineConfidence);
  return {
    confidence: normalizeCrossSpineConfidence(raw) || "unmatched",
    explicit: raw != null,
  };
}

/**
 * Build a portable provenance claim from a constellation (or other graph) edge item.
 * Only carries fields present on the edge; missing slots use the missing marker.
 */
export function buildEdgeProvenanceClaim(item = {}, context = {}) {
  const categoryId = clean(context.category_id || item.category_id, 40);
  const subjectRef = clean(item.subject_ref || item.id, 120);
  const claimId = edgeClaimId({
    category_id: categoryId,
    subject_ref: subjectRef,
    id: item.id,
  });
  if (!claimId) return null;

  const method = clean(
    item.method
      || item.provenance?.basis
      || item.provenance?.join_method
      || item.confidence?.basis,
    120,
  ) || null;
  const confidence = normalizePublicConfidence(item.confidence) || "not_scored";
  const warrant = warrantClassForEdge({
    method,
    confidence: item.confidence,
    decision: item.decision || item.review_status,
    basis: item.provenance?.basis || item.basis,
  });
  const stance = identityStanceForEdge({
    method,
    confidence: item.confidence,
    decision: item.decision || item.review_status,
    basis: item.provenance?.basis || item.basis,
  });

  const provenance = item.provenance && typeof item.provenance === "object"
    ? item.provenance
    : {};
  const evidence = item.evidence && typeof item.evidence === "object"
    ? item.evidence
    : {};

  const provenanceSource = provenance.source && typeof provenance.source === "object"
    ? provenance.source
    : {};
  const sourceSystem = clean(
    firstValue(
      [provenance, evidence],
      "source_system",
      firstValue([provenanceSource], "system", item.source),
    ),
    120,
  ) || null;
  const sourceRecordId = clean(
    firstValue(
      [provenance, evidence],
      "source_record_id",
      firstValue([provenanceSource], "id", item.source_record_id),
    ),
    200,
  ) || null;
  const rawSourceFields = firstPresent([provenance, evidence], "source_fields");
  const sourceFields = Array.isArray(rawSourceFields)
    ? rawSourceFields.map((field) => clean(field, 80)).filter(Boolean)
    : null;
  const inputValue = clean(
    firstValue([provenance, evidence], "input_value", item.input_value),
    240,
  ) || null;
  const basis = clean(
    firstValue(
      [provenance, evidence],
      "basis",
      firstValue([provenance, evidence], "join_method", item.basis),
    ),
    120,
  ) || null;
  const observedAt = clean(
    firstValue(
      [provenance, evidence],
      "observed_at",
      item.observed_at
        ?? item.as_of
        ?? item.retrieved_at
        ?? item.retrieved_on
        ?? item.date,
    ),
    40,
  ) || null;
  const sourceExcerpt = clean(
    firstValue([provenance, evidence], "source_excerpt", item.source_excerpt),
    500,
  ) || null;
  const crossSpine = crossSpineConfidenceForItem(item, provenance, evidence);
  const crossSpineStandable = !crossSpine.explicit || crossSpine.confidence === "confirmed";

  // Shadow ER tables (entity_link / resolution_run) are not public consumers yet.
  const entityLinkId = clean(item.entity_link_id || item.link_id, 120) || null;
  const resolutionRunId = clean(item.resolution_run_id, 120) || null;

  const documentPath = clean(context.document_path, 200) || null;
  const href = documentPath ? claimInspectHref(documentPath, claimId) : null;

  const missing = [];
  if (!sourceRecordId) missing.push("source_record_id");
  if (!sourceFields?.length) missing.push("source_fields");
  if (!inputValue) missing.push("input_value");
  if (!sourceExcerpt) missing.push("source_excerpt");
  if (!entityLinkId) missing.push("entity_link_id");
  if (!resolutionRunId) missing.push("resolution_run_id");

  return {
    schema: GRAPH_EDGE_PROVENANCE_SCHEMA,
    method: GRAPH_EDGE_PROVENANCE_METHOD,
    claim_id: claimId,
    kind: "graph_edge_claim",
    subject_ref: subjectRef,
    root_ref: clean(context.root_ref || item.root_ref, 120) || null,
    category_id: categoryId || null,
    relation: clean(item.relation ?? item.type ?? context.relation, 80) || null,
    label: clean(item.label || subjectRef, 240),
    object_href: clean(item.href, 200) || null,
    where: {
      source_system: sourceSystem ? fieldOrMissing(sourceSystem) : { ...MISSING },
      source_record_id: sourceRecordId ? fieldOrMissing(sourceRecordId) : { ...MISSING },
      source_fields: sourceFields?.length
        ? { available: true, value: sourceFields }
        : { ...MISSING, value: null },
      input_value: inputValue ? fieldOrMissing(inputValue) : { ...MISSING },
      observed_at: observedAt ? fieldOrMissing(observedAt) : { ...MISSING },
      basis: basis ? fieldOrMissing(basis) : { ...MISSING },
      source_excerpt: sourceExcerpt ? fieldOrMissing(sourceExcerpt, 500) : { ...MISSING },
    },
    how: {
      method: method ? fieldOrMissing(method) : { ...MISSING },
      warrant_class: warrant.id,
      warrant_label: warrant.label,
      decision: clean(item.decision || item.review_status, 80) || null,
    },
    cross_spine: {
      confidence: crossSpine.confidence,
      explicit: crossSpine.explicit,
    },
    confidence: {
      band: confidence,
      identity_stance: stance.id,
      identity_label: stance.label,
      standable: crossSpineStandable && (warrant.id === "exact" || warrant.id === "reviewed"
        || (warrant.id === "probabilistic" && confidence === "strong")),
      counts_as_verified_total: (warrant.id === "exact" || warrant.id === "reviewed")
        && confidence === "strong"
        && crossSpineStandable,
    },
    enrichment: {
      entity_link_id: entityLinkId ? fieldOrMissing(entityLinkId) : { ...MISSING },
      resolution_run_id: resolutionRunId ? fieldOrMissing(resolutionRunId) : { ...MISSING },
      next: null,
      missing_fields: missing,
    },
    inspect_href: href,
    share_href: href,
  };
}

/**
 * Summarize category membership for standable public edges.
 * Tentative / probabilistic edges are counted separately so hosts can drop them.
 */
export function summarizeCategoryWarrants(items = []) {
  const summary = {
    exact: 0,
    probabilistic: 0,
    reviewed: 0,
    not_yet_classified: 0,
    verified_total: 0,
    possible_total: 0,
    listed_total: 0,
    standable_total: 0,
  };
  for (const item of Array.isArray(items) ? items : []) {
    const claim = item?.claim || buildEdgeProvenanceClaim(item);
    if (!claim) continue;
    summary.listed_total += 1;
    const warrant = claim.how?.warrant_class || "not_yet_classified";
    if (summary[warrant] != null) summary[warrant] += 1;
    else summary.not_yet_classified += 1;
    if (isStandablePublicClaim(claim)) {
      summary.standable_total += 1;
      summary.verified_total += 1;
    } else {
      summary.possible_total += 1;
    }
  }
  return summary;
}

function renderFieldRow(label, field, { showMissing = false } = {}) {
  if (!field || field.available === false || field.value == null || field.value === "") return "";
  const display = field.value;
  const value = Array.isArray(display)
    ? display.map((entry) => esc(entry)).join(", ")
    : esc(display);
  return `<div class="edge-prov-row" data-available="true"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}

function renderProvenanceAsOf(field) {
  if (!field || field.available === false || field.value == null || field.value === "") return "";
  const date = esc(field.value);
  return `<details class="edge-prov-as-of" title="Observed as of ${date}"><summary aria-label="Show as-of date">as of</summary><span role="tooltip">${date}</span></details>`;
}

/** Subtle warrant token that deep-links into the inspector for one claim. */
export function renderWhyBelieveControl(claim, { className = "" } = {}) {
  if (!claim?.claim_id) return "";
  const href = claim.inspect_href || `#claim-${encodeURIComponent(claim.claim_id)}`;
  const warrant = WARRANT_CLASSES[claim.how?.warrant_class] || WARRANT_CLASSES.not_yet_classified;
  const crossSpine = CROSS_SPINE_CONFIDENCE.includes(claim.cross_spine?.confidence)
    ? claim.cross_spine.confidence
    : "unmatched";
  const classes = ["edge-prov-why", `edge-prov-why-${warrant.id}`, `edge-prov-cross-spine-${crossSpine}`, className].filter(Boolean).join(" ");
  const aria = `Connection confidence: ${crossSpine}`;
  const title = `${aria}; evidence class: ${warrant.label}`;
  return `<a class="${esc(classes)}" data-edge-claim="${esc(claim.claim_id)}" data-warrant-class="${esc(warrant.id)}" data-cross-spine-confidence="${esc(crossSpine)}" href="${esc(href)}" aria-label="${esc(aria)}" title="${esc(title)}"><span class="edge-prov-confidence edge-prov-confidence-${esc(crossSpine)}">${esc(crossSpine)}</span></a>`;
}

/** Optional compact warrant key (not always-on chrome). */
export function renderWarrantClassLegend() {
  return "";
}

/**
 * Full inspector body for one claim (shareable deep-link target).
 * Safe HTML string; missing fields render as labeled gaps.
 */
export function renderEdgeProvenanceInspector(claim, { open = false } = {}) {
  if (!claim?.claim_id) return "";
  const warrant = WARRANT_CLASSES[claim.how?.warrant_class] || WARRANT_CLASSES.not_yet_classified;
  const stance = IDENTITY_STANCES[claim.confidence?.identity_stance] || IDENTITY_STANCES.not_scored;
  const crossSpine = CROSS_SPINE_CONFIDENCE.includes(claim.cross_spine?.confidence)
    ? claim.cross_spine.confidence
    : "unmatched";
  const openAttr = open ? " open" : "";
  const objectLink = claim.object_href
    ? `<a href="${esc(claim.object_href)}">${esc(claim.label)}</a>`
    : `<strong>${esc(claim.label)}</strong>`;

  return `<details class="edge-prov-inspector" id="claim-${esc(claim.claim_id)}" data-edge-claim="${esc(claim.claim_id)}" data-warrant-class="${esc(warrant.id)}" data-identity-stance="${esc(stance.id)}" data-cross-spine-confidence="${esc(crossSpine)}"${openAttr}>
    <summary class="edge-prov-summary"><span class="edge-prov-summary-label">Evidence</span></summary>
    <div class="edge-prov-detail">
      <p class="edge-prov-object">${objectLink}</p>
      <p class="edge-prov-warrants"><span class="edge-prov-confidence edge-prov-confidence-${esc(crossSpine)}" data-cross-spine-confidence="${esc(crossSpine)}">${esc(crossSpine)}</span><span class="edge-prov-warrant edge-prov-warrant-${esc(warrant.id)}" data-warrant-class="${esc(warrant.id)}">${esc(warrant.label)}</span></p>
      ${renderProvenanceAsOf(claim.where.observed_at)}
      <section class="edge-prov-block" aria-labelledby="edge-prov-where-${esc(claim.claim_id)}">
        <h3 id="edge-prov-where-${esc(claim.claim_id)}">Evidence details</h3>
        <dl class="edge-prov-dl">
          ${renderFieldRow("Relation", claim.relation ? { available: true, value: claim.relation } : null)}
          ${renderFieldRow("Source", claim.where.source_system?.available
            ? { available: true, value: sourceSystemReaderLabel(claim.where.source_system.value) || claim.where.source_system.value }
            : claim.where.source_system)}
          ${renderFieldRow("Source record", claim.where.source_record_id)}
          ${renderFieldRow("Source fields", claim.where.source_fields)}
          ${renderFieldRow("Join method", claim.how.method)}
          ${renderFieldRow("Source excerpt", claim.where.source_excerpt)}
          ${renderFieldRow("Link record", claim.enrichment?.entity_link_id)}
          ${renderFieldRow("Resolution run", claim.enrichment?.resolution_run_id)}
        </dl>
      </section>
      ${claim.share_href ? `<p class="edge-prov-share"><a class="node-action civic-object-action" data-edge-claim-share="${esc(claim.claim_id)}" href="${esc(claim.share_href)}">Share this claim</a></p>` : ""}
    </div>
  </details>`;
}

/**
 * Host document shell: legend + one inspector panel, driven by ?claim=.
 * Claims array is the portable payload; client script selects the open claim.
 */
export function renderEdgeProvenancePanel(claims = [], { activeClaimId = null } = {}) {
  const list = Array.isArray(claims) ? claims.filter(Boolean) : [];
  if (!list.length) return "";
  const active = activeClaimId
    ? list.find((claim) => claim.claim_id === activeClaimId) || null
    : null;
  const body = active ? renderEdgeProvenanceInspector(active) : "";
  const hiddenAttr = active ? "" : " hidden";
  const claimPayload = JSON.stringify(list).replace(/<\/script/gi, "<\\/script");
  return `<section class="edge-prov-panel node-section node-card civic-object-section" id="edge-provenance" data-edge-provenance-panel="1" data-export-class="object_provenance" aria-labelledby="edge-prov-panel-heading"${hiddenAttr}>
    <h2 id="edge-prov-panel-heading">Connection evidence</h2>
    <p class="edge-prov-boundary">Connections compare evidence; identities stay separate.</p>
    <div class="edge-prov-panel-body" data-edge-prov-body="1">${body}</div>
    <script type="application/json" id="edge-provenance-claims">${claimPayload}</script>
  </section>`;
}

/** Client boot for static documents — select claim from ?claim= and keep URL shareable. */
export function edgeProvenanceClientScript() {
  return `(() => {
  const params = new URLSearchParams(location.search);
  const claimId = (params.get("claim") || "").trim();
  const panel = document.querySelector("[data-edge-provenance-panel]");
  const body = panel?.querySelector("[data-edge-prov-body]");
  const claimsEl = document.getElementById("edge-provenance-claims");
  if (!panel || !body || !claimsEl) return;
  let claims = [];
  try { claims = JSON.parse(claimsEl.textContent || "[]"); } catch { claims = []; }
  const byId = new Map(claims.map((c) => [c.claim_id, c]));

  const render = (claim) => {
    if (!claim) {
      body.replaceChildren();
      panel.hidden = true;
      panel.removeAttribute("data-active-claim");
      return;
    }
    panel.hidden = false;
    const existing = document.getElementById("claim-" + CSS.escape(claim.claim_id));
    if (existing && existing.closest("[data-edge-prov-body]")) {
      existing.setAttribute("data-open", "true");
      panel.setAttribute("data-active-claim", claim.claim_id);
      existing.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    const warrant = claim.how?.warrant_class || "not_yet_classified";
    const stance = claim.confidence?.identity_stance || "not_scored";
    const crossSpine = ["confirmed", "review", "unmatched"].includes(claim.cross_spine?.confidence)
      ? claim.cross_spine.confidence
      : "unmatched";
    const where = claim.where || {};
    const sourceLabel = (s) => {
      const map = { city_record: "City Record", warehouse: "Warehouse materialization", socrata: "NYC Open Data", enacted_local_law: "Enacted local law" };
      const key = String(s || "").trim();
      return map[key] || key.replace(/_/g, " ");
    };
    const escText = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<":"&lt;",">":"&gt;","&":"&amp;" }[c]));
    const field = (label, f, opts = {}) => {
      if (!f || f.available === false || f.value == null || f.value === "") return "";
      let raw = f.value;
      if (opts.source && !Array.isArray(raw)) raw = sourceLabel(raw);
      const val = Array.isArray(raw) ? raw.map((v) => escText(v)).join(", ") : escText(raw);
      return '<div class="edge-prov-row" data-available="true"><dt>' + escText(label) + '</dt><dd>' + val + '</dd></div>';
    };
    const asOf = (f) => (!f || f.available === false || f.value == null || f.value === "")
      ? ""
      : '<details class="edge-prov-as-of" title="Observed as of ' + escText(f.value) + '"><summary aria-label="Show as-of date">as of</summary><span role="tooltip">' + escText(f.value) + '</span></details>';
    const objectHtml = claim.object_href
      ? '<a href="' + escText(claim.object_href) + '">' + escText(claim.label) + "</a>"
      : '<strong>' + escText(claim.label) + "</strong>";
    body.innerHTML = '<details class="edge-prov-inspector" id="claim-' + escText(claim.claim_id) + '" data-edge-claim="' + escText(claim.claim_id) + '" data-warrant-class="' + escText(warrant) + '" data-identity-stance="' + escText(stance) + '" data-cross-spine-confidence="' + escText(crossSpine) + '">' +
      + '<summary class="edge-prov-summary"><span class="edge-prov-summary-label">Evidence</span></summary>'
      + '<div class="edge-prov-detail"><p class="edge-prov-object">' + objectHtml + '</p><p class="edge-prov-warrants"><span class="edge-prov-confidence edge-prov-confidence-' + escText(crossSpine) + '">' + escText(crossSpine) + '</span><span class="edge-prov-warrant edge-prov-warrant-' + escText(warrant) + '">' + escText(claim.how?.warrant_label || warrant) + '</span></p>' + asOf(where.observed_at)
      + '<section class="edge-prov-block"><h3>Evidence details</h3><dl class="edge-prov-dl">'
      + field("Relation", claim.relation ? { available: true, value: claim.relation } : null)
      + field("Source", where.source_system, { source: true }) + field("Source record", where.source_record_id)
      + field("Source fields", where.source_fields) + field("Join method", claim.how?.method)
      + field("Source excerpt", where.source_excerpt) + field("Link record", claim.enrichment?.entity_link_id)
      + field("Resolution run", claim.enrichment?.resolution_run_id) + "</dl></section>"
      + (claim.share_href ? '<p class="edge-prov-share"><a class="node-action civic-object-action" data-edge-claim-share="' + escText(claim.claim_id) + '" href="' + escText(claim.share_href) + '">Share this claim</a></p>' : "")
      + "</div></details>";
    panel.setAttribute("data-active-claim", claim.claim_id);
    body.querySelector(".edge-prov-inspector")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const selectClaim = (id, { push = false } = {}) => {
    const claim = byId.get(id) || null;
    render(claim);
    document.querySelectorAll("[data-edge-claim].edge-prov-why").forEach((el) => {
      el.setAttribute("aria-current", el.getAttribute("data-edge-claim") === id ? "true" : "false");
    });
    if (push) {
      const url = new URL(location.href);
      if (claim) url.searchParams.set("claim", claim.claim_id);
      else url.searchParams.delete("claim");
      history.replaceState({}, "", url.pathname + url.search + url.hash);
    }
  };

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-edge-claim]");
    if (!link || !panel.contains(link) && !link.classList.contains("edge-prov-why")) return;
    if (link.hasAttribute("data-edge-claim-share")) return; // allow normal navigation / copy later
    if (!link.classList.contains("edge-prov-why")) return;
    event.preventDefault();
    selectClaim(link.getAttribute("data-edge-claim"), { push: true });
  });

  if (claimId && byId.has(claimId)) selectClaim(claimId, { push: false });
})();`;
}
