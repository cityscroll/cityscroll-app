import { propertyReaderActionsFromTimedEvents } from "./property_reader_actions.mjs";
import { landProjectDisplayTitle, noticeDisplayTitle } from "./display_title.mjs";

export const NOW_SURFACE_SCHEMA_VERSION = 1;
export const NOW_ACTION_HORIZON_DAYS = 30;
export const NOW_EVENT_HORIZON_DAYS = 30;
export const NOW_LANE_LIMIT = 16;

const DAY_MS = 86_400_000;
const DOMAINS = Object.freeze(["money", "staffing", "rules", "property", "meetings", "land"]);
const SOURCE_META = Object.freeze({
  money: { label: "City Record · Procurement", system: "city_record" },
  staffing: { label: "DCAS exam schedules", system: "dcas" },
  rules: { label: "NYC Rules + City Record", system: "nyc_rules_city_record" },
  property: { label: "City Record · Property Disposition", system: "city_record" },
  meetings: { label: "City Record · Hearings and Meetings", system: "city_record" },
  land: { label: "ZAP", system: "zap" },
});

function isoDay(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function dayNumber(value) {
  const day = isoDay(value);
  if (!day) return null;
  const parsed = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function daysFrom(today, value) {
  const start = dayNumber(today);
  const end = dayNumber(value);
  return start == null || end == null ? null : Math.round((end - start) / DAY_MS);
}

function withinHorizon(today, value, horizonDays) {
  const days = daysFrom(today, value);
  return days != null && days >= 0 && days <= horizonDays;
}

function source(domain) {
  return { domain, ...SOURCE_META[domain] };
}

function time(value, { basis, verified = true, precision = "day", sourceField = null, evidence = null } = {}) {
  return {
    value: value || null,
    day: isoDay(value),
    precision,
    basis,
    verified: verified === true,
    source_field: sourceField,
    evidence: evidence || null,
  };
}

function officialNoticeRoute(requestId) {
  return requestId ? `/notices/${encodeURIComponent(requestId)}` : null;
}

function placeFrom(value) {
  const area = value || {};
  const boroughs = Array.isArray(area.boroughs)
    ? area.boroughs.filter(Boolean)
    : area.borough ? [area.borough] : [];
  return {
    scope: area.scope || (boroughs.length ? "local" : "unlocated"),
    boroughs: [...new Set(boroughs)],
    community_districts: Array.isArray(area.community_districts) ? area.community_districts.filter(Boolean) : [],
    council_districts: Array.isArray(area.council_districts) ? area.council_districts.filter(Boolean) : [],
  };
}

function actionDestination(action, route) {
  return action?.delivery === "official_handoff" && action.destination
    ? action.destination
    : route;
}

function activePrimaryAction(actions) {
  const activeTypes = new Set(["official_application", "bid_checklist", "comment", "contact"]);
  return (actions || []).find((action) => action?.delivery !== "unavailable" && activeTypes.has(action.type)) || null;
}

function compileMatterAction(matter, today, compileActionRail) {
  if (typeof compileActionRail !== "function") return null;
  return activePrimaryAction(compileActionRail(matter, { today }));
}

function moneyActions(payload, options) {
  const rows = payload?.notices || [];
  const out = [];
  for (const row of rows) {
    const rolling = row.rolling_deadline === true;
    const deadline = rolling ? null : row.due_date || null;
    if (deadline && !withinHorizon(options.today, deadline, options.actionHorizonDays)) continue;
    const route = officialNoticeRoute(row.request_id);
    if (!route) continue;
    const matter = {
      kind: "solicitation",
      request_id: row.request_id,
      title: row.short_title,
      agency_name: row.agency_name,
      type_of_notice_description: "Solicitation",
      lifecycle_stage: "open",
      deadline,
      rolling_deadline: rolling,
      selection_method: row.selection_method_description || null,
      official_notice_url: `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(row.request_id)}`,
    };
    const action = compileMatterAction(matter, options.today, options.compileActionRail);
    if (!action) continue;
    out.push({
      id: `money:${row.request_id}`,
      lane: "act_by",
      kind: "bid",
      title: row.short_title || "Untitled solicitation",
      agency: row.agency_name || null,
      domain: "money",
      source: source("money"),
      route,
      action: { ...action, destination: actionDestination(action, route) },
      time: time(deadline, {
        basis: rolling ? "published_open_window" : "published_deadline",
        verified: !rolling,
        sourceField: rolling ? "rolling_deadline" : "due_date",
      }),
      place: placeFrom(row.affected_area),
    });
  }
  return out;
}

function staffingActions(payload, options) {
  const out = [];
  for (const exam of payload?.exams || []) {
    const start = isoDay(exam.application_start);
    const deadline = isoDay(exam.application_end);
    if (!start || !deadline || start > options.today || !withinHorizon(options.today, deadline, options.actionHorizonDays)) continue;
    const route = exam.exam_number ? `/#exam/${encodeURIComponent(exam.exam_number)}` : null;
    if (!route) continue;
    const matter = {
      kind: "exam",
      exam_number: exam.exam_number,
      title: exam.title,
      lifecycle_stage: "open",
      deadline,
      official_application_url: exam.official_application_url,
      official_notice_url: exam.notice_url || exam.official_application_url,
    };
    const action = compileMatterAction(matter, options.today, options.compileActionRail);
    if (!action) continue;
    out.push({
      id: `staffing:${exam.exam_number}`,
      lane: "act_by",
      kind: "apply",
      title: exam.title || `Exam ${exam.exam_number}`,
      agency: "Department of Citywide Administrative Services",
      domain: "staffing",
      source: source("staffing"),
      route,
      action: { ...action, destination: actionDestination(action, route) },
      time: time(deadline, { basis: "published_application_window", sourceField: "application_end" }),
      place: placeFrom(null),
    });
  }
  return out;
}

function rulesActions(payload, options) {
  const out = [];
  for (const record of payload?.rules || []) {
    const rule = record.nyc_rules || {};
    const deadline = rule.comment_by_date || null;
    if (record.stage !== "comment-open" || !withinHorizon(options.today, deadline, options.actionHorizonDays)) continue;
    const route = officialNoticeRoute(record.request_id);
    if (!route) continue;
    const matter = {
      kind: "rule",
      request_id: record.request_id,
      title: record.title,
      agency_name: record.agency,
      lifecycle_stage: record.stage,
      deadline,
      comment_by_date: deadline,
      hearing_date: rule.hearing_date || null,
      comment_url: rule.comment_url || rule.url || null,
      official_notice_url: rule.url || `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(record.request_id)}`,
      summary: rule.summary || null,
    };
    const action = compileMatterAction(matter, options.today, options.compileActionRail);
    if (!action || !["comment", "bid_checklist"].includes(action.type)) continue;
    const event = (record.events || []).find((candidate) => candidate.event_type === "comment_close" && isoDay(candidate.valid_at) === isoDay(deadline));
    out.push({
      id: `rules:${record.request_id}:comment`,
      lane: "act_by",
      kind: "comment",
      title: record.title || rule.title || "Untitled rule",
      agency: record.agency || rule.agency_name || null,
      domain: "rules",
      source: source("rules"),
      route,
      action: { ...action, destination: actionDestination(action, route) },
      time: time(deadline, {
        basis: "published_comment_deadline",
        sourceField: event?.source_field || "comment_by_date",
      }),
      place: placeFrom(record.affected_area),
    });
  }
  return out;
}

function propertyActions(payload, options) {
  const out = [];
  for (const row of payload?.properties || []) {
    const events = row?.commercial?.timed_events || [];
    for (const event of events) {
      const deadline = event.deadline || event.end || null;
      if (!deadline || !withinHorizon(options.today, deadline, options.actionHorizonDays)) continue;
      const readerActions = propertyReaderActionsFromTimedEvents(row, { today: options.today, events: [event] });
      if (!readerActions.actionable.length || !readerActions.rail) continue;
      const route = officialNoticeRoute(row.request_id);
      if (!route) continue;
      const matter = {
        kind: "property",
        request_id: row.request_id,
        title: row.short_title,
        agency_name: row.agency_name,
        section_name: "Property Disposition",
        disposition_stage: row.disposition_stage || null,
        lifecycle_stage: row.disposition_stage || null,
        deadline,
        official_notice_url: `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(row.request_id)}`,
        reader_actions: readerActions,
      };
      const action = compileMatterAction(matter, options.today, options.compileActionRail);
      if (!action) continue;
      const eventKind = String(event.kind || "deadline");
      const verified = event.date_source !== "derived_from_relative_rule" && event.confidence !== "low";
      out.push({
        id: `property:${row.request_id}:${eventKind}:${isoDay(deadline)}`,
        lane: "act_by",
        kind: readerActions.actionable[0].kind,
        title: row.short_title || "Untitled property notice",
        agency: row.agency_name || null,
        domain: "property",
        source: source("property"),
        route,
        action: { ...action, destination: actionDestination(action, route) },
        time: time(deadline, {
          basis: verified ? "typed_event_literal" : "typed_event_derived",
          verified,
          precision: String(deadline).includes("T") ? "instant" : "day",
          sourceField: event.source_field || null,
          evidence: event.source_span?.text || null,
        }),
        place: placeFrom(row.property_location),
      });
    }
  }
  return out;
}

function rulesEvents(payload, options) {
  const kinds = { public_hearing: "hearing", effective: "effective", adoption: "decision" };
  const out = [];
  for (const record of payload?.rules || []) {
    for (const event of record.events || []) {
      const kind = kinds[event.event_type];
      if (!kind || !withinHorizon(options.today, event.valid_at, options.eventHorizonDays)) continue;
      const route = officialNoticeRoute(record.request_id);
      if (!route) continue;
      out.push({
        id: `rules:${record.request_id}:${event.event_type}:${isoDay(event.valid_at)}`,
        lane: "happening_soon",
        kind,
        title: record.title || record.nyc_rules?.title || "Untitled rule",
        agency: record.agency || record.nyc_rules?.agency_name || null,
        domain: "rules",
        source: source("rules"),
        route,
        time: time(event.valid_at, {
          basis: "published_rule_event",
          precision: event.valid_at_precision || "day",
          sourceField: event.source_field || null,
        }),
        place: placeFrom(record.affected_area),
      });
    }
  }
  return out;
}

function propertyEvents(payload, options) {
  const kinds = {
    hearing: "hearing",
    auction_window: "auction",
    auction: "auction",
    sale: "auction",
    result_award: "decision",
  };
  const out = [];
  for (const row of payload?.properties || []) {
    for (const event of row?.commercial?.timed_events || []) {
      const kind = kinds[event.kind];
      const value = event.start || event.deadline || null;
      if (!kind || !withinHorizon(options.today, value, options.eventHorizonDays)) continue;
      const route = officialNoticeRoute(row.request_id);
      if (!route) continue;
      const verified = event.date_source !== "derived_from_relative_rule" && event.confidence !== "low";
      out.push({
        id: `property:${row.request_id}:${event.kind}:${isoDay(value)}`,
        lane: "happening_soon",
        kind,
        title: row.short_title || "Untitled property notice",
        agency: row.agency_name || null,
        domain: "property",
        source: source("property"),
        route,
        time: time(value, {
          basis: verified ? "typed_event_literal" : "typed_event_derived",
          verified,
          precision: String(value).includes("T") ? "instant" : "day",
          sourceField: event.source_field || null,
          evidence: event.source_span?.text || null,
        }),
        place: placeFrom(row.property_location),
      });
    }
  }
  return out;
}

function meetingEvents(payload, options) {
  const out = [];
  for (const row of payload?.hearings || []) {
    if (!withinHorizon(options.today, row.event_date, options.eventHorizonDays)) continue;
    const route = officialNoticeRoute(row.request_id);
    if (!route) continue;
    const kind = /\bhearing\b/i.test(`${row.type_of_notice_description || ""} ${row.title || ""}`)
      ? "hearing"
      : "meeting";
    out.push({
      id: `meetings:${row.request_id}`,
      lane: "happening_soon",
      kind,
      title: noticeDisplayTitle({ title: row.title, request_id: row.request_id }, kind === "hearing" ? "Hearing" : "Meeting"),
      agency: row.agency || null,
      domain: "meetings",
      source: source("meetings"),
      route,
      time: time(row.event_date, { basis: "published_event_date", precision: String(row.event_date).includes("T") ? "instant" : "day", sourceField: "event_date" }),
      place: placeFrom(row.affected_area || row.venue),
    });
  }
  return out;
}

function landEvents(payload, options) {
  const out = [];
  for (const row of payload?.hearings || []) {
    const value = row.hearing_at || row.hearing_date || null;
    if (!withinHorizon(options.today, value, options.eventHorizonDays) || !row.project_id) continue;
    out.push({
      id: `land:${row.project_id}:${isoDay(value)}`,
      lane: "happening_soon",
      kind: "hearing",
      title: landProjectDisplayTitle(row),
      agency: row.representing || null,
      domain: "land",
      source: source("land"),
      route: `/#land/${encodeURIComponent(row.project_id)}`,
      time: time(value, {
        basis: "published_zap_event",
        precision: String(value).includes("T") ? "instant" : "day",
        sourceField: row.provenance?.field || "hearing_date",
      }),
      place: placeFrom({ scope: row.borough ? "local" : "unlocated", boroughs: row.borough ? [row.borough] : [] }),
    });
  }
  return out;
}

function timeOrder(a, b) {
  return Number(b.time?.verified === true) - Number(a.time?.verified === true)
    || String(a.time?.value || "9999-12-31").localeCompare(String(b.time?.value || "9999-12-31"))
    || a.id.localeCompare(b.id);
}

function sourceCoverage(sources) {
  const bySource = {};
  for (const domain of DOMAINS) {
    const value = sources?.[domain] || {};
    const present = Object.hasOwn(sources || {}, domain);
    bySource[domain] = {
      status: present && value.status !== "unavailable" ? "available" : "unavailable",
      generated_at: value.generated_at || null,
      reason: value.reason || (present ? null : "source_not_loaded"),
    };
  }
  const unavailable = DOMAINS.filter((domain) => bySource[domain].status === "unavailable");
  return { complete: unavailable.length === 0, unavailable_sources: unavailable, sources: bySource };
}

function scoped(items, scope, matchesScope) {
  if (!scope || typeof matchesScope !== "function") return items;
  return items.filter((item) => matchesScope(item, scope) === true);
}

function boundedLane(items, limit) {
  const ordered = [...items].sort(timeOrder);
  if (!Number.isFinite(limit) || ordered.length <= limit) return ordered;
  const selected = new Map();
  for (const item of ordered) {
    if (![...selected.values()].some((candidate) => candidate.kind === item.kind)) selected.set(item.id, item);
  }
  for (const item of ordered) {
    if (selected.size >= limit) break;
    selected.set(item.id, item);
  }
  return [...selected.values()].sort(timeOrder).slice(0, limit);
}

/**
 * Build the additive Now read model from already-extracted action and time models.
 * `scope` is intentionally opaque: Increment 2 can provide its geographic scope
 * object and predicate without changing either lane's eligibility rules.
 */
export function buildNowSurface(sources = {}, options = {}) {
  const today = isoDay(options.today) || new Date().toISOString().slice(0, 10);
  const config = {
    today,
    actionHorizonDays: Number.isFinite(options.actionHorizonDays) ? options.actionHorizonDays : NOW_ACTION_HORIZON_DAYS,
    eventHorizonDays: Number.isFinite(options.eventHorizonDays) ? options.eventHorizonDays : NOW_EVENT_HORIZON_DAYS,
    compileActionRail: options.compileActionRail,
  };
  const actionCandidates = scoped([
    ...moneyActions(sources.money, config),
    ...staffingActions(sources.staffing, config),
    ...rulesActions(sources.rules, config),
    ...propertyActions(sources.property, config),
  ], options.scope, options.matchesScope);
  const eventCandidates = scoped([
    ...meetingEvents(sources.meetings, config),
    ...landEvents(sources.land, config),
    ...rulesEvents(sources.rules, config),
    ...propertyEvents(sources.property, config),
  ], options.scope, options.matchesScope).sort(timeOrder);
  const laneLimit = Number.isFinite(options.laneLimit) ? Math.max(1, Math.floor(options.laneLimit)) : NOW_LANE_LIMIT;
  const datedCandidates = actionCandidates.filter((item) => item.time?.value).sort(timeOrder);
  const undatedCandidates = actionCandidates.filter((item) => !item.time?.value).sort((a, b) => a.id.localeCompare(b.id));
  const dated = boundedLane(datedCandidates, laneLimit);
  const openWithoutDate = undatedCandidates.slice(0, 4);
  const events = boundedLane(eventCandidates, laneLimit);
  const counts = {
    act_by: dated.length + openWithoutDate.length,
    happening_soon: events.length,
    total: dated.length + openWithoutDate.length + events.length,
  };
  return {
    schema_version: NOW_SURFACE_SCHEMA_VERSION,
    generated_for: today,
    horizons: { act_by_days: config.actionHorizonDays, happening_soon_days: config.eventHorizonDays },
    scope_applied: Boolean(options.scope),
    coverage: {
      ...sourceCoverage(sources),
      candidate_counts: {
        act_by_dated: datedCandidates.length,
        act_by_open_without_date: undatedCandidates.length,
        happening_soon: eventCandidates.length,
      },
    },
    counts,
    act_by: { count: counts.act_by, dated, open_without_date: openWithoutDate },
    happening_soon: { count: counts.happening_soon, items: events },
  };
}

export function countNowSurfaceItems(surface) {
  return (surface?.act_by?.dated || []).length
    + (surface?.act_by?.open_without_date || []).length
    + (surface?.happening_soon?.items || []).length;
}
