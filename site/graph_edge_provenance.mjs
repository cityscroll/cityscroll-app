/**
 * Evidence-bearing civic graph — edge / claim provenance inspection (first iteration).
 *
 * General surface: any graph edge or claim can expose where it came from, how it
 * was derived (warrant class), and an honest confidence stance. Confidence bands
 * are never treated as confirmed identity. Missing fields stay labeled, never
 * invented. Hosted first on the agency cross-category graph; other hosts may
 * reuse the same claim model and deep-link grammar.
 */

export const GRAPH_EDGE_PROVENANCE_SCHEMA = "cityscroll.graph_edge_provenance.v1";
export const GRAPH_EDGE_PROVENANCE_METHOD = "graph_edge_provenance_v1";

/** Exact publisher key / registry match vs score-based linkage vs person-accepted review. */
export const WARRANT_CLASSES = Object.freeze({
  exact: Object.freeze({
    id: "exact",
    label: "Exact match",
    short: "Exact",
    reader:
      "Joined by an exact publisher key or a named identity registry match — not by a similarity score.",
  }),
  probabilistic: Object.freeze({
    id: "probabilistic",
    label: "Probabilistic link",
    short: "Possible",
    reader:
      "Joined by record-linkage features or a similarity score. A high score is still only a possible link, never a verified identity.",
  }),
  reviewed: Object.freeze({
    id: "reviewed",
    label: "Person-accepted",
    short: "Reviewed",
    reader:
      "A person accepted or rejected this link after inspecting the evidence. The disposition is the warrant, not an automatic score.",
  }),
  not_yet_classified: Object.freeze({
    id: "not_yet_classified",
    label: "Not yet classified",
    short: "Unclassified",
    reader:
      "This edge is listed in the materialization, but its warrant class is not stamped yet. Do not treat it as verified.",
  }),
});

export const WARRANT_CLASS_ORDER = Object.freeze([
  "exact",
  "probabilistic",
  "reviewed",
  "not_yet_classified",
]);

/** Reader-facing confidence stance — score ≠ confirmed identity. */
export const IDENTITY_STANCES = Object.freeze({
  publisher_key: Object.freeze({
    id: "publisher_key",
    label: "Publisher key match",
    reader:
      "The publisher record names this agency (or its code) directly. That is a source field match, not a CityScroll identity merge.",
  }),
  strong_link: Object.freeze({
    id: "strong_link",
    label: "High-confidence band (not a verified identity)",
    reader:
      "The public confidence band is high, but a score is not a confirmed identity. This is not promoted to a verified total.",
  }),
  possible_link: Object.freeze({
    id: "possible_link",
    label: "Possible link — not confirmed",
    reader:
      "This is a possible link only. It is never counted as a verified identity or a confirmed total.",
  }),
  not_scored: Object.freeze({
    id: "not_scored",
    label: "Link not scored",
    reader:
      "No public confidence band is attached. Absence of a score is not evidence the city withheld a field.",
  }),
});

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

/** Reader labels for known methods — never dump raw method ids into body copy. */
const METHOD_READER_LABELS = Object.freeze({
  agency_canonical_v1: "Agency identity registry match",
  publisher_certification_record_v1: "Publisher civil-service certification record",
  publisher_certification_record: "Publisher civil-service certification record",
  vendor_stem_v1: "Exact vendor-name stem match",
  pin_exact: "Exact PIN match",
  manual_review: "Person-accepted match",
  graph_edge_provenance_v1: "Graph edge provenance",
  agency_constellation_v1: "Agency cross-category materialization",
  enacted_law_mandate_extract_v1: "Enacted-law mandate extraction",
  auto_certified_quote_verify_v1: "Auto-certified quote verification",
  statute_actor_alias_v1: "Statute actor alias match",
});

