/**
 * Browser runtime for Civic Time Ledger as-of view on agency documents.
 * The initial document carries identity and controls. Relationship/list HTML
 * and the full as-of view are loaded from the route-local deferred artifact;
 * this module keeps the URL shareable while applying ?as_of=YYYY-MM-DD to the
 * same view once it arrives.
 */
import {
  AS_OF_QUERY_KEY,
  asOfFilterCanNarrow,
  buildLedgerSummary,
  normalizeAsOfDay,
  parseAsOfFromSearch,
  projectAgencyConstellationAsOf,
  renderCivicTimeLedgerPanel,
} from "./civic_time_ledger.mjs";
import {
  mountEdgeProvenanceClient,
  renderWhyBelieveControl,
  sourceSystemReaderLabel,
} from "./graph_edge_provenance.mjs";
import { officialSourceLink } from "./affordance_grammar.mjs";
import { runtimeRumSemanticMilestones } from "./rum_static_record_instrumentation.mjs";
import {
  agencyIdentityReady,
  agencyRelationshipsOutcomeFromView,
  agencyRelationshipsReady,
} from "./rum_maps_entities_async_instrumentation.mjs";

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function itemLink(item) {
  const label = esc(item.label || item.subject_ref || item.id);
  if (!item.href) return label;
  return `<a data-subject-ref="${esc(item.subject_ref || "")}" href="${esc(item.href)}">${label}</a>`;
}

function publicProvenanceLabel(value) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const key = raw.toLowerCase().replace(/\s+/g, "_");
  const known = {
    agency_canonical_v1: "agency identity",
    publisher_certification_record_v1: "publisher certification",
    agency_constellation_v1: "agency constellation",
    city_record: "City Record",
    warehouse: "warehouse",
    enacted_local_law: "enacted local law",
  };
  if (known[key]) return known[key];
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(raw)) {
    return raw.replace(/_/g, " ").replace(/\bv\d+\b/g, "").replace(/\s+/g, " ").trim();
  }
  return raw;
}

function currentClaimId() {
  try {
    return new URLSearchParams(location.search).get("claim") || null;
  } catch {
    return null;
  }
}

/** Share path preserving claim + as_of (and no other params). */
function sharePath(basePath, { asOf = null, claim = null } = {}) {
  const base = String(basePath || "/");
  const params = new URLSearchParams();
  const day = normalizeAsOfDay(asOf);
  const claimId = claim ? String(claim).trim() : "";
  if (day) params.set(AS_OF_QUERY_KEY, day);
  if (claimId) params.set("claim", claimId);
  const query = params.toString();
  if (!query) return base.split("?")[0];
  const pathOnly = base.split("?")[0];
  return `${pathOnly}?${query}`;
}

function categorySectionHtml(category) {
  // Omit empty categories — same show-only-when-present rule as node pages.
  if (!category?.items?.length || category.status === "empty" || category.status === "not_yet_ingested") {
    return "";
  }
  const status = category.id === "obligations"
    ? `${category.count} statutory duties`
    : `${category.count} linked`;
  const list = `<ul class="node-record-list">${category.items.map((item) => {
    const warrant = item.claim?.how?.warrant_class || "";
    const why = item.claim ? renderWhyBelieveControl(item.claim) : "";
    if (category.id === "obligations" || item.kind === "obligation") {
      const sourceLink = item.href
        ? ` · ${officialSourceLink({ href: item.href, label: "Source law", className: "agency-source-link", escape: esc })}`
        : "";
      const meta = [
        item.deliverable_type,
        item.date ? `deadline ${item.date}` : (item.deadline_text ? `deadline: ${item.deadline_text}` : null),
        item.recurrence,
        publicProvenanceLabel(item.source) || item.source,
      ].filter(Boolean).join(" · ");
      return `<li class="node-record" data-obligation-id="${esc(item.id)}" data-edge-claim-row="${esc(item.claim?.claim_id || item.subject_ref || item.id)}" data-warrant-class="${esc(warrant)}">
        <div class="node-record-main">${esc(item.label)}${why ? ` ${why}` : ""}</div>
        <span class="muted node-muted">${esc(meta)}${sourceLink}</span>
      </li>`;
    }
    const clocks = item.temporal;
    const bits = [
      sourceSystemReaderLabel(item.source) || publicProvenanceLabel(item.source) || item.source,
      clocks?.valid_day || item.date || "",
    ].filter(Boolean);
    return `<li class="node-record" data-edge-claim-row="${esc(item.claim?.claim_id || item.subject_ref || item.id)}" data-warrant-class="${esc(warrant)}">
      <div class="node-record-main">${itemLink(item)}${why ? ` ${why}` : ""}</div>
      ${bits.length ? `<span class="muted node-muted">${esc(bits.join(" · "))}</span>` : ""}
    </li>`;
  }).join("")}</ul>`;
  const honesty = category.id === "obligations" && category.honesty
    ? `<p class="node-muted muted">${esc(category.honesty)}</p>`
    : "";
  const followLabel = category.id === "obligations"
    ? "Watch mandates and deadlines"
    : `Follow ${category.label.toLowerCase()}`;
  const actions = [
    category.view_all_href
      ? `<a class="node-action civic-object-action" href="${esc(category.view_all_href)}">Open in ${esc(category.label)}</a>`
      : "",
    category.follow_href
      ? `<a class="node-action civic-object-action" href="${esc(category.follow_href)}">${esc(followLabel)}</a>`
      : "",
  ].filter(Boolean).join("");
  return `<section class="node-section node-card civic-object-section" data-agency-constellation-category="${esc(category.id)}" data-status="${esc(category.status)}" data-export-class="object_members">
    <h2>${esc(category.label)} <span class="muted node-muted">(${esc(status)})</span></h2>
    ${honesty}
    ${list}
    ${actions ? `<p class="node-inline-actions civic-object-inline-actions">${actions}</p>` : ""}
  </section>`;
}

