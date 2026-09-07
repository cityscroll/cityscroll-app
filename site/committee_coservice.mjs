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
 *
 * The same observations are read from both ends. From an official, the question
 * is which colleagues share a body; from a committee, which other committees
 * share a member. One reader, one repeated-row collapse and one interval
 * intersection serve both, so the two pages cannot report different counts for
 * the same pair of records.
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
function coserviceMergeMemberships(observations, keyOf) {
  const merged = new Map();
  for (const observation of observations) {
    const key = keyOf(observation);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...observation, observation_count: 1 });
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
  return merged;
}

function coserviceMembershipsByBody(observations) {
  return coserviceMergeMemberships(observations, (observation) => observation.committee_ref);
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

/* ------------------------------------------------------------------------- *
 * The same evidence, read from a committee.
 *
 * The projection above answers "who does this member sit with?". Read from the
 * other end, the identical dated observations answer "which other committees do
 * this committee's members also sit on?". Both directions call the same
 * observation reader, the same repeated-row collapse and the same interval
 * intersection, so a count shown on one page cannot disagree with the count
 * shown on the other.
 * ------------------------------------------------------------------------- */

export const COMMITTEE_SHARED_MEMBERSHIP_SCHEMA = "cityscroll.committee_shared_membership.v1";

/** How many linked committees stay in the open list before the rest are disclosed. */
export const COMMITTEE_SHARED_VISIBLE_COMMITTEES = 8;

/** The anchor the section carries, so a disclosure can link back to a closed list. */
export const COMMITTEE_SHARED_MEMBERSHIP_ANCHOR = "committee-shared-membership";

/**
 * The resident copy this section renders.
 *
 * The committee record is served as a static document with no dictionary
 * runtime, so it renders these English strings directly. They are byte-equal to
 * the `committee_shared_*` entries of the shipped `en` dictionary, and
 * test/existing_connections_committee.test.mjs fails the day they drift apart or
 * the day a shipping language is missing one of them.
 */
export const COMMITTEE_SHARED_MEMBERSHIP_STRINGS = Object.freeze({
  committee_shared_heading: "Committees these members also serve on",
  committee_shared_summary_one:
    "{n} other City Council committee has a member in common with this one, as recorded on {date}.",
  committee_shared_summary_other:
    "{n} other City Council committees have members in common with this one, as recorded on {date}.",
  committee_shared_basis:
    "Drawn from the City Council office records published here, dated {vintage}. Other members can serve on these committees without a record in this set.",
  committee_shared_members_one: "{n} shared member",
  committee_shared_members_other: "{n} shared members",
  committee_shared_expand_one: "Show the shared member",
  committee_shared_expand_other: "Show the {n} shared members",
  committee_shared_expand_aria: "Show the members this committee shares with {committee}",
  committee_shared_collapse: "Hide",
  committee_shared_collapse_aria: "Hide the members this committee shares with {committee}",
  committee_shared_body_role: "{body}: {role}",
  committee_shared_overlap: "On both {start} to {end}",
  committee_shared_more_one: "Show {n} more committee",
  committee_shared_more_other: "Show {n} more committees",
});

const sharedFill = (text, vars) => Object.entries(vars || {}).reduce(
  (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)),
  String(text ?? ""),
);

const sharedEnglishTranslate = (key, vars) => sharedFill(COMMITTEE_SHARED_MEMBERSHIP_STRINGS[key] ?? "", vars);

const sharedEnglishTranslateCount = (base, count, vars) => sharedFill(
  COMMITTEE_SHARED_MEMBERSHIP_STRINGS[`${base}_${count === 1 ? "one" : "other"}`]
    ?? COMMITTEE_SHARED_MEMBERSHIP_STRINGS[`${base}_other`]
    ?? "",
  { n: String(count), ...(vars || {}) },
);

function sharedUnavailableView(graph, asOf, subject) {
  return {
    schema: COMMITTEE_SHARED_MEMBERSHIP_SCHEMA,
    version: 1,
    state: "unknown",
    as_of: asOf,
    vintage: coserviceClean(graph?.generated_at, 80) || null,
    source: "nyc_legistar_office_records",
    subject,
    committees: [],
    committee_count: 0,
    visible_count: 0,
    disclosed_count: 0,
    subject_member_count: 0,
    represented_official_count: 0,
    excluded_caucus_body_count: 0,
    unnamed_member_count: 0,
    subject_is_caucus: false,
  };
}

