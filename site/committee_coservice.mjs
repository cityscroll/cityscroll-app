/**
 * Dated co-service between City Council members, read from the published
 * committee graph.
 *
 * The graph already carries one dated `member_of` observation per publisher
 * office record. Two members serve together on a body when both of their
 * observations for that exact BodyId cover the same day, so this module
 * intersects intervals rather than comparing names, titles or districts.
 *
 * Three properties are deliberate:
 *
 *   - The as-of day is an argument, never a clock. A membership snapshot can
 *     only speak about days it observed, so the caller states which day it is
 *     asking about and the answer stays reproducible from committed data.
 *   - Bodies are counted once. The publisher can repeat a person/body row, and
 *     a repeated observation is one membership rather than two.
 *   - Caucuses stay apart from committees. They arrive through the same
 *     office-record family, so they appear as bodies, and they are counted and
 *     labelled separately from the committee count.
 *
 * Co-service is a roster fact: two names appear on the same body for
 * overlapping dates. It carries nothing about attendance or agreement.
 */

import { constellationLink } from "./affordance_grammar.mjs";

export const COMMITTEE_COSERVICE_SCHEMA = "cityscroll.committee_coservice.v1";

/** How many colleagues stay in the open list before the rest move into a disclosure. */
export const COMMITTEE_COSERVICE_VISIBLE_COLLEAGUES = 8;

const coserviceClean = (value, max = 320) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const coserviceDay = (value) => {
  const text = coserviceClean(value, 40).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};

const coserviceOfficialId = (value) => {
  const id = coserviceClean(value, 80).replace(/^official:/, "");
  return /^\d+$/.test(id) ? id : null;
};

const coserviceCommitteeId = (value) => {
  const id = coserviceClean(value, 80).replace(/^committee:/, "");
  return /^\d+$/.test(id) ? id : null;
};

/**
 * A caucus is published through the same office-record family as a committee,
 * so it is separated by the publisher's own body name rather than by a local
 * list of ids that would go stale the day a caucus is added.
 */
export function isCouncilCaucusBody(name) {
  return /caucus/i.test(coserviceClean(name, 200));
}

/**
 * Intersect two inclusive dated intervals. Returns null when they never
 * overlap, which is what keeps two terms on the same committee in different
 * decades from reading as service together.
 */
export function datedServiceOverlap(left, right) {
  const start = coserviceDay(left?.start);
  const end = coserviceDay(left?.end);
  const otherStart = coserviceDay(right?.start);
  const otherEnd = coserviceDay(right?.end);
  if (!start || !end || !otherStart || !otherEnd) return null;
  const from = start >= otherStart ? start : otherStart;
  const to = end <= otherEnd ? end : otherEnd;
  return from <= to ? { start: from, end: to } : null;
}

function coserviceBodyName(graph, ref) {
  const node = (Array.isArray(graph?.nodes) ? graph.nodes : [])
    .find((candidate) => candidate?.id === ref && candidate?.type === "committee");
  return coserviceClean(node?.name) || null;
}

/** Dated `member_of` observations that cover the as-of day, one row per observation. */
function coserviceObservations(graph, asOf) {
  return (Array.isArray(graph?.public_edges) ? graph.public_edges : [])
    .filter((edge) => edge?.type === "member_of")
    .map((edge) => {
      const officialId = coserviceOfficialId(edge?.from);
      const committeeId = coserviceCommitteeId(edge?.to);
      const start = coserviceDay(edge?.valid_from);
      const end = coserviceDay(edge?.valid_to);
      if (!officialId || !committeeId || !start || !end) return null;
      if (start > asOf || end < asOf) return null;
      return {
        official_id: officialId,
        committee_id: committeeId,
        committee_ref: `committee:${committeeId}`,
        start,
        end,
        is_chair: Boolean(edge?.is_chair),
        source_title: coserviceClean(edge?.title, 120) || null,
      };
    })
    .filter(Boolean);
}

function coserviceRole(observation) {
  if (observation.is_chair) return "Chair";
  return observation.source_title || "Membership";
}

/**
 * Collapse repeated observations of the same person on the same body into one
 * membership carrying the widest dates the publisher recorded around that day.
 */
