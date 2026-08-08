/**
 * Agency cross-category constellation (first iteration).
 *
 * Parcel biographies group property + land + tax for one BBL. This module does
 * the same shape for one agency across contracts, meetings, rules, and staffing
 * exams — using existing entity-intelligence edges plus publisher exam
 * certification rows. Match methods stay labeled so later graph work can refine
 * coverage without inventing a second ontology.
 */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import {
  AGENCY_OBLIGATIONS_CERTIFICATION,
  AGENCY_OBLIGATIONS_ER_BASIS,
  AGENCY_OBLIGATIONS_METHOD,
  agencyObligationsFollowHref,
  buildAgencyObligationsView,
} from "./agency_obligations.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import { canonicalizeBrowseUrl } from "./route_migration.mjs";
import {
  emptyScope,
  normalizeScope,
  routeHashFromScope,
  scopeWithEntity,
} from "./scope_v0.mjs";
import {
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeActions,
  renderNodeBack,
  renderNodeFooter,
} from "./civic_document_chrome.mjs";

export const AGENCY_CONSTELLATION_SCHEMA = "cityscroll.agency_constellation.v1";
export const AGENCY_CONSTELLATION_METHOD = "agency_constellation_v1";
export const AGENCY_CONSTELLATION_ER_BASIS = "agency_canonical_v1+publisher_certification_record_v1+statute_actor_alias_v1";

/** v1 slice categories — contracts / meetings / rules / obligations / staffing. */
export const AGENCY_CONSTELLATION_CATEGORIES = Object.freeze([
  Object.freeze({
    id: "contracts",
    domain: "money",
    label: "Contracts",
    browse_facet: "contracts",
    surface: "money",
    relation: "published_by_agency",
    empty_note: "No contract or award notices are linked to this agency in the current materialization.",
  }),
  Object.freeze({
    id: "meetings",
    domain: "meetings",
    label: "Meetings and hearings",
    browse_facet: "meetings",
    surface: "meetings",
    relation: "hosts_meeting",
    empty_note: "No meeting or hearing notices are linked to this agency in the current materialization.",
  }),
  Object.freeze({
    id: "rules",
    domain: "rules",
    label: "Rules",
    browse_facet: "rules",
    surface: "rules",
    relation: "issued_rule",
    empty_note: "No Agency Rules notices are linked to this agency in the current materialization.",
  }),
  Object.freeze({
    id: "obligations",
    domain: "rules",
    label: "Statutory obligations",
    browse_facet: "rules",
    surface: "rules",
    relation: "statute_duty",
    empty_note: "No statutory obligations are linked to this agency in the current materialization.",
  }),
  Object.freeze({
    id: "staffing",
    domain: "staffing",
    label: "Staffing exams",
    browse_facet: "staffing",
    surface: "people",
    relation: "certified_to_agency",
    empty_note: "No civil-service certification edges name this agency in the current materialization.",
  }),
]);

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

const publicConfidence = (value) => {
  const confidence = String(value || "").trim().toLowerCase();
  if (confidence === "strong" || confidence === "tentative") return confidence;
  if (confidence === "publisher_record") return "strong";
  return null;
};

export function agencyPath(id) {
  const identity = resolveAgencyIdentity(id);
  return identity?.canonical_id
    ? `/agencies/${encodeURIComponent(identity.canonical_id)}/`
    : "/agencies/";
}

export function agencySubjectRef(id) {
  const identity = resolveAgencyIdentity(id);
  return identity?.canonical_id ? `agency:id:${identity.canonical_id}` : null;
}

/** Compose the shared agency entity constraint (scope grammar). */
export function agencyConstellationScope(id, { language = "en", domain = null } = {}) {
  const identity = resolveAgencyIdentity(id);
  const ref = agencySubjectRef(identity.canonical_id || id);
  let scope = emptyScope(language);
  if (identity.canonical_name) scope.facets.agencies = [identity.canonical_name];
  if (ref) scope = scopeWithEntity(scope, ref);
  if (domain) scope.facets.domains = [domain];
  return normalizeScope(scope, { language });
}

function browseHrefFromScope(scope, browseFacet, surface) {
  const hash = routeHashFromScope(scope, { surface });
  const query = String(hash).includes("?") ? String(hash).split("?", 2)[1] : "";
  return canonicalizeBrowseUrl(`/browse/${browseFacet}/${query ? `?${query}` : ""}`);
}

