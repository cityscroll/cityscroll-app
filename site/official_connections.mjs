/**
 * Bounded official decision-trail view model.
 *
 * The committed people snapshot owns the eligible cohort. This adapter makes
 * its event and identity-retention limits explicit, groups exact votes, and
 * composes the existing scope-v0 identity constraint. It does not infer
 * officials from names or describe the surface as a constellation before both
 * standing promotion bars clear.
 */

export const OFFICIAL_EVENT_GATE = Object.freeze({
  minimum_retention_rate: 0.95,
  minimum_distinct_events: 30,
});

const clean = (value, max = 320) =>
  String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const roundedRate = (numerator, denominator) => denominator > 0
  ? Number((numerator / denominator).toFixed(4))
  : null;

function scopeApi(provided) {
  const api = provided || globalThis.CrolScope;
  if (!api) throw new Error("Official connections require the scope-v0 adapter");
  return api;
}

function retainedRow(row) {
  return Boolean(
    clean(row?.person_id || row?.PersonId || row?.VotePersonId)
    && clean(row?.person_name || row?.PersonName || row?.VotePersonName),
  );
}

function auditCounts(receipt) {
  const audit = receipt?.after_live_audit_2026_08_02 || receipt?.after_live_audit || {};
  let eligible = Number(audit.eligible_vote_rows);
  let retained = Number(audit.retained_person_id_rows);
  if (!Number.isFinite(eligible) || !Number.isFinite(retained)) {
    const match = clean(audit.sample, 1_000).match(/(\d+)\s*\/\s*(\d+)\s+vote rows retained/i);
    if (match) {
      retained = Number(match[1]);
      eligible = Number(match[2]);
    }
  }
  const statedRate = Number(audit.person_vote_retention_rate);
  const rate = Number.isFinite(statedRate)
    ? statedRate
    : roundedRate(retained, eligible);
  return {
    eligible_vote_rows: Number.isFinite(eligible) ? eligible : null,
    retained_person_id_rows: Number.isFinite(retained) ? retained : null,
    rate: Number.isFinite(rate) ? rate : null,
    measured_at: clean(receipt?.measured_at) || null,
    sample_event_id: clean(receipt?.audit?.sample_event_id) || null,
    basis: "dated_live_legistar_audit",
  };
}

/** Measure only the declared committed cohort plus the dated independent audit. */
export function measureOfficialCoverage(peopleDoc = {}, retentionReceipt = null) {
  const rows = Array.isArray(peopleDoc?.rows) ? peopleDoc.rows : [];
  const eligibleEventIds = [...new Set(
    (peopleDoc?.source?.event_ids || rows.map((row) => row?.event_id))
      .map((value) => clean(value))
      .filter(Boolean),
  )].sort();
  const retainedEventIds = [...new Set(
    rows.filter(retainedRow).map((row) => clean(row.event_id)).filter(Boolean),
  )].sort();
  const retentionAudit = auditCounts(retentionReceipt);
  const retentionPass = retentionAudit.rate != null
    && retentionAudit.rate >= OFFICIAL_EVENT_GATE.minimum_retention_rate;
  const eventCountPass = retainedEventIds.length >= OFFICIAL_EVENT_GATE.minimum_distinct_events;
  const promoted = retentionPass && eventCountPass;

  return {
    cohort: "materialized_legistar_roll_call_events",
    cohort_definition:
      "Committed meeting-outcomes events that publish at least one named roll-call row in the people-domain snapshot.",
    eligible_event_count: eligibleEventIds.length,
    retained_event_count: retainedEventIds.length,
    event_coverage_rate: roundedRate(retainedEventIds.length, eligibleEventIds.length),
    distinct_matter_count: new Set(rows.map((row) => clean(row?.matter_id)).filter(Boolean)).size,
    distinct_notice_count: new Set(rows.map((row) => clean(row?.request_id)).filter(Boolean)).size,
    observed_person_vote_rows: rows.filter(retainedRow).length,
    retention_audit: retentionAudit,
    vintage: clean(peopleDoc?.retrieved_at) || null,
    gate: {
      minimum_retention_rate: OFFICIAL_EVENT_GATE.minimum_retention_rate,
      minimum_distinct_events: OFFICIAL_EVENT_GATE.minimum_distinct_events,
      retention_pass: retentionPass,
      event_count_pass: eventCountPass,
      promoted,
    },
    reader_label: promoted
      ? "official_decision_constellation"
      : "published_roll_calls_in_this_corpus",
  };
}