function coserviceMembershipsByBody(observations) {
  const byBody = new Map();
  for (const observation of observations) {
    const current = byBody.get(observation.committee_ref);
    if (!current) {
      byBody.set(observation.committee_ref, { ...observation, observation_count: 1 });
      continue;
    }
    current.observation_count += 1;
    if (observation.start < current.start) current.start = observation.start;
    if (observation.end > current.end) current.end = observation.end;
    if (observation.is_chair && !current.is_chair) {
      current.is_chair = true;
      current.source_title = observation.source_title;
    }
  }
  return byBody;
}

function coserviceUnavailableView(graph, asOf) {
  return {
    schema: COMMITTEE_COSERVICE_SCHEMA,
    version: 1,
    state: "unknown",
    as_of: asOf,
    vintage: coserviceClean(graph?.generated_at, 80) || null,
    source: "nyc_legistar_office_records",
    subject: null,
    colleagues: [],
    colleague_count: 0,
    visible_count: 0,
    disclosed_count: 0,
    represented_official_count: 0,
    subject_committee_count: 0,
    subject_caucus_count: 0,
    unnamed_colleague_count: 0,
  };
}

/**
 * Build the dated co-service view for one official.
 *
 * `asOf` is required: without a stated day there is no overlap question to
 * answer. Pass the snapshot's own vintage day to describe the snapshot.
 */
export function buildCommitteeCoServiceView(graph = {}, personId, {
  asOf = null,
  people = null,
  limit = COMMITTEE_COSERVICE_VISIBLE_COLLEAGUES,
} = {}) {
  const subjectId = coserviceOfficialId(personId);
  const day = coserviceDay(asOf);
  if (!subjectId || !day) return coserviceUnavailableView(graph, day);
  if (graph?.publication !== "published") return coserviceUnavailableView(graph, day);

  const observations = coserviceObservations(graph, day);
  const isCaucus = (observation) => isCouncilCaucusBody(coserviceBodyName(graph, observation.committee_ref));
  const committeeObservations = observations.filter((observation) => !isCaucus(observation));
  const caucusObservations = observations.filter(isCaucus);

  const subjectCommittees = coserviceMembershipsByBody(
    committeeObservations.filter((observation) => observation.official_id === subjectId),
  );
  const subjectCaucuses = coserviceMembershipsByBody(
    caucusObservations.filter((observation) => observation.official_id === subjectId),
  );
  const representedOfficials = new Set(committeeObservations.map((observation) => observation.official_id));
  const subjectName = coserviceClean(people?.by_person_id?.[subjectId]?.person_name) || null;
  const subject = {
    id: subjectId,
    ref: `official:${subjectId}`,
    name: subjectName,
    href: `/officials/${encodeURIComponent(subjectId)}/`,
  };

  if (!subjectCommittees.size) {
    return {
      ...coserviceUnavailableView(graph, day),
      state: "empty",
      subject,
      represented_official_count: representedOfficials.size,
      subject_caucus_count: subjectCaucuses.size,
    };
  }

  const byColleague = new Map();
  const collect = (rows, subjectBodies, bucket) => {
    for (const observation of rows) {
      if (observation.official_id === subjectId) continue;
      const mine = subjectBodies.get(observation.committee_ref);
      if (!mine) continue;
      const overlap = datedServiceOverlap(mine, observation);
      if (!overlap) continue;
      const name = coserviceClean(people?.by_person_id?.[observation.official_id]?.person_name) || null;
      const current = byColleague.get(observation.official_id) || {
        official_id: observation.official_id,
        name,
        committees: new Map(),
        caucuses: new Map(),
      };
      if (!current.name && name) current.name = name;
      const target = current[bucket];
      const existing = target.get(observation.committee_ref);
      if (existing) {
        if (overlap.start < existing.overlap_start) existing.overlap_start = overlap.start;
        if (overlap.end > existing.overlap_end) existing.overlap_end = overlap.end;
      } else {
        target.set(observation.committee_ref, {
          committee_id: observation.committee_id,
          committee_ref: observation.committee_ref,
          name: coserviceBodyName(graph, observation.committee_ref),
          href: `/committees/${encodeURIComponent(observation.committee_id)}/`,
          subject_role: coserviceRole(mine),
          subject_role_source_title: mine.source_title,
          colleague_role: coserviceRole(observation),
          colleague_role_source_title: observation.source_title,
          overlap_start: overlap.start,
          overlap_end: overlap.end,
        });
      }
      byColleague.set(observation.official_id, current);
    }
  };
  collect(committeeObservations, subjectCommittees, "committees");
  collect(caucusObservations, subjectCaucuses, "caucuses");

  const withCommittees = [...byColleague.values()].filter((entry) => entry.committees.size > 0);
  const unnamed = withCommittees.filter((entry) => !entry.name).length;
  const byBodyName = (left, right) => String(left.name || "").localeCompare(String(right.name || ""), "en-US");
  const colleagues = withCommittees
    .filter((entry) => Boolean(entry.name))
    .map((entry) => {
      const committees = [...entry.committees.values()].sort(byBodyName);
      const caucuses = [...entry.caucuses.values()].sort(byBodyName);
      return {
        official_id: entry.official_id,
        ref: `official:${entry.official_id}`,
        name: entry.name,
        href: `/officials/${encodeURIComponent(entry.official_id)}/`,
        shared_committee_count: committees.length,
        shared_committees: committees,
        shared_caucus_count: caucuses.length,
        shared_caucuses: caucuses,
      };
    })
    .sort((left, right) => right.shared_committee_count - left.shared_committee_count || byBodyName(left, right));

  const boundedLimit = Number.isInteger(limit) && limit > 0 ? limit : COMMITTEE_COSERVICE_VISIBLE_COLLEAGUES;
  const visible = Math.min(colleagues.length, boundedLimit);

  return {
    schema: COMMITTEE_COSERVICE_SCHEMA,
    version: 1,
    state: colleagues.length ? "matched" : "empty",
    as_of: day,
    vintage: coserviceClean(graph?.generated_at, 80) || null,
    source: "nyc_legistar_office_records",
    subject,
    colleagues,
    colleague_count: colleagues.length,
    visible_count: visible,
    disclosed_count: Math.max(0, colleagues.length - visible),
    represented_official_count: representedOfficials.size,
    subject_committee_count: subjectCommittees.size,
    subject_caucus_count: subjectCaucuses.size,
    unnamed_colleague_count: unnamed,
  };
}