export function agencyCategoryBrowseHref(id, categoryId, { language = "en" } = {}) {
  const category = AGENCY_CONSTELLATION_CATEGORIES.find((entry) => entry.id === categoryId);
  if (!category) return "";
  const scope = agencyConstellationScope(id, { language, domain: category.surface });
  scope.facets.values.connection_relation = category.relation;
  return browseHrefFromScope(normalizeScope(scope, { language }), category.browse_facet, category.surface);
}

export function agencyCategoryFollowHref(id, categoryId, { frequency = "weekly" } = {}) {
  const category = AGENCY_CONSTELLATION_CATEGORIES.find((entry) => entry.id === categoryId);
  const identity = resolveAgencyIdentity(id);
  const ref = agencySubjectRef(identity.canonical_id || id);
  if (!category || !identity.canonical_name) return "/following/";
  if (category.id === "obligations") {
    // World-state predicate on statutory duties / deadlines — not a City Record document match.
    return agencyObligationsFollowHref(identity.canonical_id || id, { frequency });
  }
  if (category.id === "staffing") {
    // Exam certifications are publisher list edges; entity watches cover City
    // Record staffing notices (Changes in Personnel) for the same agency.
    return followingUrlFromWatch(
      { lens: "entity", filter: { kind: "agency", name: identity.canonical_name } },
      { frequency },
    );
  }
  const filter = { agency: identity.canonical_name };
  if (ref) filter.entity_refs_all = [ref];
  return followingUrlFromWatch({ lens: category.surface, filter }, { frequency });
}

export function agencyConstellationFollowHref(id, { frequency = "weekly" } = {}) {
  const identity = resolveAgencyIdentity(id);
  if (!identity.canonical_name) return "/following/";
  return followingUrlFromWatch(
    { lens: "entity", filter: { kind: "agency", name: identity.canonical_name } },
    { frequency },
  );
}

