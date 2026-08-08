/**
 * Browser runtime for Civic Time Ledger as-of view on agency documents.
 * Static HTML already embeds the full constellation payload; this module
 * re-filters categories when ?as_of=YYYY-MM-DD is present and keeps the URL
 * shareable without inventing system-time history. Claim (?claim=) is preserved
 * alongside as_of so the edge provenance inspector stays deep-linkable.
 */
import {
  AS_OF_QUERY_KEY,
  asOfHref,
  buildLedgerSummary,
  normalizeAsOfDay,
  parseAsOfFromSearch,
  projectAgencyConstellationAsOf,
  renderCivicTimeLedgerPanel,
} from "./civic_time_ledger.mjs";
import {
  renderWhyBelieveControl,
  sourceSystemReaderLabel,
} from "./graph_edge_provenance.mjs";

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
  // Omit empty categories — same show-only-when-present rule as #684 node pages.
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
        ? ` · <a href="${esc(item.href)}" rel="noopener">Source law</a>`
        : "";
      const meta = [
        item.deliverable_type,
        item.date ? `deadline ${item.date}` : (item.deadline_text ? `deadline: ${item.deadline_text}` : null),
        item.recurrence,
        item.certification_status === "auto_certified" ? "auto-certified" : null,
        publicProvenanceLabel(item.source) || item.source,
        item.claim?.how?.warrant_label || null,
      ].filter(Boolean).join(" · ");
      return `<li class="node-record" data-obligation-id="${esc(item.id)}" data-edge-claim-row="${esc(item.claim?.claim_id || item.subject_ref || item.id)}" data-warrant-class="${esc(warrant)}">
        <div class="node-record-main">${esc(item.label)}</div>
        <span class="muted node-muted">${esc(meta)}${sourceLink}</span>
        ${why ? `<div class="node-record-why">${why}</div>` : ""}
      </li>`;
    }
    const clocks = item.temporal;
    const bits = [
      sourceSystemReaderLabel(item.source) || publicProvenanceLabel(item.source) || item.source,
      clocks?.valid_day
        ? `valid/publication ${clocks.valid_day}`
        : clocks?.system_day
          ? `system ${clocks.system_day}`
          : item.date || "",
      item.claim?.how?.warrant_label || null,
    ].filter(Boolean);
    return `<li class="node-record" data-edge-claim-row="${esc(item.claim?.claim_id || item.subject_ref || item.id)}" data-warrant-class="${esc(warrant)}">
      <div class="node-record-main">${itemLink(item)}</div>
      ${bits.length ? `<span class="muted node-muted">${esc(bits.join(" · "))}</span>` : ""}
      ${why ? `<div class="node-record-why">${why}</div>` : ""}
    </li>`;
  }).join("")}</ul>`;
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
  const kicker = root.querySelector(".node-kicker, .civic-object-kicker");
  const lede = root.querySelector(".node-lede");
  if (day && asOfView) {
    if (kicker) {
      kicker.textContent = `Agency constellation · as of ${day} (valid / publication)`;
    }
    if (lede) {
      const matched = asOfView.summary?.matched_categories ?? 0;
      const total = asOfView.summary?.category_count ?? nowView.summary?.category_count ?? 0;
      lede.textContent = matched
        ? `As of ${day}, this as-of view keeps linked records whose publisher or event date is on or before that day (${matched} of ${total} categories still show links). System-time history of the composed graph is not retained in this iteration. Open “Why do we believe this?” on any connection for its source and warrant class.`
        : `As of ${day}, no linked record in this sample has a publisher or event date on or before that day. Public records appear here when joins carry a date on or before the chosen day.`;
    }
  } else {
    if (kicker) kicker.textContent = "Agency constellation";
    if (lede) {
      const matched = nowView.summary?.matched_categories ?? 0;
      const total = nowView.summary?.category_count ?? 0;
      lede.textContent = matched
        ? `Public records connected with this agency across ${matched} of ${total} categories (contracts, meetings, rules, statutory obligations, staffing exams). Open “Why do we believe this?” on any connection for its source and warrant class.`
        : "Public records for this agency appear here when contracts, meetings, rules, statutory obligations, or staffing exams join to its published identity.";
    }
  }
}

function updateLedgerPanel(root, nowView, asOfView, day) {
  const existing = root.querySelector("[data-civic-time-ledger]");
  const summary = day && asOfView
    ? buildLedgerSummary(nowView, asOfView)
    : null;
  const html = renderCivicTimeLedgerPanel({
    path: nowView.path,
    asOfDay: day,
    summary,
    materializationVintage: dayStampFromView(nowView),
    systemTimeStatus: asOfView?.as_of?.system_time_status || "current_snapshot_only",
  });
  if (existing) existing.outerHTML = html;
}

function dayStampFromView(view) {
  const raw = view.summary?.generated_at
    || view.provenance?.intelligence_generated_at
    || view.provenance?.certification_generated_at
    || view.provenance?.obligations_generated_at
    || null;
  if (!raw) return null;
  const match = String(raw).match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
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
  const asOf = normalizeAsOfDay(day);
  const asOfView = asOf
    ? projectAgencyConstellationAsOf(nowView, asOf, { axis: "valid" })
    : null;
  updateHero(root, nowView, asOfView, asOf);
  updateLedgerPanel(root, nowView, asOfView, asOf);
  replaceCategorySections(root, asOfView ? asOfView.categories : nowView.categories);
  root.dataset.asOf = asOf || "";
  const canonical = root.ownerDocument.querySelector('link[rel="canonical"]');
  if (canonical) {
    const origin = location.origin || "https://cityscroll.org";
    const path = sharePath(nowView.path, { asOf, claim: currentClaimId() });
    canonical.setAttribute("href", `${origin}${path}`);
  }
  wireForm(root, nowView);
}

export function mountAgencyCivicTimeLedger(root = document) {
  const main = root.querySelector?.("[data-civic-object-kind='agency-constellation']")
    || (root.matches?.("[data-civic-object-kind='agency-constellation']") ? root : null);
  if (!main) return null;
  const payloadEl = root.getElementById?.("civic-object-payload")
    || document.getElementById("civic-object-payload");
  if (!payloadEl) return null;
  let nowView;
  try {
    nowView = JSON.parse(payloadEl.textContent || "null");
  } catch {
    return null;
  }
  if (!nowView || nowView.kind !== "agency-constellation") return null;

  const initial = parseAsOfFromSearch(location.search);
  applyAsOf(main, nowView, initial);
  wireCopy(main);

  main.querySelector("[data-object-print]")?.addEventListener("click", () => window.print());
  main.querySelector('[data-object-export="json"]')?.addEventListener("click", () => {
    const day = normalizeAsOfDay(main.dataset.asOf);
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

  return { nowView, asOf: initial };
}

// Auto-mount on agency constellation documents.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mountAgencyCivicTimeLedger(document), { once: true });
  } else {
    mountAgencyCivicTimeLedger(document);
  }
}