/**
 * Every unordered pair of represented officials sharing a committee on the
 * as-of day. The profile view answers one person's question; this answers the
 * population question the profile counts are drawn from.
 */
export function measureCommitteeCoServicePairs(graph = {}, { asOf = null } = {}) {
  const day = coserviceDay(asOf);
  if (!day || graph?.publication !== "published") {
    return { as_of: day, represented_officials: 0, pairs: 0, pairs_with_two_or_more_bodies: 0 };
  }
  const bodiesByOfficial = new Map();
  for (const observation of coserviceObservations(graph, day)) {
    if (isCouncilCaucusBody(coserviceBodyName(graph, observation.committee_ref))) continue;
    if (!bodiesByOfficial.has(observation.official_id)) bodiesByOfficial.set(observation.official_id, new Map());
    const bodies = bodiesByOfficial.get(observation.official_id);
    const current = bodies.get(observation.committee_ref);
    if (!current) {
      bodies.set(observation.committee_ref, { start: observation.start, end: observation.end });
      continue;
    }
    if (observation.start < current.start) current.start = observation.start;
    if (observation.end > current.end) current.end = observation.end;
  }
  const officials = [...bodiesByOfficial.keys()].sort();
  let pairs = 0;
  let deepPairs = 0;
  for (let index = 0; index < officials.length; index += 1) {
    for (let other = index + 1; other < officials.length; other += 1) {
      const mine = bodiesByOfficial.get(officials[index]);
      const theirs = bodiesByOfficial.get(officials[other]);
      let shared = 0;
      for (const [ref, interval] of mine) {
        const match = theirs.get(ref);
        if (match && datedServiceOverlap(interval, match)) shared += 1;
      }
      if (shared > 0) pairs += 1;
      if (shared >= 2) deepPairs += 1;
    }
  }
  return {
    as_of: day,
    represented_officials: officials.length,
    pairs,
    pairs_with_two_or_more_bodies: deepPairs,
  };
}

function coserviceCommitteeMarkup(row, colleague, view, { escape, translate }) {
  const link = constellationLink({
    href: row.href,
    label: row.name || `Committee ${row.committee_id}`,
    className: "official-coservice-committee-link",
    attributes: { "data-coservice-committee-id": row.committee_id },
    escape,
  });
  const detail = [
    view.subject?.name
      ? translate("official_coservice_member_role", { name: escape(view.subject.name), role: escape(row.subject_role) })
      : escape(row.subject_role),
    translate("official_coservice_member_role", { name: escape(colleague.name), role: escape(row.colleague_role) }),
    translate("official_coservice_overlap", { start: escape(row.overlap_start), end: escape(row.overlap_end) }),
  ].join(" · ");
  return `<li class="official-coservice-committee" data-coservice-body-kind="committee" data-coservice-committee-id="${escape(row.committee_id)}" data-coservice-overlap-start="${escape(row.overlap_start)}" data-coservice-overlap-end="${escape(row.overlap_end)}" data-coservice-subject-role-source="${escape(row.subject_role_source_title || "")}" data-coservice-colleague-role-source="${escape(row.colleague_role_source_title || "")}">
      <span lang="en" dir="ltr">${link}</span>
      <span class="official-coservice-detail">${detail}</span>
    </li>`;
}