/**
 * Build the linked-committee view for one committee.
 *
 * A committee is linked to this one when a person the publisher records on both
 * bodies holds those two memberships over days that meet. `asOf` is required for
 * the same reason as above: a membership snapshot can only answer for a day it
 * observed. The count is of distinct people, never of publisher rows.
 */
export function buildCommitteeSharedMembershipView(graph = {}, committeeId, {
  asOf = null,
  people = null,
  limit = COMMITTEE_SHARED_VISIBLE_COMMITTEES,
} = {}) {
  const subjectId = coserviceCommitteeId(committeeId);
  const day = coserviceDay(asOf);
  if (!subjectId || !day) return sharedUnavailableView(graph, day, null);
  const subjectRef = `committee:${subjectId}`;
  const subject = {
    id: subjectId,
    ref: subjectRef,
    name: coserviceBodyName(graph, subjectRef),
    href: `/committees/${encodeURIComponent(subjectId)}/`,
  };
  if (graph?.publication !== "published") return sharedUnavailableView(graph, day, subject);

  // A caucus reaches the reader through the same office-record family as a
  // committee. It is never a linked formal body, and a caucus never lends its
  // roster to a committee connection from either end.
  const isCaucusRef = (ref) => isCouncilCaucusBody(coserviceBodyName(graph, ref));
  if (isCaucusRef(subjectRef)) {
    return { ...sharedUnavailableView(graph, day, subject), state: "empty", subject_is_caucus: true };
  }

  const observations = coserviceObservations(graph, day);
  const representedOfficials = new Set(
    observations.filter((observation) => !isCaucusRef(observation.committee_ref))
      .map((observation) => observation.official_id),
  );
  // One membership per person on this committee, however many rows the
  // publisher repeated for it.
  const subjectMemberships = coserviceMergeMemberships(
    observations.filter((observation) => observation.committee_ref === subjectRef),
    (observation) => observation.official_id,
  );
  if (!subjectMemberships.size) {
    return {
      ...sharedUnavailableView(graph, day, subject),
      state: "empty",
      represented_official_count: representedOfficials.size,
    };
  }

  const caucusBodies = new Set();
  const byCommittee = new Map();
  for (const observation of observations) {
    if (observation.committee_ref === subjectRef) continue;
    const here = subjectMemberships.get(observation.official_id);
    if (!here) continue;
    if (isCaucusRef(observation.committee_ref)) {
      caucusBodies.add(observation.committee_ref);
      continue;
    }
    const overlap = datedServiceOverlap(here, observation);
    if (!overlap) continue;
    const entry = byCommittee.get(observation.committee_ref) || {
      committee_id: observation.committee_id,
      committee_ref: observation.committee_ref,
      name: coserviceBodyName(graph, observation.committee_ref),
      href: `/committees/${encodeURIComponent(observation.committee_id)}/`,
      members: new Map(),
    };
    const existing = entry.members.get(observation.official_id);
    if (existing) {
      // A repeated publisher row widens the recorded window; it never becomes a
      // second shared member.
      existing.observation_count += 1;
      if (overlap.start < existing.overlap_start) existing.overlap_start = overlap.start;
      if (overlap.end > existing.overlap_end) existing.overlap_end = overlap.end;
      if (observation.is_chair && existing.linked_role !== "Chair") {
        existing.linked_role = coserviceRole(observation);
        existing.linked_role_source_title = observation.source_title;
      }
    } else {
      entry.members.set(observation.official_id, {
        official_id: observation.official_id,
        ref: `official:${observation.official_id}`,
        name: coserviceClean(people?.by_person_id?.[observation.official_id]?.person_name) || null,
        href: `/officials/${encodeURIComponent(observation.official_id)}/`,
        subject_role: coserviceRole(here),
        subject_role_source_title: here.source_title,
        linked_role: coserviceRole(observation),
        linked_role_source_title: observation.source_title,
        overlap_start: overlap.start,
        overlap_end: overlap.end,
        observation_count: 1,
      });
    }
    byCommittee.set(observation.committee_ref, entry);
  }

  const unnamed = new Set();
  for (const entry of byCommittee.values()) {
    for (const member of entry.members.values()) if (!member.name) unnamed.add(member.official_id);
  }
  const byName = (left, right) => String(left.name || "").localeCompare(String(right.name || ""), "en-US");
  const committees = [...byCommittee.values()]
    .map((entry) => {
      // A person the publisher records without a published name is counted, and
      // never rendered as a bare id.
      const members = [...entry.members.values()].filter((member) => member.name).sort(byName);
      return {
        committee_id: entry.committee_id,
        committee_ref: entry.committee_ref,
        name: entry.name,
        href: entry.href,
        anchor: `${COMMITTEE_SHARED_MEMBERSHIP_ANCHOR}-${entry.committee_id}`,
        shared_member_count: members.length,
        shared_members: members,
      };
    })
    .filter((entry) => entry.name && entry.shared_member_count > 0)
    .sort((left, right) => right.shared_member_count - left.shared_member_count || byName(left, right));

  const boundedLimit = Number.isInteger(limit) && limit > 0 ? limit : COMMITTEE_SHARED_VISIBLE_COMMITTEES;
  const visible = Math.min(committees.length, boundedLimit);
  const namedSubjectMembers = [...subjectMemberships.keys()]
    .filter((officialId) => coserviceClean(people?.by_person_id?.[officialId]?.person_name));

  return {
    schema: COMMITTEE_SHARED_MEMBERSHIP_SCHEMA,
    version: 1,
    state: committees.length ? "matched" : "empty",
    as_of: day,
    vintage: coserviceClean(graph?.generated_at, 80) || null,
    source: "nyc_legistar_office_records",
    subject,
    committees,
    committee_count: committees.length,
    visible_count: visible,
    disclosed_count: Math.max(0, committees.length - visible),
    subject_member_count: namedSubjectMembers.length,
    represented_official_count: representedOfficials.size,
    excluded_caucus_body_count: caucusBodies.size,
    unnamed_member_count: unnamed.size,
    subject_is_caucus: false,
  };
}