function domainItems(block, limit = 8) {
  const objects = Array.isArray(block?.objects) ? block.objects : [];
  return objects
    .map((object) => {
      const confidence = publicConfidence(object?.confidence);
      if (!confidence) return null;
      const requestId = clean(object.request_id, 80);
      const subjectRef = clean(object.subject_ref, 120)
        || (requestId ? `notice:${requestId}` : "");
      if (!subjectRef) return null;
      return {
        id: requestId || subjectRef,
        subject_ref: subjectRef,
        label: clean(object.label || subjectRef, 240),
        date: clean(object.when, 40) || null,
        source: clean(object.provenance?.source_system || "City Record", 80),
        relation: clean(object.link_type, 80) || null,
        confidence,
        method: clean(object.method || object.provenance?.basis || "agency_canonical_v1", 80),
        href: clean(object.href, 200) || (requestId ? `#notice/${encodeURIComponent(requestId)}` : null),
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")))
    .slice(0, limit);
}

function staffingItems(certification, agencyRef, limit = 8) {
  const edges = (Array.isArray(certification?.edges) ? certification.edges : [])
    .filter((edge) => edge?.to === agencyRef && edge?.type === "certified_to_agency");
  const titles = new Map(
    (Array.isArray(certification?.by_exam) ? certification.by_exam : [])
      .map((exam) => [String(exam.exam_no || "").trim(), clean(exam.title, 200) || null]),
  );
  return edges
    .map((edge) => {
      const examRef = clean(edge.from, 40);
      const examNo = examRef.replace(/^exam:/, "");
      if (!examNo) return null;
      const through = clean(edge.observed?.through || edge.observed?.from, 40) || null;
      return {
        id: examNo,
        subject_ref: examRef,
        label: titles.get(examNo) || `Exam ${examNo}`,
        date: through,
        source: "Civil Service List certification (Open Data)",
        relation: "certified_to_agency",
        confidence: "strong",
        method: clean(edge.method || "publisher_certification_record_v1", 80),
        href: `/exams/${encodeURIComponent(examNo)}/`,
        counts: edge.counts || null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")))
    .slice(0, limit);
}

function obligationItems(obligationsLookup, identity, limit = 8) {
  const view = buildAgencyObligationsView(identity.canonical_id, obligationsLookup, { limit });
  if (!view || view.status !== "matched") return { total: 0, items: [], view };
  return {
    total: view.count,
    view,
    items: view.items.map((item) => ({
      id: item.obligation_id,
      subject_ref: `obligation:${item.obligation_id}`,
      label: item.duty_text,
      date: item.deadline_date || null,
      source: item.citation || "Enacted local law",
      relation: "statute_duty",
      confidence: item.quote_verified ? "strong" : "tentative",
      method: AGENCY_OBLIGATIONS_METHOD,
      href: item.href,
      deliverable_type: item.deliverable_type,
      recurrence: item.recurrence,
      deadline_text: item.deadline_text,
      certification_status: item.certification_status,
      observation_status: item.observation_status,
      kind: "obligation",
    })),
  };
}

function categoryFromDomain(spec, intelligence, identity, certification, obligationsLookup) {
  if (spec.id === "obligations") {
    const { total, items, view } = obligationItems(obligationsLookup, identity);
    return {
      id: spec.id,
      label: spec.label,
      relation: spec.relation,
      status: items.length || total ? "matched" : "empty",
      gap_class: items.length || total ? null : "empty_in_corpus",
      note: items.length || total ? null : (view?.note || spec.empty_note),
      count: total,
      items,
      method: AGENCY_OBLIGATIONS_METHOD,
      certification_basis: AGENCY_OBLIGATIONS_CERTIFICATION,
      er_match_basis: AGENCY_OBLIGATIONS_ER_BASIS,
      view_all_href: "",
      follow_href: agencyCategoryFollowHref(identity.canonical_id, spec.id),
      honesty: "Deadlines are statutory timed events, not compliance verdicts. Observation is not adjudicated in this iteration.",
    };
  }

  if (spec.id === "staffing") {
    const agencyRef = `agency:id:${identity.canonical_id}`;
    const items = staffingItems(certification, agencyRef);
    const agencyRow = (Array.isArray(certification?.by_agency) ? certification.by_agency : [])
      .find((row) => row.agency_id === identity.canonical_id || row.ref === agencyRef);
    const total = Number(agencyRow?.edge_count) || items.length;
    return {
      id: spec.id,
      label: spec.label,
      relation: spec.relation,
      status: items.length || total ? "matched" : "empty",
      gap_class: items.length || total ? null : "empty_in_corpus",
      note: items.length || total ? null : spec.empty_note,
      count: total,
      items,
      method: "publisher_certification_record_v1",
      view_all_href: agencyCategoryBrowseHref(identity.canonical_id, spec.id),
      follow_href: agencyCategoryFollowHref(identity.canonical_id, spec.id),
    };
  }

  const block = intelligence?.domains?.[spec.domain] || {};
  const items = domainItems(block);
  const matched = block.status === "matched" && (Number(block.count) > 0 || items.length > 0);
  return {
    id: spec.id,
    label: spec.label,
    relation: spec.relation,
    status: matched ? "matched" : (block.status === "not_yet_ingested" ? "not_yet_ingested" : "empty"),
    gap_class: matched ? null : (block.gap_class || "empty_in_corpus"),
    note: matched ? null : (block.note || spec.empty_note),
    count: Number(block.count) || items.length,
    items,
    method: items[0]?.method || "agency_canonical_v1",
    view_all_href: matched ? agencyCategoryBrowseHref(identity.canonical_id, spec.id) : "",
    follow_href: agencyCategoryFollowHref(identity.canonical_id, spec.id),
  };
}

/**
 * Build one agency constellation view from committed materializations.
 * @param {string} idOrName
 * @param {{ intelligence?: object, certification?: object, obligations?: object, generated_at?: string }} sources
 */
export function buildAgencyConstellationView(idOrName, sources = {}) {
  const identity = resolveAgencyIdentity(idOrName);
  if (!identity?.canonical_id) return null;

  const ref = `agency:id:${identity.canonical_id}`;
  const intelligence = sources.intelligence?.by_ref?.[ref]
    || sources.intelligence?.by_subject_ref?.[ref]
    || (sources.intelligence?.root?.ref === ref ? sources.intelligence : null)
    || null;
  const certification = sources.certification || null;
  const obligations = sources.obligations || null;

  const categories = AGENCY_CONSTELLATION_CATEGORIES.map((spec) =>
    categoryFromDomain(spec, intelligence, identity, certification, obligations));

  const matched = categories.filter((category) => category.status === "matched").length;
  return {
    schema: AGENCY_CONSTELLATION_SCHEMA,
    kind: "agency-constellation",
    id: identity.canonical_id,
    path: agencyPath(identity.canonical_id),
    subject_ref: ref,
    display_name: identity.canonical_name,
    canonical_id: identity.canonical_id,
    categories,
    summary: {
      matched_categories: matched,
      category_count: categories.length,
      generated_at: sources.generated_at
        || intelligence?.materialization_meta?.generated_at
        || sources.intelligence?.generated_at
        || certification?.generated_at
        || obligations?.generated_at
        || null,
      er_match_basis: AGENCY_CONSTELLATION_ER_BASIS,
      method: AGENCY_CONSTELLATION_METHOD,
      iteration: "v1",
    },
    follow_href: agencyConstellationFollowHref(identity.canonical_id),
    scope_href: agencyCategoryBrowseHref(identity.canonical_id, "contracts"),
    interactive_profile_href: `/#agency/${encodeURIComponent(identity.canonical_name)}`,
    provenance: {
      intelligence_generated_at: sources.intelligence?.generated_at || null,
      certification_generated_at: certification?.generated_at || null,
      obligations_generated_at: obligations?.generated_at || null,
      methods: [
        "agency_canonical_v1",
        "publisher_certification_record_v1",
        AGENCY_OBLIGATIONS_METHOD,
        AGENCY_CONSTELLATION_METHOD,
      ],
      note: "v1 joins City Record agency identity (entity intelligence), publisher civil-service certification edges, and auto-certified enacted-law statutory obligations. Deadlines are not compliance verdicts. Later graph and process-conformance work may refine coverage; empty categories are honest absences in this materialization.",
    },
  };
}

function itemLink(item) {
  const label = esc(item.label || item.subject_ref || item.id);
  if (!item.href) return label;
  return `<a data-subject-ref="${esc(item.subject_ref || "")}" href="${esc(item.href)}">${label}</a>`;
}

function obligationMeta(item) {
  return [
    item.deliverable_type,
    item.date ? `deadline ${item.date}` : (item.deadline_text ? `deadline: ${item.deadline_text}` : "no computed deadline"),
    item.recurrence,
    item.certification_status === "auto_certified" ? "auto-certified" : "auto-candidate",
    "not adjudicated",
    item.source,
    item.method,
  ].filter(Boolean).join(" · ");
}

function categorySection(category) {
  const status = category.status === "matched"
    ? (category.id === "obligations" ? `${category.count} statutory duties` : `${category.count} linked`)
    : category.status === "not_yet_ingested"
      ? "not yet shown here"
      : "none in this materialization";
  const list = category.items.length
    ? `<ul class="node-record-list">${category.items.map((item) => {
      if (category.id === "obligations" || item.kind === "obligation") {
        const sourceLink = item.href
          ? ` · <a href="${esc(item.href)}" rel="noopener">Source law</a>`
          : "";
        return `<li class="node-record" data-obligation-id="${esc(item.id)}"><div class="node-record-main">${esc(item.label)}</div><span class="muted node-muted">${esc(obligationMeta(item))}${sourceLink}</span></li>`;
      }
      return `<li class="node-record"><div class="node-record-main">${itemLink(item)}</div><span class="muted node-muted">${esc(item.source)}${item.date ? ` · ${esc(item.date)}` : ""} · ${esc(item.method || "")}</span></li>`;
    }).join("")}</ul>`
    : `<p class="node-muted">${esc(category.note || "No linked record is listed for this category.")}</p>`;
  const honesty = category.id === "obligations" && category.honesty
    ? `<p class="node-muted muted">${esc(category.honesty)}</p>`
    : "";
  const followLabel = category.id === "obligations"
    ? "Watch obligations and deadlines"
    : `Follow ${category.label.toLowerCase()}`;
  const actions = [
    category.view_all_href
      ? `<a class="node-action civic-object-action" href="${esc(category.view_all_href)}">Open in ${esc(category.label)}</a>`
      : "",
    category.follow_href
      ? `<a class="node-action civic-object-action" href="${esc(category.follow_href)}">${esc(followLabel)}</a>`
      : "",
  ].filter(Boolean).join("");
  const certAttr = category.certification_basis
    ? ` data-certification-basis="${esc(category.certification_basis)}"`
    : "";
  return `<section class="node-section node-card civic-object-section" data-agency-constellation-category="${esc(category.id)}" data-status="${esc(category.status)}" data-export-class="object_members"${certAttr}>
    <h2>${esc(category.label)} <span class="muted node-muted">(${esc(status)})</span></h2>
    ${honesty}
    ${list}
    ${actions ? `<p class="node-inline-actions civic-object-inline-actions">${actions}</p>` : ""}
  </section>`;
}

/** Static-first civic document for one agency constellation (shared node layout). */
export function renderAgencyConstellationDocument(view, options = {}) {
  if (!view || view.kind !== "agency-constellation") {
    throw new Error("Unknown agency constellation view");
  }
  const title = view.display_name;
  const canonical = `https://cityscroll.org${view.path}`;
  const payload = JSON.stringify(view).replace(/<\/script/gi, "<\\/script");
  const matched = view.summary.matched_categories;
  const lead = matched
    ? `Public records connected with this agency across ${matched} of ${view.summary.category_count} categories (contracts, meetings, rules, statutory obligations, staffing exams). Links keep the agency scope so each category view can reuse it.`
    : "No linked records appear for this agency in the current cross-category materialization. Empty categories stay empty rather than inventing matches.";
  const sections = view.categories.map(categorySection).join("");
  const obligationsFollow = view.categories.find((category) => category.id === "obligations")?.follow_href || "";
  const actions = renderNodeActions([
    { kind: "link", label: "Watch this agency across City Record", href: view.follow_href, primary: true, className: "civic-object-action" },
    obligationsFollow
      ? { kind: "link", label: "Watch obligations and deadlines", href: obligationsFollow, className: "civic-object-action" }
      : null,
    { kind: "button", label: "Copy link", attrs: { "data-object-copy": true }, className: "civic-object-action" },
    { kind: "button", label: "Print / save PDF", attrs: { "data-object-print": true }, className: "civic-object-action" },
    { kind: "button", label: "Download JSON", attrs: { "data-object-export": "json" }, className: "civic-object-action" },
  ].filter(Boolean), {
    ariaLabel: "Document actions",
    exportClass: "object_actions",
    extraClass: "civic-object-actions",
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} · Agency constellation · CityScroll</title>
  <meta name="description" content="${esc(`Cross-category public records for ${title}: contracts, meetings, rules, statutory obligations, and staffing exams.`)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta property="og:url" content="${esc(canonical)}">
  ${renderCivicDocumentAssets(options.assetPrefix || "/")}
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  ${renderCivicDocumentMast({ current: "browse", surfaceClass: "civic-object-mast" })}
  <main id="main" class="node-document civic-object-document" data-civic-object-kind="agency-constellation" data-subject-ref="${esc(view.subject_ref)}" data-er-match-basis="${esc(view.summary.er_match_basis)}" data-node-document="1">
    ${renderNodeBack({ href: "/agencies/", label: "Back to agencies", extraClass: "civic-object-back" })}
    <header class="node-hero civic-object-hero" data-export-class="object_identity">
      <p class="node-kicker civic-object-kicker">Agency constellation · first iteration</p>
      <h1>${esc(title)}</h1>
      <p class="node-lede">${esc(lead)}</p>
      <p class="node-pivot civic-object-pivot">
        <a data-subject-ref="${esc(view.subject_ref)}" href="${esc(view.scope_href)}">Open this agency in Contracts</a>
        · <a href="${esc(view.interactive_profile_href)}">Interactive profile</a>
      </p>
    </header>
    ${actions}
    <section class="node-section civic-object-section" data-export-class="object_members">
      <h2>Records by category</h2>
      <p class="node-muted muted">Match basis for this iteration: <code>${esc(view.summary.er_match_basis)}</code>. Later evidence-graph work can tighten joins without changing this page shape. Statutory obligations use auto-certification with inspectable source-law links; deadlines are not compliance verdicts.</p>
    </section>
    ${sections}
    <section class="node-section civic-object-section" data-export-class="object_provenance">
      <h2>Sources and limits</h2>
      <p>${esc(view.provenance.note)}</p>
      <p class="node-muted muted">Materialization methods: ${esc(view.provenance.methods.join(", "))}. Contracts, meetings, and rules come from the entity-intelligence lookup; staffing exams come from publisher civil-service certification edges; statutory obligations come from independent enacted-law extraction with mechanical quote verification.</p>
    </section>
  </main>
  ${renderNodeFooter({ extraClass: "civic-object-footer" })}
  <script id="civic-object-payload" type="application/json">${payload}</script>
  <script defer src="/export_workflows.js"></script>
  <script type="module">
    const root = document.querySelector("[data-civic-object-kind='agency-constellation']");
    const payload = JSON.parse(document.getElementById("civic-object-payload")?.textContent || "null");
    const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
    root?.querySelector("[data-object-copy]")?.addEventListener("click", async (event) => {
      try { await navigator.clipboard.writeText(canonical); event.currentTarget.textContent = "Copied"; }
      catch { event.currentTarget.textContent = "Copy failed"; }
    });
    root?.querySelector("[data-object-print]")?.addEventListener("click", () => window.print());
    root?.querySelector('[data-object-export="json"]')?.addEventListener("click", () => {
      window.CrolExports?.downloadFile(
        \`cityscroll-agency-constellation-\${payload.id}.json\`,
        JSON.stringify({ ...payload, canonical_url: canonical }, null, 2),
        "application/json",
      );
    });
  </script>
</body>
</html>`;
}