function coserviceColleagueMarkup(colleague, view, options) {
  const { escape, translate, translateCount } = options;
  const link = constellationLink({
    href: colleague.href,
    label: colleague.name,
    className: "official-coservice-official-link",
    attributes: { "data-coservice-official-id": colleague.official_id },
    escape,
  });
  const caucusLine = colleague.shared_caucuses.length
    ? `<p class="official-coservice-caucuses" data-coservice-body-kind="caucus" data-coservice-caucus-count="${colleague.shared_caucus_count}">${translate("official_coservice_caucus_label")} ${colleague.shared_caucuses.map((row) => `<span lang="en" dir="ltr">${constellationLink({
      href: row.href,
      label: row.name || `Body ${row.committee_id}`,
      className: "official-coservice-caucus-link",
      attributes: { "data-coservice-caucus-id": row.committee_id },
      escape,
    })}</span>`).join(" ")}</p>`
    : "";
  return `<li class="official-coservice-colleague" data-coservice-official-id="${escape(colleague.official_id)}" data-coservice-shared-committees="${colleague.shared_committee_count}">
    <p class="official-coservice-colleague-head"><strong lang="en" dir="ltr">${link}</strong> <span class="official-coservice-count">${translateCount("official_coservice_shared_committees", colleague.shared_committee_count)}</span></p>
    <ul class="official-coservice-committees">${colleague.shared_committees.map((row) => coserviceCommitteeMarkup(row, colleague, view, options)).join("")}</ul>
    ${caucusLine}
  </li>`;
}

/**
 * Render the section. An official with no supported co-service row renders
 * nothing at all, so an unpublished or empty graph never becomes furniture.
 */
export function renderCommitteeCoServiceHTML(view, { escapeHtml, translate, translateCount } = {}) {
  if (view?.schema !== COMMITTEE_COSERVICE_SCHEMA) return "";
  if (view.state !== "matched" || !view.colleagues?.length) return "";
  const escape = typeof escapeHtml === "function" ? escapeHtml : (value) => String(value ?? "");
  const t = typeof translate === "function" ? translate : (key) => key;
  const tc = typeof translateCount === "function"
    ? translateCount
    : (base, count, vars) => t(`${base}_other`, { n: String(count), ...(vars || {}) });
  const options = { escape, translate: t, translateCount: tc };
  const headingId = "official-coservice-heading";
  const visible = view.colleagues.slice(0, view.visible_count);
  const disclosed = view.colleagues.slice(view.visible_count);
  const disclosure = disclosed.length
    ? `<details class="official-coservice-more" data-coservice-disclosed="${disclosed.length}">
      <summary>${tc("official_coservice_more", disclosed.length)}</summary>
      <ul class="official-coservice-colleagues">${disclosed.map((colleague) => coserviceColleagueMarkup(colleague, view, options)).join("")}</ul>
    </details>`
    : "";
  const vintage = view.vintage ? String(view.vintage).slice(0, 10) : view.as_of;
  return `<section class="official-coservice" data-official-coservice="1" data-coservice-state="${escape(view.state)}" data-coservice-as-of="${escape(view.as_of)}" data-coservice-colleague-count="${view.colleague_count}" data-coservice-represented-officials="${view.represented_official_count}" aria-labelledby="${headingId}">
    <div class="chain-h" id="${headingId}">${t("official_coservice_heading")}</div>
    <p class="official-coservice-summary">${tc("official_coservice_summary", view.colleague_count, { date: escape(view.as_of) })}</p>
    <p class="official-coservice-basis">${t("official_coservice_basis", { vintage: escape(vintage) })}</p>
    <ul class="official-coservice-colleagues">${visible.map((colleague) => coserviceColleagueMarkup(colleague, view, options)).join("")}</ul>
    ${disclosure}
  </section>`;
}