function sharedMemberMarkup(member, row, view, { escape, translate }) {
  const link = constellationLink({
    href: member.href,
    label: member.name,
    className: "committee-shared-member-link",
    attributes: {
      "data-pivot-target-kind": "official",
      "data-pivot-target-id": member.official_id,
      "data-pivot-relation-label": "shared member",
    },
    escape,
  });
  const detail = [
    translate("committee_shared_body_role", {
      body: escape(view.subject?.name || ""),
      role: escape(member.subject_role),
    }),
    translate("committee_shared_body_role", { body: escape(row.name), role: escape(member.linked_role) }),
    translate("committee_shared_overlap", {
      start: escape(member.overlap_start),
      end: escape(member.overlap_end),
    }),
  ].join(" · ");
  return `<li class="committee-shared-member" data-shared-official-id="${escape(member.official_id)}" data-shared-overlap-start="${escape(member.overlap_start)}" data-shared-overlap-end="${escape(member.overlap_end)}" data-shared-subject-role-source="${escape(member.subject_role_source_title || "")}" data-shared-linked-role-source="${escape(member.linked_role_source_title || "")}">
      <span lang="en" dir="ltr">${link}</span>
      <span class="node-muted committee-shared-member-detail" lang="en" dir="ltr">${detail}</span>
    </li>`;
}

/**
 * One linked committee.
 *
 * The expansion is a `:target` disclosure rather than a `<details>` element: a
 * history entry carries the URL, not element state, so an expansion that lives
 * in the fragment is the one still open when the reader walks to a member, on to
 * another committee, and presses Back. It is script-free, keeps modified-click
 * behaviour, and with the stylesheet unavailable the members simply render.
 */