export function methodReaderLabel(method) {
  const key = clean(method, 120);
  if (!key) return null;
  if (METHOD_READER_LABELS[key]) return METHOD_READER_LABELS[key];
  const lower = key.toLowerCase();
  if (METHOD_READER_LABELS[lower]) return METHOD_READER_LABELS[lower];
  // Soften unknown method tokens rather than printing snake_case to readers.
  return key.replace(/_/g, " ").replace(/\s+v\d+$/i, "").trim() || null;
}

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
  label: "Not yet attached",
  note: "This field is not populated on the public graph edge yet. Later enrichment may add it without inventing a trail.",
});

/**
 * Normalize public confidence bands carried on graph edges.
 * `publisher_record` is a strong publisher stamp, not a numeric score.
 */
export function normalizePublicConfidence(value) {
  const confidence = clean(value, 40).toLowerCase();
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
 * Fail-closed identity stance: strong ≠ confirmed identity.
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
      || method.includes("pin_exact")
    )
  ) {
    return IDENTITY_STANCES.publisher_key;
  }
  if (confidence === "strong" || warrant.id === "exact" || warrant.id === "reviewed") {
    return IDENTITY_STANCES.strong_link;
  }
  return IDENTITY_STANCES.not_scored;
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

  const method = clean(item.method, 120) || null;
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

  const sourceSystem = clean(
    provenance.source_system || evidence.source_system || item.source,
    120,
  ) || null;
  const sourceRecordId = clean(
    provenance.source_record_id || evidence.source_record_id || item.source_record_id,
    200,
  ) || null;
  const sourceFields = Array.isArray(provenance.source_fields)
    ? provenance.source_fields.map((field) => clean(field, 80)).filter(Boolean)
    : Array.isArray(evidence.source_fields)
      ? evidence.source_fields.map((field) => clean(field, 80)).filter(Boolean)
      : [];
  const inputValue = clean(
    provenance.input_value || evidence.input_value || item.input_value,
    240,
  ) || null;
  const basis = clean(
    provenance.basis || evidence.basis || item.basis,
    120,
  ) || null;
  const observedAt = clean(
    provenance.observed_at || evidence.observed_at || item.date,
    40,
  ) || null;

  // Shadow ER tables (entity_link / resolution_run) are not public consumers yet.
  const entityLinkId = clean(item.entity_link_id || item.link_id, 120) || null;
  const resolutionRunId = clean(item.resolution_run_id, 120) || null;

  const documentPath = clean(context.document_path, 200) || null;
  const href = documentPath ? claimInspectHref(documentPath, claimId) : null;

  const missing = [];
  if (!sourceRecordId) missing.push("source_record_id");
  if (!sourceFields.length) missing.push("source_fields");
  if (!inputValue) missing.push("input_value");
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
    relation: clean(item.relation || context.relation, 80) || null,
    label: clean(item.label || subjectRef, 240),
    object_href: clean(item.href, 200) || null,
    where: {
      source_system: sourceSystem ? fieldOrMissing(sourceSystem) : { ...MISSING },
      source_record_id: sourceRecordId ? fieldOrMissing(sourceRecordId) : { ...MISSING },
      source_fields: sourceFields.length
        ? { available: true, value: sourceFields }
        : { ...MISSING, value: [] },
      input_value: inputValue ? fieldOrMissing(inputValue) : { ...MISSING },
      observed_at: observedAt ? fieldOrMissing(observedAt) : { ...MISSING },
      basis: basis ? fieldOrMissing(basis) : { ...MISSING },
    },
    how: {
      method: method ? fieldOrMissing(method) : { ...MISSING },
      warrant_class: warrant.id,
      warrant_label: warrant.label,
      warrant_reader: warrant.reader,
      decision: clean(item.decision || item.review_status, 80) || null,
    },
    confidence: {
      band: confidence,
      identity_stance: stance.id,
      identity_label: stance.label,
      identity_reader: stance.reader,
      // Hard rule: never treat a score band as a verified identity total.
      is_verified_identity: false,
      counts_as_verified_total: warrant.id === "exact" && confidence === "strong",
    },
    enrichment: {
      entity_link_id: entityLinkId ? fieldOrMissing(entityLinkId) : { ...MISSING },
      resolution_run_id: resolutionRunId ? fieldOrMissing(resolutionRunId) : { ...MISSING },
      next: missing.length
        ? "Later iterations may attach shadow link-record and resolution-run ids and fuller source excerpts when those fields are public."
        : null,
      missing_fields: missing,
    },
    inspect_href: href,
    share_href: href,
  };
}