function replaceCategorySections(root, categories) {
  const sections = [...root.querySelectorAll("[data-agency-constellation-category]")];
  const host = sections[0]?.parentElement || root.querySelector("main") || root;
  if (!host) return;
  const html = categories.map(categorySectionHtml).filter(Boolean).join("");
  for (const section of sections) section.remove();
  const ledger = host.querySelector("[data-civic-time-ledger]");
  if (ledger) ledger.insertAdjacentHTML("afterend", html);
  else {
    const provenance = host.querySelector("[data-edge-provenance-panel], #edge-provenance");
    if (provenance) provenance.insertAdjacentHTML("beforebegin", html);
    else host.insertAdjacentHTML("beforeend", html);
  }
}

function updateHero(root, nowView, asOfView, day) {
  if (nowView.kind !== "agency-constellation") return;
  const kicker = root.querySelector(".node-kicker, .civic-object-kicker");
  const lede = root.querySelector(".node-lede");
  if (day && asOfView) {
    if (kicker) {
      kicker.textContent = `Agency constellation · as of ${day}`;
    }
    if (lede) {
      const matched = asOfView.summary?.matched_categories ?? 0;
      const total = asOfView.summary?.category_count ?? nowView.summary?.category_count ?? 0;
      lede.textContent = matched
        ? `Records dated on or before ${day} · ${matched} of ${total} categories.`
        : `No linked records dated on or before ${day}.`;
    }
  } else {
    if (kicker) kicker.textContent = "Agency constellation";
    if (lede) {
      const matched = nowView.summary?.matched_categories ?? 0;
      const total = nowView.summary?.category_count ?? 0;
      lede.textContent = matched
        ? `Public records connected with this agency across ${matched} of ${total} categories.`
        : "Public records for this agency appear here when contracts, meetings, rules, mandates, or staffing exams join to its published identity.";
    }
  }
}

function updateLedgerPanel(root, nowView, asOfView, day, useful) {
  const existing = root.querySelector("[data-civic-time-ledger]");
  if (!useful) {
    if (existing) existing.remove();
    return;
  }
  const summary = day && asOfView
    ? buildLedgerSummary(nowView, asOfView)
    : null;
  const html = renderCivicTimeLedgerPanel({
    path: nowView.path,
    asOfDay: day,
    summary,
    subjectLabel: nowView.kind === "parcel" ? "this parcel’s linked records" : "agency’s linked records",
  });
  if (existing) existing.outerHTML = html;
  else {
    const actions = root.querySelector(".node-actions, .civic-object-actions");
    if (actions) actions.insertAdjacentHTML("afterend", html);
    else {
      const hero = root.querySelector(".node-hero, .civic-object-hero");
      if (hero) hero.insertAdjacentHTML("afterend", html);
    }
  }
}

function wireForm(root, nowView) {
  const form = root.querySelector("[data-ctl-form]");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = form.querySelector("[data-ctl-as-of]");
    const day = normalizeAsOfDay(input?.value);
    const next = sharePath(nowView.path, { asOf: day, claim: currentClaimId() });
    if (`${location.pathname}${location.search}` === next) {
      applyAsOf(root, nowView, day);
      return;
    }
    history.pushState({ as_of: day }, "", next);
    applyAsOf(root, nowView, day);
  });
  root.querySelector("[data-ctl-clear]")?.addEventListener("click", (event) => {
    event.preventDefault();
    const next = sharePath(nowView.path, { asOf: null, claim: currentClaimId() });
    history.pushState({ as_of: null }, "", next);
    applyAsOf(root, nowView, null);
  });
}

