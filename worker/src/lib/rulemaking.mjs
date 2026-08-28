import {
  buildRulesPhaseView,
  eventDate,
  mergeRulemakingEvents,
  stitchRulemakingRecord,
} from "../../../site/rules_phase_spine.mjs";
import { rulesCardInteractionProjection } from "../../../site/rules_card_interaction.mjs";

export const RULEMAKING_OBJECT_SCHEMA = "cityscroll.rulemaking.v1";

const clean = (value, max = 2_000) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function recordRequestId(record) {
  const id = clean(record?.request_id || record?.city_record?.request_id, 80);
  return id || null;
}

function classifyRulemakingRole(record) {
  const title = clean(record?.title || record?.city_record?.title || record?.city_record?.short_title);
  const type = clean(record?.city_record?.notice_type || record?.type_of_notice_description);
  const stage = clean(record?.stage);
  const haystack = `${title} ${type} ${stage}`;
  if (/\badoption\b|\badopted\b/i.test(haystack) || record?.nyc_rules?.adoption_published_at || stage === "adopted" || stage === "effective") return "adoption";
  if (/\bpublic hearing\b|\bhearing\b/i.test(title) || stage === "hearing" || /\bpublic hearings?\b/i.test(type)) return "hearing";
  if (/\bproposed\b|\bproposal\b/i.test(haystack) || /^(?:proposed|comment-open|comment-closed)$/.test(stage)) return "proposal";
  return "notice";
}