function officialDescriptor(personBag = {}) {
  const candidate = clean(personBag.person_id).replace(/^official:/, "");
  const id = /^\d+$/.test(candidate) ? candidate : "";
  return {
    id,
    ref: id ? `entity:official:${encodeURIComponent(id)}` : "",
    name: clean(personBag.person_name) || id,
  };
}

function officialConstraint(personBag, language, providedScopeApi) {
  const { emptyScope, normalizeScope, scopeWithEntity } = scopeApi(providedScopeApi);
  const official = officialDescriptor(personBag);
  if (!official.ref) return normalizeScope(emptyScope(language), { language });
  return scopeWithEntity(emptyScope(language), official.ref);
}

/** Canonical meeting scope for all exact votes linked to this person id. */
export function officialConnectionScopeHash(
  personBag,
  { language = "en", scope: providedScopeApi } = {},
) {
  const official = officialDescriptor(personBag);
  if (!official.ref) return "";
  const { normalizeScope, routeHashFromScope } = scopeApi(providedScopeApi);
  const scoped = officialConstraint(personBag, language, providedScopeApi);
  scoped.facets.domains = ["meetings"];
  scoped.facets.values.connection_relation = "votes_on";
  return routeHashFromScope(normalizeScope(scoped, { language }), { surface: "meetings" });
}

/** Intersect the exact person id with the view that opened the profile. */
export function officialApplyScopeHash(
  personBag,
  currentHash = "#meetings",
  { language = "en", scope: providedScopeApi } = {},
) {
  const official = officialDescriptor(personBag);
  if (!official.ref) return "";
  const { intersectScopes, routeHashFromScope, scopeFromRouteHash } = scopeApi(providedScopeApi);
  const current = scopeFromRouteHash(currentHash, { language });
  const constraint = officialConstraint(personBag, language, providedScopeApi);
  const composed = intersectScopes(current, constraint);
  const surface = current.facets.domains?.[0] || "meetings";
  return routeHashFromScope(composed, { surface });
}

/** Group exact person-id votes into a composable event → matter trail. */
export function buildOfficialConnectionView(
  personBag = {},
  coverage = {},
  { currentHash = "#meetings", language = "en", scope: providedScopeApi } = {},
) {
  scopeApi(providedScopeApi);
  const official = officialDescriptor(personBag);
  const votes = Array.isArray(personBag.votes) ? personBag.votes : [];
  const byEvent = new Map();
  for (const raw of votes) {
    const eventId = clean(raw?.event_id);
    const matterId = clean(raw?.matter_id || raw?.matter_file);
    if (!official.ref || !eventId || !matterId) continue;
    const eventKey = `${eventId}\0${clean(raw?.request_id)}`;
    if (!byEvent.has(eventKey)) {
      byEvent.set(eventKey, {
        event_id: eventId,
        notice_id: clean(raw?.request_id),
        event_date: clean(raw?.event_date).slice(0, 10) || null,
        votes: [],
      });
    }
    byEvent.get(eventKey).votes.push({
      ...raw,
      matter_id: clean(raw.matter_id) || null,
      matter_file: clean(raw.matter_file) || null,
      confidence: "strong",
      relation: "votes_on",
      official_ref: official.ref,
    });
  }
  const events = [...byEvent.values()].sort((left, right) =>
    clean(right.event_date).localeCompare(clean(left.event_date))
    || clean(right.event_id).localeCompare(clean(left.event_id))
  );
  const normalizedCoverage = coverage && typeof coverage === "object" ? coverage : {};

  return {
    official,
    events,
    vote_count: events.reduce((total, event) => total + event.votes.length, 0),
    matter_count: new Set(events.flatMap((event) =>
      event.votes.map((vote) => clean(vote.matter_id || vote.matter_file)).filter(Boolean)
    )).size,
    coverage: normalizedCoverage,
    reader_label: normalizedCoverage.reader_label || "published_roll_calls_in_this_corpus",
    view_all_href: officialConnectionScopeHash(personBag, {
      language,
      scope: providedScopeApi,
    }),
    apply_scope_href: officialApplyScopeHash(personBag, currentHash, {
      language,
      scope: providedScopeApi,
    }),
  };
}

