/**
 * Resident-safe assertion inspector over the Card 1 provenance read model.
 *
 * Production adapters hydrate immutable assertions and evidence into the
 * private adjacency list, then this module exposes only policy-approved,
 * standable walks. Review actors, notes, raw snapshots, receipt payloads, and
 * internal source keys never enter the resident projection.
 */

import {
  buildProvenanceGraph,
  provenanceForAssertion,
  publicProvenanceProjection,
  walkProvenance,
} from "../entity_resolution/provenance_graph.mjs";
import { projectAgencyVendorAssertionIdentity } from "../entity_resolution/cross_domain/project_agency_vendor_assertions.mjs";
import {
  buildEdgeProvenanceClaim,
  isStandablePublicClaim,
} from "./graph_edge_provenance.mjs";
import {
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeBack,
  renderNodeFooter,
  renderNodeSection,
} from "./civic_document_chrome.mjs";
import { officialSourceLink } from "./affordance_grammar.mjs";
import { entityHref, parseEntityRef } from "./entity_pivot.mjs";
import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { readerLabel } from "./reader_surface_labels.mjs";
import { residentOfficialSource } from "./provenance_disclosure.mjs";

export const PUBLIC_ASSERTION_GRAPH_SCHEMA = "cityscroll.public_assertion_graph.v1";
export const ASSERTION_INSPECTOR_SCHEMA = "cityscroll.assertion_inspector.v1";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function publicHttps(value) {
  try {
    const url = new URL(clean(value, 1_000));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function relationLabel(relation) {
  return ({
    parcel_links_project: "Links this record to a land-use project",
    published_by_agency: "Identifies the publishing agency",
    named_developer: "Names the developer",
  })[relation] || readerLabel(relation, "Related civic record");
}

function methodLabel(method) {
  const value = clean(method, 120);
  if (value === "exact_bbl_v1") return "Exact tax-lot match";
  if (value === "agency_canonical_v1") return "Published agency-name match";
  if (value === "reviewed_publisher_role_v1") return "Reviewed publisher-role match";
  return readerLabel(value, "Published-record match");
}

function objectDescriptor(ref, bundle = {}) {
  const value = clean(ref, 320);
  const notice = value.match(/^notice:([A-Za-z0-9_-]{1,80})$/);
  if (notice) {
    return {
      ref: value,
      kind: "notice",
      label: clean(bundle.label, 240) || `City Record notice ${notice[1]}`,
      href: `/notices/${encodeURIComponent(notice[1])}`,
    };
  }
  const parsed = parseEntityRef(value);
  if (!parsed) return null;
  if (parsed.kind === "project") {
    return {
      ref: value,
      kind: "project",
      label: `Land-use project ${parsed.id}`,
      href: `/browse/zoning/#land/${encodeURIComponent(parsed.id)}`,
    };
  }
  if (parsed.kind === "agency") {
    const canonicalId = parsed.id.replace(/^id:/, "");
    const identity = resolveAgencyIdentity(canonicalId);
    const href = entityHref({ ref: value, label: identity.canonical_name });
    return href ? {
      ref: value,
      kind: "agency",
      label: identity.canonical_name,
      href,
    } : null;
  }
  if (parsed.kind === "vendor") {
    let label = parsed.id.replace(/^stem:/, "");
    try { label = decodeURIComponent(label); } catch { /* keep the reviewed stem */ }
    const href = entityHref({ ref: value, label });
    return href ? { ref: value, kind: "vendor", label, href } : null;
  }
  if (parsed.kind === "parcel") {
    return {
      ref: value,
      kind: "parcel",
      label: `Property lot ${parsed.id}`,
      href: `/parcels/${parsed.id}/`,
    };
  }
  return null;
}

function sourceEvidence(edge, assertionId) {
  const provenance = edge?.provenance || {};
  const observedAt = clean(provenance.observed_at || edge?.relevant_time, 40);
  const fields = Array.isArray(provenance.source_fields)
    ? [...new Set(provenance.source_fields.map((field) => clean(field, 80)).filter(Boolean))]
    : [];
  const official = residentOfficialSource({
    sourceSystem: provenance.source_system,
    sourceRecordId: provenance.source_record_id,
    sourceHref: provenance.source_url,
  });
  if (!provenance.source_system || !provenance.source_record_id || !official || !fields.length || !observedAt) {
    return null;
  }
  return {
    kind: "source_field",
    id: `source:${assertionId}`,
    source_system: clean(provenance.source_system, 120),
    source_system_id: clean(provenance.source_record_id, 200),
    source_url: official.href,
    source_label: official.label,
    source_fields: fields,
    observed_at: observedAt,
  };
}

function methodEvidence(edge) {
  const method = clean(edge?.method, 120);
  const version = clean(edge?.method_version, 80) || "1";
  if (!method) return null;
  return {
    kind: "resolution_run",
    id: `method:${method}:v${version}`,
    method,
    method_version: version,
    observed_at: clean(edge?.reviewed_at || edge?.relevant_time, 40) || null,
  };
}

function admittedEdge(bundle, edge) {
  const target = objectDescriptor(edge?.to, bundle);
  const source = sourceEvidence(edge, projectAgencyVendorAssertionIdentity(bundle, edge).assertion_id);
  if (!target || !source || clean(edge?.review_state, 40).toLowerCase() !== "accepted") {
    return null;
  }
  const claim = buildEdgeProvenanceClaim({
    ...edge,
    subject_ref: edge.from,
    relation: edge.type,
    label: target.label,
    href: target.href,
    observed_at: edge.provenance?.observed_at || edge.relevant_time,
  }, {
    category_id: "assertion",
    relation: edge.type,
    root_ref: edge.from,
  });
  return claim && isStandablePublicClaim(claim) && claim.confidence?.counts_as_verified_total
    ? { claim, source, target }
    : null;
}

/** Hydrate the committed production evidence bundle into the Card 1 graph. */
export function buildPublicAssertionGraph(intelligence = {}) {
  const source = intelligence?.project_agency_vendor || {};
  const assertions = [];
  const evidenceByRef = new Map();
  const metadata = new Map();
  let possible = 0;

  for (const bundle of Array.isArray(source.bundles) ? source.bundles : []) {
    const bundleId = clean(bundle.evidence_id, 200);
    const bundleEvidence = {
      kind: "reviewed_bundle",
      id: `bundle:${bundleId}`,
      review_state: "accepted",
      reviewed_at: clean(bundle.edges?.[0]?.reviewed_at, 40) || null,
      policy_version: clean(source.policy_version, 120) || null,
    };
    for (const edge of Array.isArray(bundle.edges) ? bundle.edges : []) {
      const admitted = admittedEdge(bundle, edge);
      if (!admitted) {
        possible += 1;
        continue;
      }
      const identity = projectAgencyVendorAssertionIdentity(bundle, edge);
      if (edge.assertion_id && edge.assertion_id !== identity.assertion_id) {
        possible += 1;
        continue;
      }
      const method = methodEvidence(edge);
      if (!method) {
        possible += 1;
        continue;
      }
      const assertion = {
        assertion_key: identity.assertion_key,
        assertion_id: identity.assertion_id,
        version: 1,
        claim_class: "cityscroll_interpretation",
        assertion_kind: clean(edge.type, 80),
        subject_ref: clean(edge.from, 320),
        predicate: clean(edge.type, 80),
        object_ref: clean(edge.to, 320),
        warrant_class: admitted.claim.how.warrant_class,
        status: "published",
        evidence_refs: [
          { kind: bundleEvidence.kind, id: bundleEvidence.id },
          { kind: admitted.source.kind, id: admitted.source.id },
        ],
        produced_by_refs: [{ kind: method.kind, id: method.id }],
      };
      assertions.push(assertion);
      for (const node of [bundleEvidence, admitted.source, method]) {
        const key = `${node.kind}\0${node.id}`;
        if (!evidenceByRef.has(key)) evidenceByRef.set(key, node);
      }
      metadata.set(identity.assertion_id, {
        assertion_id: identity.assertion_id,
        assertion_href: identity.assertion_href,
        bundle_id: bundleId,
        bundle,
        edge,
        claim: admitted.claim,
        target: admitted.target,
      });
    }
  }

  return {
    schema_version: PUBLIC_ASSERTION_GRAPH_SCHEMA,
    graph: buildProvenanceGraph({ assertions, evidence: [...evidenceByRef.values()] }),
    assertions: [...metadata.values()].map((row) => ({
      assertion_id: row.assertion_id,
      assertion_href: row.assertion_href,
      subject_ref: row.edge.from,
      object_ref: row.edge.to,
      relation: row.edge.type,
    })),
    metadata,
    receipt: {
      verified_assertion_count: assertions.length,
      possible_assertion_count: possible,
      publication_rule: "accepted review plus complete source provenance and standable policy-approved edge",
    },
  };
}

function publicEvidence(graph, assertionId) {
  const provenance = provenanceForAssertion(graph, assertionId);
  return provenance.evidence
    .filter((node) => node.kind === "source_record" || node.kind === "source_field")
    .map((node) => ({
      label: clean(node.source_label, 160) || "Official source",
      href: publicHttps(node.source_url),
      fields: (node.source_fields || []).map((field) => readerLabel(field, "")).filter(Boolean),
      observed_at: clean(node.observed_at, 40) || null,
    }))
    .filter((node) => node.href);
}

function publicAssertion(projection, assertionId) {
  const meta = projection.metadata.get(assertionId);
  if (!meta) return null;
  const safe = publicProvenanceProjection(projection.graph, assertionId);
  const edge = meta.edge;
  const source = publicEvidence(projection.graph, assertionId);
  return {
    assertion_id: safe.assertion.assertion_id,
    href: meta.assertion_href,
    label: `${meta.bundle.label}: ${relationLabel(edge.type)}`,
    relation: clean(edge.type, 80),
    relation_label: relationLabel(edge.type),
    subject: objectDescriptor(edge.from, meta.bundle),
    object: meta.target,
    method: {
      id: clean(edge.method, 120),
      version: clean(edge.method_version, 80) || null,
      label: methodLabel(edge.method),
      warrant: safe.assertion.warrant_class,
    },
    confidence: clean(edge.confidence, 40),
    review: {
      state: "accepted",
      reviewed_at: clean(edge.reviewed_at, 40) || null,
    },
    time: {
      observed_at: source[0]?.observed_at || null,
      relevant_at: clean(edge.relevant_time, 40) || null,
    },
    evidence: { sources: source },
  };
}

function assertionsForBundle(projection, bundleId) {
  return [...projection.metadata.values()]
    .filter((row) => row.bundle_id === bundleId)
    .map((row) => publicAssertion(projection, row.assertion_id))
    .filter(Boolean);
}

function relatedObjects(assertions, bundle) {
  const objects = [objectDescriptor(bundle.subject_ref, bundle), ...assertions.map((row) => row.object)]
    .filter(Boolean);
  return [...new Map(objects.map((object) => [object.ref, object])).values()];
}

/** Resolve either one immutable assertion id or every assertion for a subject. */
export function hydratePublicAssertionInspector(projection, selector = {}) {
  if (!projection?.graph || !(projection.metadata instanceof Map)) return null;
  const assertionId = clean(selector.assertion_id, 512);
  const subjectRef = clean(selector.subject_ref, 320);
  if (assertionId) {
    const meta = projection.metadata.get(assertionId);
    if (!meta) return null;
    const assertion = publicAssertion(projection, assertionId);
    const walk = walkProvenance(
      projection.graph,
      { node_type: "assertion", id: assertionId },
      { direction: "both", max_depth: 2 },
    );
    const walkedAssertionIds = new Set(walk.nodes
      .filter((node) => node.node_type === "assertion")
      .map((node) => node.id));
    const sameBundle = assertionsForBundle(projection, meta.bundle_id);
    const relatedAssertions = sameBundle.filter((row) => (
      row.assertion_id !== assertionId && walkedAssertionIds.has(row.assertion_id)
    ));
    return {
      schema_version: ASSERTION_INSPECTOR_SCHEMA,
      target: { kind: "assertion", assertion_id: assertionId },
      assertion,
      related_assertions: relatedAssertions,
      related_objects: relatedObjects(sameBundle, meta.bundle),
      intersection: {
        label: `Open all ${sameBundle.length} verified connections in Property`,
        href: clean(meta.bundle.browse_scope?.href, 2_000) || null,
      },
      counts: {
        verified_assertions: sameBundle.length,
        possible_assertions: 0,
      },
    };
  }
  if (subjectRef) {
    const entries = [...projection.metadata.values()].filter((row) => row.edge.from === subjectRef);
    if (!entries.length) return null;
    const assertions = entries.map((row) => publicAssertion(projection, row.assertion_id)).filter(Boolean);
    const bundle = entries[0].bundle;
    return {
      schema_version: ASSERTION_INSPECTOR_SCHEMA,
      target: { kind: "subject", subject: objectDescriptor(subjectRef, bundle) },
      assertions,
      related_objects: relatedObjects(assertions, bundle),
      intersection: {
        label: `Open all ${assertions.length} verified connections in Property`,
        href: clean(bundle.browse_scope?.href, 2_000) || null,
      },
      counts: {
        verified_assertions: assertions.length,
        possible_assertions: 0,
      },
    };
  }
  return null;
}

function assertionFacts(assertion) {
  const rows = [
    ["Connection", assertion.relation_label],
    ["Method", assertion.method.label],
    ["Confidence", readerLabel(assertion.confidence, "")],
    ["Review state", readerLabel(assertion.review.state, "")],
    ["Record observed", assertion.time.observed_at],
    ["Evidence reviewed", assertion.review.reviewed_at],
    ["Relevant time", assertion.time.relevant_at],
  ].filter(([, value]) => value);
  return `<dl class="node-facts">${rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("")}</dl>`;
}

function assertionCard(assertion, { detailed = false } = {}) {
  const sourceItems = assertion.evidence.sources.map((source) => (
    `<li>${officialSourceLink({ href: source.href, label: source.label, className: "node-source-link", escape: esc })}`
    + `${source.observed_at ? ` <span class="node-meta">observed ${esc(source.observed_at)}</span>` : ""}`
    + `${source.fields.length ? `<p>Published fields: ${esc(source.fields.join(", "))}</p>` : ""}</li>`
  )).join("");
  return `<article class="node-record assertion-record" data-assertion-id="${esc(assertion.assertion_id)}">
    <h3>${esc(assertion.label)}</h3>
    ${detailed ? assertionFacts(assertion) : `<p>${esc(assertion.method.label)} · ${esc(readerLabel(assertion.review.state, "Accepted"))}</p>`}
    <ul class="assertion-sources">${sourceItems}</ul>
    ${detailed ? "" : `<p><a href="${esc(assertion.href)}">Inspect this assertion</a></p>`}
  </article>`;
}

function objectCards(objects = []) {
  return objects.map((object) => `<li class="node-record" data-object-kind="${esc(object.kind)}"><a href="${esc(object.href)}">${esc(object.label)}</a></li>`).join("");
}

/** Render the hydrated, resident-safe assertion target as a standalone document. */
export function renderAssertionInspectorDocument(view, { currentHref = "" } = {}) {
  if (!view) return "";
  const assertion = view.target.kind === "assertion" ? view.assertion : null;
  const title = assertion?.label || view.target.subject?.label || "Assertion evidence";
  const canonicalPath = assertion?.href
    || `/assertions/?subject=${encodeURIComponent(view.target.subject?.ref || "")}`;
  const assertions = view.target.kind === "assertion" ? [assertion] : view.assertions;
  const evidenceBody = assertions.map((row) => assertionCard(row, {
    detailed: view.target.kind === "assertion",
  })).join("");
  const relatedAssertions = view.related_assertions?.length
    ? renderNodeSection({
      heading: "Related assertions",
      headingId: "related-assertions",
      body: `<ul>${view.related_assertions.map((row) => `<li><a href="${esc(row.href)}">${esc(row.relation_label)}</a></li>`).join("")}</ul>`,
      extraClass: "assertion-related",
    })
    : "";
  const relatedObjectsSection = renderNodeSection({
    heading: "Related civic objects",
    headingId: "related-civic-objects",
    body: `<ul>${objectCards(view.related_objects)}</ul>${view.intersection?.href ? `<p><a class="node-action" href="${esc(view.intersection.href)}">${esc(view.intersection.label)}</a></p>` : ""}`,
    extraClass: "assertion-objects",
  });
  const payload = JSON.stringify(view).replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} · Assertion evidence · CityScroll</title>
  <meta name="description" content="Inspect the official evidence and verified civic connections behind this CityScroll assertion.">
  <link rel="canonical" href="https://cityscroll.org${esc(canonicalPath)}">
  ${renderCivicDocumentAssets("/")}
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  ${renderCivicDocumentMast({ current: "browse", surfaceClass: "civic-object-mast" })}
  <main id="main" class="node-document civic-object-document" data-civic-object-kind="assertion-inspector" data-assertion-target="${esc(view.target.kind)}">
    ${renderNodeBack({ href: view.target.kind === "subject" ? view.target.subject?.href : assertion?.subject?.href, label: "Back to the connected record", currentHref })}
    <header class="node-hero civic-object-hero">
      <p class="node-kicker">Evidence-bearing assertion graph</p>
      <h1>${esc(title)}</h1>
      <p class="node-lede">${esc(`${view.counts.verified_assertions} verified assertions. Follow each connection to its official evidence and related civic objects.`)}</p>
    </header>
    ${renderNodeSection({ heading: view.target.kind === "assertion" ? "Assertion and evidence" : "Verified assertions", headingId: "assertion-evidence", body: evidenceBody, extraClass: "assertion-evidence" })}
    ${relatedAssertions}
    ${relatedObjectsSection}
  </main>
  ${renderNodeFooter({ extraClass: "civic-object-footer" })}
  <script id="civic-object-payload" type="application/json">${payload}</script>
</body>
</html>`;
}