function date(value) {
  const match = clean(value, 80).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function noticeUrl(requestId) {
  const id = clean(requestId, 80);
  return id ? `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}` : null;
}

function isGrounded(row) {
  const join = row?.rulemaking_join;
  return Boolean(
    clean(row?.rulemaking_subject_ref)
    && join?.matched === true
    && join?.confidence === "high"
    && Number(join?.notice_count) > 1,
  );
}

function sourceDocuments(rows, nycRules) {
  const cityRecord = rows
    .map((row) => {
      const id = recordRequestId(row);
      return id ? {
        kind: "city_record_notice",
        request_id: id,
        role: classifyRulemakingRole(row),
        title: clean(row.title || row.city_record?.title || row.city_record?.short_title) || null,
        href: `/notices/${encodeURIComponent(id)}`,
        source_url: noticeUrl(id),
      } : null;
    })
    .filter(Boolean);
  const official = [nycRules?.url, nycRules?.comment_url]
    .map((href) => clean(href))
    .filter(Boolean)
    .filter((href, index, all) => all.indexOf(href) === index)
    .map((href) => ({ kind: "nyc_rules", label: "NYC Rules", href }));
  return [...cityRecord, ...official];
}

/**
 * CAP-2's exact continuation wire. This is a Following destination, not a
 * watch mutation: the replay capability validates the bounded member set
 * before a consumer can create or reopen a subscription.
 */
function exactFollowingHref(rows) {
  const requestIds = [...new Set(rows.map(recordRequestId).filter(Boolean))].sort();
  if (!requestIds.length) return null;
  const filter = encodeURIComponent(JSON.stringify({ request_ids: requestIds }));
  return `/following/?lens=rules&filter=${filter}`;
}

function noticeLifecycleEvents(rows, existingEvents) {
  let events = Array.isArray(existingEvents) ? existingEvents.slice() : [];
  const hasProposal = events.some((event) => event?.event_type === "proposal_published" && eventDate(event));
  const proposal = [...rows]
    .filter((row) => /\bproposed\b|\bproposal\b/i.test(clean(row.title || row.city_record?.title || row.city_record?.short_title)))
    .sort((left, right) => String(left.notice_date || left.city_record?.notice_date || "").localeCompare(String(right.notice_date || right.city_record?.notice_date || "")))[0];
  if (!hasProposal && proposal) {
    const day = date(proposal.notice_date || proposal.city_record?.notice_date || proposal.start_date);
    if (day) events.push({
      event_type: "proposal_published",
      valid_at: day,
      source_field: "city_record.notice_date",
      source_url: noticeUrl(recordRequestId(proposal)),
      source_system: "city_record",
      status: "occurred",
      request_id: recordRequestId(proposal),
      derived_from_notice_date: true,
    });
  }
  const adoption = [...rows]
    .filter((row) => classifyRulemakingRole(row) === "adoption")
    .sort((left, right) => String(right.notice_date || right.city_record?.notice_date || "").localeCompare(String(left.notice_date || left.city_record?.notice_date || "")))[0];
  const adoptionDay = date(adoption?.notice_date || adoption?.city_record?.notice_date || adoption?.start_date);
  // A stale RSS pubDate can describe the proposal page rather than the later
  // City Record adoption notice. Prefer the dated adoption notice already in
  // this materialization when the two disagree.
  if (adoptionDay && events.some((event) => event?.event_type === "adoption" && event?.source_field === "pubDate" && eventDate(event) !== adoptionDay)) {
    events = events.filter((event) => !(event?.event_type === "adoption" && event?.source_field === "pubDate"));
  }
  const hasDatedAdoption = events.some((event) => event?.event_type === "adoption" && eventDate(event));
  if (!hasDatedAdoption && adoptionDay) {
    events.push({
      event_type: "adoption",
      valid_at: adoptionDay,
      source_field: "city_record.notice_date",
      source_url: noticeUrl(recordRequestId(adoption)),
      source_system: "city_record",
      status: "occurred",
      request_id: recordRequestId(adoption),
      derived_from_notice_date: true,
    });
  }
  return events;
}

function representative(rows) {
  return [...rows].sort((left, right) => {
    const roleRank = (row) => ({ proposal: 0, hearing: 1, adoption: 2, notice: 3 })[classifyRulemakingRole(row)] ?? 4;
    return roleRank(left) - roleRank(right)
      || String(left.notice_date || left.city_record?.notice_date || "").localeCompare(String(right.notice_date || right.city_record?.notice_date || ""))
      || String(recordRequestId(left) || "").localeCompare(String(recordRequestId(right) || ""));
  })[0] || null;
}

function objectForRows(rows, { now = null } = {}) {
  const ids = new Set(rows.map(recordRequestId).filter(Boolean));
  if (ids.size < 2 || !rows.every(isGrounded)) return null;
  const subject = clean(rows[0].rulemaking_subject_ref, 700);
  if (!subject || rows.some((row) => clean(row.rulemaking_subject_ref, 700) !== subject)) return null;
  const byId = new Map(rows.map((row) => [recordRequestId(row), row]).filter(([id]) => id));
  const primary = representative(rows);
  const stitched = stitchRulemakingRecord(primary, byId, now ? { now } : {});
  let events = mergeRulemakingEvents(...rows.map((row) => row.events || []), stitched?.events || []);
  events = mergeRulemakingEvents(noticeLifecycleEvents(rows, events));
  const phaseView = buildRulesPhaseView({ ...stitched, events }, { skipStitch: true, now });
  const nycRules = stitched?.nyc_rules || rows.find((row) => row.nyc_rules)?.nyc_rules || null;
  const documents = sourceDocuments(rows, nycRules);
  const followHref = exactFollowingHref(rows);
  const notices = rows
    .map((row) => {
      const id = recordRequestId(row);
      if (!id) return null;
      return {
        request_id: id,
        role: classifyRulemakingRole(row),
        title: clean(row.title || row.city_record?.title || row.city_record?.short_title) || null,
        notice_date: date(row.notice_date || row.city_record?.notice_date || row.start_date),
        event_date: date(row.event_date || row.city_record?.event_date),
        stage: clean(row.stage, 80) || null,
        href: `/notices/${encodeURIComponent(id)}`,
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(left.notice_date || "").localeCompare(String(right.notice_date || "")));
  const interaction = rulesCardInteractionProjection({
    request_id: primary?.request_id,
    rulemaking_id: subject,
    title: nycRules?.title || primary?.title || primary?.city_record?.title,
    fine_stage: stitched?.stage,
    rule_url: nycRules?.url,
    comment_url: nycRules?.comment_url,
    comment_by_date: nycRules?.comment_by_date,
    hearing_date: nycRules?.hearing_date,
    events,
    now,
    nyc_rules: nycRules,
    source_documents: documents,
    proposed_rule_url: nycRules?.proposed_rule_url,
    final_rule_url: nycRules?.final_rule_url,
    hearing_url: primary?.hearing_url,
    hearing_record_url: primary?.hearing_record_url,
    comments_url: primary?.comments_url,
    comment_channel_url: primary?.comment_channel_url,
    testimony_url: primary?.testimony_url,
    petition_url: primary?.petition_url,
    follow_href: followHref,
    history_url: `/rules/${encodeURIComponent(subject)}/`,
  });
  return {
    schema: RULEMAKING_OBJECT_SCHEMA,
    object_type: "rulemaking",
    rulemaking_id: subject,
    canonical_href: `/rules/${encodeURIComponent(subject)}/`,
    agency: clean(primary?.agency || primary?.city_record?.agency) || null,
    title: clean(nycRules?.title || primary?.title || primary?.city_record?.title) || "Rulemaking",
    proposal_summary: clean(nycRules?.summary, 4_000) || null,
    current_stage: clean(stitched?.stage, 80) || null,
    lifecycle_state: interaction.lifecycle_state,
    current_phase: phaseView.current?.phase_id || null,
    notices,
    events,
    phases: phaseView.phases,
    source_documents: documents,
    nyc_rules: nycRules,
    interaction,
    history_timeline: phaseView.history_timeline,
    // Subject-level following is not replayable by the rules scope compiler.
    // Keep the exact notice target available until CAP-2 adds that capability.
    follow: {
      state: "notice_fallback",
      request_id: recordRequestId(primary),
    },
    follow_href: followHref,
    history_url: `/rules/${encodeURIComponent(subject)}/`,
    generated_at: clean(rows[0].generated_at, 80) || null,
  };
}

/**
 * Promote only existing high-confidence multi-notice joins into public
 * proceeding objects. Singleton and ambiguous rows remain notice evidence.
 */
export function buildRulemakingObjects(records = [], options = {}) {
  const groups = new Map();
  for (const row of records || []) {
    if (!isGrounded(row)) continue;
    const subject = clean(row.rulemaking_subject_ref, 700);
    if (!groups.has(subject)) groups.set(subject, []);
    groups.get(subject).push(row);
  }
  return [...groups.values()]
    .map((rows) => objectForRows(rows, options))
    .filter(Boolean)
    .sort((left, right) => left.title.localeCompare(right.title));
}

export function rulemakingObjectForId(records, id, options = {}) {
  const wanted = clean(id, 700);
  return buildRulemakingObjects(records, options).find((row) => row.rulemaking_id === wanted) || null;
}

export { isGrounded as isGroundedRulemakingRecord };