function sharedCommitteeMarkup(row, view, options) {
  const { escape, translate, translateCount } = options;
  const link = constellationLink({
    href: row.href,
    label: row.name,
    className: "committee-shared-committee-link",
    attributes: {
      "data-pivot-target-kind": "committee",
      "data-pivot-target-id": row.committee_id,
      "data-pivot-relation-label": "shares members with",
    },
    escape,
  });
  const openLabel = translateCount("committee_shared_expand", row.shared_member_count);
  const openAria = translate("committee_shared_expand_aria", { committee: escape(row.name) });
  const closeAria = translate("committee_shared_collapse_aria", { committee: escape(row.name) });
  return `<li class="committee-shared-row" id="${escape(row.anchor)}" data-shared-committee-id="${escape(row.committee_id)}" data-shared-member-count="${row.shared_member_count}">
      <p class="committee-shared-head"><span lang="en" dir="ltr">${link}</span> <span class="committee-shared-count">${translateCount("committee_shared_members", row.shared_member_count)}</span></p>
      <p class="committee-shared-controls"><a class="committee-shared-open" href="#${escape(row.anchor)}" aria-label="${openAria}">${openLabel}</a><a class="committee-shared-close" href="#${escape(COMMITTEE_SHARED_MEMBERSHIP_ANCHOR)}" aria-label="${closeAria}">${translate("committee_shared_collapse")}</a></p>
      <ul class="committee-shared-members">${row.shared_members.map((member) => sharedMemberMarkup(member, row, view, options)).join("")}</ul>
    </li>`;
}

/**
 * Render the linked-committee body for a committee record.
 *
 * A committee with no supported linked row renders nothing at all, so an
 * unpublished, empty or single-body graph never becomes furniture. The caller
 * wraps this in the document's own section chrome.
 */
export function renderCommitteeSharedMembershipHTML(view, {
  escapeHtml,
  translate,
  translateCount,
} = {}) {
  if (view?.schema !== COMMITTEE_SHARED_MEMBERSHIP_SCHEMA) return "";
  if (view.state !== "matched" || !view.committees?.length) return "";
  const escape = typeof escapeHtml === "function" ? escapeHtml : (value) => String(value ?? "");
  const t = typeof translate === "function" ? translate : sharedEnglishTranslate;
  const tc = typeof translateCount === "function" ? translateCount : sharedEnglishTranslateCount;
  const options = { escape, translate: t, translateCount: tc };
  const visible = view.committees.slice(0, view.visible_count);
  const disclosed = view.committees.slice(view.visible_count);
  const moreAnchor = `${COMMITTEE_SHARED_MEMBERSHIP_ANCHOR}-more`;
  const overflow = disclosed.length
    ? `<div class="committee-shared-overflow" id="${escape(moreAnchor)}" data-shared-disclosed="${disclosed.length}">
      <p class="committee-shared-controls"><a class="committee-shared-open" href="#${escape(moreAnchor)}">${tc("committee_shared_more", disclosed.length)}</a><a class="committee-shared-close" href="#${escape(COMMITTEE_SHARED_MEMBERSHIP_ANCHOR)}">${t("committee_shared_collapse")}</a></p>
      <ul class="node-record-list committee-shared-list">${disclosed.map((row) => sharedCommitteeMarkup(row, view, options)).join("")}</ul>
    </div>`
    : "";
  const vintage = view.vintage ? String(view.vintage).slice(0, 10) : view.as_of;
  return `<div class="committee-shared-membership" data-committee-shared-membership="1" data-shared-schema="${escape(view.schema)}" data-shared-state="${escape(view.state)}" data-shared-as-of="${escape(view.as_of)}" data-shared-committee-count="${view.committee_count}" data-shared-subject-members="${view.subject_member_count}" data-shared-represented-officials="${view.represented_official_count}" data-shared-excluded-caucus-bodies="${view.excluded_caucus_body_count}">
    <p class="committee-shared-summary">${tc("committee_shared_summary", view.committee_count, { date: escape(view.as_of) })}</p>
    <p class="node-muted committee-shared-basis">${t("committee_shared_basis", { vintage: escape(vintage) })}</p>
    <ul class="node-record-list committee-shared-list">${visible.map((row) => sharedCommitteeMarkup(row, view, options)).join("")}</ul>
    ${overflow}
  </div>`;
}