function shareableUrl() {
  return location.href;
}

function wireCopy(root) {
  root.querySelector("[data-object-copy]")?.addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(shareableUrl());
      event.currentTarget.textContent = "Copied";
    } catch {
      event.currentTarget.textContent = "Copy failed";
    }
  });
}

function applyAsOf(root, nowView, day) {
  const useful = asOfFilterCanNarrow(nowView);
  const asOf = useful ? normalizeAsOfDay(day) : null;
  const asOfView = asOf
    ? projectAgencyConstellationAsOf(nowView, asOf, { axis: "valid" })
    : null;
  updateHero(root, nowView, asOfView, asOf);
  updateLedgerPanel(root, nowView, asOfView, asOf, useful);
  // Static HTML already embeds the full process-conformance mandates surface.
  // Only rewrite category sections when an as-of filter changes membership —
  // re-rendering "now" from the JSON payload would drop #mandates-conformance.
  if (asOfView && nowView.kind === "agency-constellation") {
    replaceCategorySections(root, asOfView.categories);
  } else if (root.dataset.asOf) {
    // Clearing as-of: hard-navigate so the static document (with process-
    // conformance HTML) is restored, not a stripped JSON re-render.
    const path = sharePath(nowView.path, { asOf: null, claim: currentClaimId() });
    if (`${location.pathname}${location.search}` !== path) {
      location.assign(path);
      return;
    }
  }
  root.dataset.asOf = asOf || "";
  root.dataset.ctlUseful = useful ? "1" : "0";
  const canonical = root.ownerDocument.querySelector('link[rel="canonical"]');
  if (canonical) {
    const origin = location.origin || "https://cityscroll.org";
    const path = sharePath(nowView.path, { asOf, claim: currentClaimId() });
    canonical.setAttribute("href", `${origin}${path}`);
  }
  wireForm(root, nowView);
}

function hasAgencyPrimaryIdentity(main) {
  return main?.dataset.civicObjectKind === "agency-constellation"
    && Boolean(main.querySelector(".agency-constellation-hero h1")?.textContent?.trim());
}

/**
 * The civic-object marker is the primary document boundary. Relationship
 * hydration has its own deferred state and must not hold this marker open.
 */
function markAgencyPrimaryReady(main) {
  if (!hasAgencyPrimaryIdentity(main)) return false;
  main.dataset.civicObjectSettled = "true";
  return true;
}

function reportAgencyDocumentReadiness(main, view, { relationshipsState } = {}) {
  if (main?.dataset.civicObjectKind !== "agency-constellation") return;
  const rum = runtimeRumSemanticMilestones();
  agencyIdentityReady(rum, {
    kind: "agency-constellation",
    hasIdentityHeading: hasAgencyPrimaryIdentity(main),
  });
  if (relationshipsState || view) {
    agencyRelationshipsReady(rum, {
      resultState: relationshipsState || agencyRelationshipsOutcomeFromView(view) || "unavailable",
    });
  }
}

async function loadAgencyView(href) {
  const response = await fetch(new URL(href, document.baseURI), { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`agency-relationships-data-response-${response.status}`);
  const payload = await response.json();
  if (payload?.schema !== "cityscroll.agency_relationships_data.v1" || !payload.view) {
    throw new Error("agency-relationships-data-payload-invalid");
  }
  return payload.view;
}

function wireAgencyDocument(main, nowView, { viewHref = null } = {}) {
  mountEdgeProvenanceClient(main.ownerDocument || document);
  const initial = parseAsOfFromSearch(location.search);
  if (!nowView) {
    const loader = main.__civicAgencyViewLoader || (() => loadAgencyView(viewHref || main.dataset.civicObjectViewHref));
    main.__civicAgencyViewLoader = loader;
    const form = main.querySelector("[data-ctl-form]");
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const view = await loader();
      wireAgencyDocument(main, view);
      applyAsOf(main, view, parseAsOfFromSearch(location.search));
    }, { once: true });
    main.querySelector('[data-object-export="json"]')?.addEventListener("click", async (event) => {
      event.preventDefault();
      const view = await loader();
      wireAgencyDocument(main, view);
      main.querySelector('[data-object-export="json"]')?.click();
    }, { once: true });
    if (initial) {
      void loader().then((view) => {
        wireAgencyDocument(main, view);
        applyAsOf(main, view, initial);
      });
    }
    return;
  }
  applyAsOf(main, nowView, initial);
  const displayView = asOfFilterCanNarrow(nowView)
    ? (normalizeAsOfDay(initial)
      ? projectAgencyConstellationAsOf(nowView, normalizeAsOfDay(initial), { axis: "valid" })
      : nowView)
    : nowView;
  reportAgencyDocumentReadiness(main, displayView);
  wireCopy(main);

  main.querySelector("[data-object-print]")?.addEventListener("click", () => window.print());
  main.querySelector('[data-object-export="json"]')?.addEventListener("click", () => {
    const day = asOfFilterCanNarrow(nowView) ? normalizeAsOfDay(main.dataset.asOf) : null;
    const payload = day
      ? projectAgencyConstellationAsOf(nowView, day, { axis: "valid" })
      : nowView;
    window.CrolExports?.downloadFile(
      `cityscroll-agency-constellation-${payload.id}${day ? `-as-of-${day}` : ""}.json`,
      JSON.stringify({ ...payload, canonical_url: shareableUrl() }, null, 2),
      "application/json",
    );
  });

  window.addEventListener("popstate", () => {
    applyAsOf(main, nowView, parseAsOfFromSearch(location.search));
  });
}