/**
 * Summarize category membership with fail-closed totals:
 * possible (probabilistic / tentative) edges never inflate verified counts.
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
  };
  for (const item of Array.isArray(items) ? items : []) {
    const claim = item?.claim || buildEdgeProvenanceClaim(item);
    if (!claim) continue;
    summary.listed_total += 1;
    const warrant = claim.how?.warrant_class || "not_yet_classified";
    if (summary[warrant] != null) summary[warrant] += 1;
    else summary.not_yet_classified += 1;
    if (claim.confidence?.counts_as_verified_total) summary.verified_total += 1;
    else summary.possible_total += 1;
  }
  return summary;
}

function renderFieldRow(label, field, { mono = false, reader = false } = {}) {
  if (!field || field.available === false) {
    return `<div class="edge-prov-row" data-available="false"><dt>${esc(label)}</dt><dd class="muted node-muted"><span class="edge-prov-missing">${esc(field?.label || "Not yet attached")}</span>${field?.note ? ` — ${esc(field.note)}` : ""}</dd></div>`;
  }
  let display = field.value;
  if (reader && !Array.isArray(display)) {
    display = methodReaderLabel(display) || display;
  }
  const value = Array.isArray(display)
    ? display.map((entry) => esc(entry)).join(", ")
    : mono
      ? esc(display)
      : esc(display);
  return `<div class="edge-prov-row" data-available="true"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}

/** Compact control that deep-links into the inspector for one claim. */
export function renderWhyBelieveControl(claim, { className = "" } = {}) {
  if (!claim?.claim_id) return "";
  const href = claim.inspect_href || `#claim-${encodeURIComponent(claim.claim_id)}`;
  const warrant = WARRANT_CLASSES[claim.how?.warrant_class] || WARRANT_CLASSES.not_yet_classified;
  const possible = claim.how?.warrant_class === "probabilistic"
    || claim.confidence?.identity_stance === "possible_link";
  const classes = [
    "edge-prov-why",
    className,
    possible ? "is-possible" : "",
  ].filter(Boolean).join(" ");
  return `<a class="${esc(classes)}" data-edge-claim="${esc(claim.claim_id)}" data-warrant-class="${esc(warrant.id)}" href="${esc(href)}">Why do we believe this? · ${esc(warrant.short)}</a>`;
}

/** Warrant-class key for the host page (all three classes visible even when unused). */
export function renderWarrantClassLegend() {
  const items = WARRANT_CLASS_ORDER
    .filter((id) => id !== "not_yet_classified")
    .map((id) => {
      const warrant = WARRANT_CLASSES[id];
      return `<li data-warrant-class="${esc(warrant.id)}"><strong class="edge-prov-warrant edge-prov-warrant-${esc(warrant.id)}">${esc(warrant.label)}</strong> — ${esc(warrant.reader)}</li>`;
    })
    .join("");
  return `<section class="edge-prov-legend node-section civic-object-section" data-export-class="object_provenance" aria-labelledby="edge-prov-legend-heading">
    <h2 id="edge-prov-legend-heading">How links are warranted</h2>
    <p class="node-muted muted">Every connection carries a warrant class. A score or high-confidence band is never the same thing as a confirmed identity — possible links stay possible and are not promoted into verified totals.</p>
    <ul class="edge-prov-legend-list">${items}</ul>
  </section>`;
}

/**
 * Full inspector body for one claim (shareable deep-link target).
 * Safe HTML string; missing fields render as labeled gaps.
 */