export function renderOfficialCoverageHTML(
  view,
  { translate, escapeHtml } = {},
) {
  const t = typeof translate === "function" ? translate : (key) => key;
  const esc = typeof escapeHtml === "function" ? escapeHtml : (value) => String(value ?? "");
  const coverage = view?.coverage || {};
  const gate = coverage.gate || {};
  const audit = coverage.retention_audit || {};
  if (!coverage.cohort) return "";
  const events = Number(coverage.retained_event_count) || 0;
  const target = Number(gate.minimum_distinct_events) || 30;
  const eventProgress = Math.min(100, Math.round((events / target) * 100));
  const retention = Number(audit.rate);
  const retentionPct = Number.isFinite(retention) ? Math.round(retention * 1000) / 10 : null;
  const retentionMin = Math.round((Number(gate.minimum_retention_rate) || .95) * 100);
  const held = gate.promoted !== true;
  return `<aside class="official-coverage" role="note" data-official-coverage-status="${held ? "hold" : "promoted"}">
    <div class="chain-h">${t("official_coverage_heading")}</div>
    <p><strong>${held ? t("official_coverage_bounded_label") : t("official_coverage_promoted_label")}</strong></p>
    <div class="official-coverage-measure" data-gate="events">
      <span>${t("official_coverage_events", { observed:String(events), required:String(target) })}</span>
      <progress value="${eventProgress}" max="100" aria-label="${esc(t("official_coverage_events_progress"))}">${eventProgress}%</progress>
    </div>
    <div class="official-coverage-measure" data-gate="retention">
      <span>${t("official_coverage_retention", {
        retained:String(audit.retained_person_id_rows ?? "—"),
        eligible:String(audit.eligible_vote_rows ?? "—"),
        rate:retentionPct == null ? "—" : `${retentionPct}%`,
        minimum:String(retentionMin),
      })}</span>
      <progress value="${retentionPct == null ? 0 : Math.min(100, retentionPct)}" max="100" aria-label="${esc(t("official_coverage_retention_progress"))}">${retentionPct ?? 0}%</progress>
    </div>
    <p class="aidprov">${t("official_coverage_basis", {
      retained:String(coverage.retained_event_count ?? 0),
      eligible:String(coverage.eligible_event_count ?? 0),
      matters:String(coverage.distinct_matter_count ?? 0),
    })}</p>
  </aside>`;
}

export function renderOfficialDecisionTrailHTML(
  view,
  { formatDate, escapeHtml, translate, votesTableHTML } = {},
) {
  const events = Array.isArray(view?.events) ? view.events : [];
  if (!events.length || typeof votesTableHTML !== "function") return "";
  const fdate = typeof formatDate === "function" ? formatDate : (value) => String(value ?? "");
  const esc = typeof escapeHtml === "function" ? escapeHtml : (value) => String(value ?? "");
  const t = typeof translate === "function" ? translate : (key) => key;
  return `<div class="official-decision-trail">
    ${events.map((event) => {
      const date = event.event_date ? fdate(event.event_date) : "—";
      const hearing = event.notice_id
        ? `<a class="view" href="#notice/${encodeURIComponent(event.notice_id)}">${t("official_open_hearing")}</a>`
        : "";
      return `<section class="official-event" data-event-id="${esc(event.event_id)}" data-notice-id="${esc(event.notice_id || "")}">
        <div class="chain-h" style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <span>${t("official_event_group_heading", { date:esc(date), id:esc(event.event_id) })}</span>
          ${hearing}
        </div>
        ${votesTableHTML(event.votes, { hideHearing:true })}
      </section>`;
    }).join("")}
  </div>`;
}