async function hydrateAgencyRelationships(main, href) {
  const host = main.querySelector("[data-civic-object-deferred]");
  try {
    const response = await fetch(href, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`agency-relationships-response-${response.status}`);
    const payload = await response.json();
    if (payload?.schema !== "cityscroll.agency_relationships.v1"
      || typeof payload.html !== "string") {
      throw new Error("agency-relationships-payload-invalid");
    }
    if (host) {
      const initialLedger = main.querySelector("[data-civic-time-ledger]");
      host.insertAdjacentHTML("beforebegin", payload.html);
      host.remove();
      const ledgerSlot = main.querySelector("[data-civic-time-ledger-slot]");
      if (ledgerSlot) {
        if (initialLedger) ledgerSlot.replaceWith(initialLedger);
        else ledgerSlot.remove();
      }
    }
    main.dataset.civicObjectDeferredState = "ready";
    const nowView = payload.view || null;
    wireAgencyDocument(main, nowView, { viewHref: payload.view_href || main.dataset.civicObjectViewHref });
    return { nowView, state: "ready" };
  } catch (error) {
    if (host) {
      host.textContent = "Public relationships are temporarily unavailable.";
      host.dataset.civicObjectDeferredState = "error";
    }
    main.dataset.civicObjectDeferredState = "error";
    reportAgencyDocumentReadiness(main, null, { relationshipsState: "error" });
    return { nowView: null, state: "error", error };
  }
}

export function mountAgencyCivicTimeLedger(root = document) {
  const main = root.querySelector?.("[data-civic-object-kind='agency-constellation'], [data-civic-object-kind='parcel']")
    || (root.matches?.("[data-civic-object-kind='agency-constellation'], [data-civic-object-kind='parcel']") ? root : null);
  if (!main) return null;
  reportAgencyDocumentReadiness(main, null);
  markAgencyPrimaryReady(main);
  const payloadEl = root.getElementById?.("civic-object-payload")
    || document.getElementById("civic-object-payload");
  if (payloadEl) {
    try {
      const nowView = JSON.parse(payloadEl.textContent || "null");
      if (!nowView || !["agency-constellation", "parcel"].includes(nowView.kind)) return null;
      main.dataset.civicObjectDeferredState = "ready";
      if (main.dataset.civicObjectKind !== "agency-constellation") {
        main.dataset.civicObjectSettled = "true";
      }
      wireAgencyDocument(main, nowView);
      return { nowView, asOf: parseAsOfFromSearch(location.search) };
    } catch {
      main.dataset.civicObjectDeferredState = "error";
      if (main.dataset.civicObjectKind !== "agency-constellation") {
        main.dataset.civicObjectSettled = "true";
      }
      reportAgencyDocumentReadiness(main, null, { relationshipsState: "error" });
      return null;
    }
  }
  const href = main.dataset.civicObjectDeferredHref;
  if (!href) {
    main.dataset.civicObjectDeferredState = "unavailable";
    if (main.dataset.civicObjectKind !== "agency-constellation") {
      main.dataset.civicObjectSettled = "true";
    }
    reportAgencyDocumentReadiness(main, null, { relationshipsState: "unavailable" });
    return null;
  }
  void hydrateAgencyRelationships(main, new URL(href, document.baseURI).href);
  return { deferred: true, asOf: parseAsOfFromSearch(location.search) };
}

// Auto-mount on agency constellation documents.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mountAgencyCivicTimeLedger(document), { once: true });
  } else {
    mountAgencyCivicTimeLedger(document);
  }
}