export function renderEdgeProvenanceInspector(claim, { open = false } = {}) {
  if (!claim?.claim_id) return "";
  const warrant = WARRANT_CLASSES[claim.how?.warrant_class] || WARRANT_CLASSES.not_yet_classified;
  const stance = IDENTITY_STANCES[claim.confidence?.identity_stance] || IDENTITY_STANCES.not_scored;
  const possible = warrant.id === "probabilistic" || stance.id === "possible_link";
  const openAttr = open ? " open" : "";
  const objectLink = claim.object_href
    ? `<p class="edge-prov-object"><a href="${esc(claim.object_href)}">${esc(claim.label)}</a></p>`
    : `<p class="edge-prov-object"><strong>${esc(claim.label)}</strong></p>`;

  return `<article class="edge-prov-inspector" id="claim-${esc(claim.claim_id)}" data-edge-claim="${esc(claim.claim_id)}" data-warrant-class="${esc(warrant.id)}" data-identity-stance="${esc(stance.id)}" data-verified-identity="false"${openAttr ? ' data-open="true"' : ""}>
    <header class="edge-prov-header">
      <p class="edge-prov-kicker">Why do we believe this?</p>
      ${objectLink}
      <p class="edge-prov-meta muted node-muted">
        ${claim.relation ? `Relation: ${esc(String(claim.relation).replace(/_/g, " "))} · ` : ""}
        Claim id: ${esc(claim.claim_id)}
      </p>
      <p class="edge-prov-warrants">
        <span class="edge-prov-warrant edge-prov-warrant-${esc(warrant.id)}" data-warrant-class="${esc(warrant.id)}">${esc(warrant.label)}</span>
        <span class="edge-prov-stance edge-prov-stance-${esc(stance.id)}" data-identity-stance="${esc(stance.id)}">${esc(stance.label)}</span>
      </p>
    </header>
    <div class="edge-prov-honesty${possible ? " is-possible" : ""}" data-fail-closed="1">
      <p><strong>Confidence is not identity.</strong> ${esc(stance.reader)}</p>
      ${possible ? `<p class="edge-prov-possible-note">This possible link is <strong>not</strong> counted as a verified total.</p>` : ""}
    </div>
    <section class="edge-prov-block" aria-labelledby="edge-prov-where-${esc(claim.claim_id)}">
      <h3 id="edge-prov-where-${esc(claim.claim_id)}">Where it came from</h3>
      <dl class="edge-prov-dl">
        ${renderFieldRow("Source", claim.where.source_system?.available
          ? { available: true, value: sourceSystemReaderLabel(claim.where.source_system.value) || claim.where.source_system.value }
          : claim.where.source_system)}
        ${renderFieldRow("Source record", claim.where.source_record_id)}
        ${renderFieldRow("Source fields", {
          ...claim.where.source_fields,
          value: Array.isArray(claim.where.source_fields?.value)
            ? claim.where.source_fields.value.map((field) => String(field).replace(/_/g, " "))
            : claim.where.source_fields?.value,
        })}
        ${renderFieldRow("Publisher value matched", claim.where.input_value)}
        ${renderFieldRow("Observed", claim.where.observed_at)}
        ${renderFieldRow("Basis", claim.where.basis, { reader: true })}
      </dl>
    </section>
    <section class="edge-prov-block" aria-labelledby="edge-prov-how-${esc(claim.claim_id)}">
      <h3 id="edge-prov-how-${esc(claim.claim_id)}">How it was derived</h3>
      <p>${esc(warrant.reader)}</p>
      <dl class="edge-prov-dl">
        ${renderFieldRow("Method", claim.how.method, { reader: true })}
        ${renderFieldRow("Warrant class", { available: true, value: warrant.label })}
        ${claim.how.decision
          ? renderFieldRow("Review decision", { available: true, value: claim.how.decision })
          : renderFieldRow("Review decision", { ...MISSING, note: "No person-accepted disposition is attached to this public edge." })}
      </dl>
    </section>
    <section class="edge-prov-block" aria-labelledby="edge-prov-enrich-${esc(claim.claim_id)}">
      <h3 id="edge-prov-enrich-${esc(claim.claim_id)}">Next enrichment</h3>
      <dl class="edge-prov-dl">
        ${renderFieldRow("Link record id", claim.enrichment.entity_link_id)}
        ${renderFieldRow("Resolution run id", claim.enrichment.resolution_run_id)}
      </dl>
      ${claim.enrichment.next
        ? `<p class="muted node-muted">${esc(String(claim.enrichment.next)
          .replace(/entity_link/g, "link record")
          .replace(/resolution_run/g, "resolution run"))}</p>`
        : ""}
    </section>
    ${claim.share_href ? `<p class="edge-prov-share"><a class="node-action civic-object-action" data-edge-claim-share="${esc(claim.claim_id)}" href="${esc(claim.share_href)}">Shareable link to this claim</a></p>` : ""}
  </article>`;
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
  const body = active
    ? renderEdgeProvenanceInspector(active, { open: true })
    : `<div class="edge-prov-empty muted node-muted" data-edge-prov-empty="1">
        <p>Choose <strong>Why do we believe this?</strong> on any linked record to inspect where it came from, how it was joined, and its warrant class (exact, probabilistic, or reviewed).</p>
      </div>`;
  const claimPayload = JSON.stringify(list).replace(/<\/script/gi, "<\\/script");
  return `${renderWarrantClassLegend()}
  <section class="edge-prov-panel node-section node-card civic-object-section" id="edge-provenance" data-edge-provenance-panel="1" data-export-class="object_provenance" aria-labelledby="edge-prov-panel-heading">
    <h2 id="edge-prov-panel-heading">Inspect a connection</h2>
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
      body.innerHTML = '<div class="edge-prov-empty muted node-muted" data-edge-prov-empty="1"><p>Choose <strong>Why do we believe this?</strong> on any linked record to inspect where it came from, how it was joined, and its warrant class (exact, probabilistic, or reviewed).</p></div>';
      panel.removeAttribute("data-active-claim");
      return;
    }
    // Prefer the pre-rendered open inspector when present in the document for the active claim;
    // otherwise rebuild from the JSON payload (same fields the server used).
    const existing = document.getElementById("claim-" + CSS.escape(claim.claim_id));
    if (existing && existing.closest("[data-edge-prov-body]")) {
      existing.setAttribute("data-open", "true");
      panel.setAttribute("data-active-claim", claim.claim_id);
      existing.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    const warrant = claim.how?.warrant_class || "not_yet_classified";
    const stance = claim.confidence?.identity_stance || "not_scored";
    const possible = warrant === "probabilistic" || stance === "possible_link";
    const where = claim.where || {};
    const methodLabel = (m) => {
      const map = {
        agency_canonical_v1: "Agency identity registry match",
        publisher_certification_record_v1: "Publisher civil-service certification record",
        publisher_certification_record: "Publisher civil-service certification record",
        vendor_stem_v1: "Exact vendor-name stem match",
        pin_exact: "Exact PIN match",
        manual_review: "Person-accepted match",
      };
      const key = String(m || "").trim();
      return map[key] || key.replace(/_/g, " ").replace(/\\s+v\\d+$/i, "").trim() || key;
    };
    const sourceLabel = (s) => {
      const map = { city_record: "City Record", warehouse: "Warehouse materialization", socrata: "NYC Open Data" };
      const key = String(s || "").trim();
      return map[key] || key.replace(/_/g, " ");
    };
    const field = (label, f, opts = {}) => {
      if (!f || f.available === false) {
        return '<div class="edge-prov-row" data-available="false"><dt>' + label + '</dt><dd class="muted node-muted"><span class="edge-prov-missing">' + (f?.label || "Not yet attached") + '</span>' + (f?.note ? " — " + f.note : "") + '</dd></div>';
      }
      let raw = f.value;
      if (opts.source && !Array.isArray(raw)) raw = sourceLabel(raw);
      if (opts.reader && !Array.isArray(raw)) raw = methodLabel(raw);
      if (opts.fields && Array.isArray(raw)) raw = raw.map((v) => String(v).replace(/_/g, " "));
      const val = Array.isArray(raw) ? raw.map((v) => String(v)).join(", ") : String(raw);
      return '<div class="edge-prov-row" data-available="true"><dt>' + label + '</dt><dd>' + val + '</dd></div>';
    };
    const escText = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<":"&lt;",">":"&gt;","&":"&amp;" }[c]));
    const objectHtml = claim.object_href
      ? '<p class="edge-prov-object"><a href="' + escText(claim.object_href) + '">' + escText(claim.label) + "</a></p>"
      : '<p class="edge-prov-object"><strong>' + escText(claim.label) + "</strong></p>";
    body.innerHTML = '<article class="edge-prov-inspector" id="claim-' + escText(claim.claim_id) + '" data-edge-claim="' + escText(claim.claim_id) + '" data-warrant-class="' + escText(warrant) + '" data-identity-stance="' + escText(stance) + '" data-verified-identity="false" data-open="true">'
      + '<header class="edge-prov-header"><p class="edge-prov-kicker">Why do we believe this?</p>' + objectHtml
      + '<p class="edge-prov-meta muted node-muted">' + (claim.relation ? "Relation: " + escText(String(claim.relation).replace(/_/g, " ")) + " · " : "") + "Claim id: " + escText(claim.claim_id) + "</p>"
      + '<p class="edge-prov-warrants"><span class="edge-prov-warrant edge-prov-warrant-' + escText(warrant) + '">' + escText(claim.how?.warrant_label || warrant) + '</span> '
      + '<span class="edge-prov-stance edge-prov-stance-' + escText(stance) + '">' + escText(claim.confidence?.identity_label || stance) + "</span></p></header>"
      + '<div class="edge-prov-honesty' + (possible ? " is-possible" : "") + '" data-fail-closed="1"><p><strong>Confidence is not identity.</strong> ' + escText(claim.confidence?.identity_reader || "") + "</p>"
      + (possible ? '<p class="edge-prov-possible-note">This possible link is <strong>not</strong> counted as a verified total.</p>' : "") + "</div>"
      + '<section class="edge-prov-block"><h3>Where it came from</h3><dl class="edge-prov-dl">'
      + field("Source", where.source_system, { source: true }) + field("Source record", where.source_record_id)
      + field("Source fields", where.source_fields, { fields: true }) + field("Publisher value matched", where.input_value)
      + field("Observed", where.observed_at) + field("Basis", where.basis, { reader: true }) + "</dl></section>"
      + '<section class="edge-prov-block"><h3>How it was derived</h3><p>' + escText(claim.how?.warrant_reader || "") + '</p><dl class="edge-prov-dl">'
      + field("Method", claim.how?.method, { reader: true })
      + field("Warrant class", { available: true, value: claim.how?.warrant_label || warrant })
      + (claim.how?.decision
        ? field("Review decision", { available: true, value: claim.how.decision })
        : field("Review decision", { available: false, label: "Not yet attached", note: "No person-accepted disposition is attached to this public edge." }))
      + "</dl></section>"
      + '<section class="edge-prov-block"><h3>Next enrichment</h3><dl class="edge-prov-dl">'
      + field("Link record id", claim.enrichment?.entity_link_id)
      + field("Resolution run id", claim.enrichment?.resolution_run_id) + "</dl>"
      + (claim.enrichment?.next ? '<p class="muted node-muted">' + escText(String(claim.enrichment.next).replace(/entity_link/g, "link record").replace(/resolution_run/g, "resolution run")) + "</p>" : "")
      + "</section>"
      + (claim.share_href ? '<p class="edge-prov-share"><a class="node-action civic-object-action" data-edge-claim-share="' + escText(claim.claim_id) + '" href="' + escText(claim.share_href) + '">Shareable link to this claim</a></p>' : "")
      + "</article>";
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
