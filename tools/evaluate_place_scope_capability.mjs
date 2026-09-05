/**
 * PS-07: grades place-scoped discovery as a measured capability contract rather than a
 * claim that a filter control exists. See
 * cityscroll-capability-spine/ps-07-place-scope-capability.
 *
 * The prior interface cards (PS-02 Near You role control, PS-03 Following preservation,
 * PS-04 evidence tiers, PS-05 typed geography relations, PS-06 contract fixtures) each
 * proved one surface behaves correctly. This module is the first place that asks the
 * capstone question: does the SAME place-role meaning survive across all of them for a
 * given domain, end to end? A domain only earns a grade by actually exercising the real
 * retrieval, round-trip, and Following functions against evidence -- never by a surface
 * merely rendering a place-scope control.
 *
 * G1: knowing WHERE a record is (administrative-place retrieval) is graded separately from
 * knowing WHY a place is relevant (the venue/matter/affected_area place-role predicate).
 * Passing the first never satisfies the second.
 */

import { PLACE_ROLES } from "../site/scope_v0.mjs";

export const PLACE_SCOPE_CAPABILITY_SCHEMA = "cityscroll.place_scope_capability_evaluation.v1";

/** The three-rung ladder the card requires. A domain that claims no place-role support at
 * all (site/scope_v0.mjs PLACE_ROLE_SUPPORTED_DOMAINS) is graded "not_applicable" instead --
 * it never occupies a ladder rung, so it can never be miscounted as "built". A domain that
 * claims support (a control renders, a filter field is wired) but whose retrieval does not
 * actually apply the predicate is graded "not_built" for the same reason (PS-07 A2): a
 * rendered control is not evidence of a delivered predicate. */
export const PLACE_SCOPE_CAPABILITY_LADDER = Object.freeze(["built", "partial", "complete"]);
export const PLACE_SCOPE_CAPABILITY_GRADES = Object.freeze([
  "not_applicable",
  "not_built",
  ...PLACE_SCOPE_CAPABILITY_LADDER,
]);

/**
 * G2 / A2: administrative-place retrieval correctness -- can the domain find the records
 * actually located in the requested place, and only those. This is the "built" floor and
 * is evaluated purely on the retrieval result, independent of place-role meaning.
 */
export function evaluatePlaceRetrieval({
  selectExplanationPath,
  population,
  place,
  expectedSubject,
  excludedNoticeHrefs = [],
}) {
  const match = selectExplanationPath(population, { place });
  const correct = !!match
    && match.location?.subject_ref === expectedSubject
    && !excludedNoticeHrefs.includes(match.notice_href);
  return {
    correct,
    matched_notice_href: match?.notice_href ?? null,
    reason: correct ? null : "administrative-place retrieval did not resolve to the requested subject",
  };
}

/**
 * G1 / A1 / A3: does the place-role relationship (venue / matter / affected_area) survive
 * as a DISTINCT meaning, or does it collapse into "just the location"? Each requested role
 * must resolve to its own evidenced record; two roles resolving to the same record, or a
 * role resolving to the wrong record, is a collapse.
 */
export function evaluateRelevanceMeaning({
  selectExplanationPath,
  population,
  place,
  expectedHrefByRole,
  roles = PLACE_ROLES,
}) {
  const resolved = {};
  const reasons = [];
  const seenHrefs = new Map();
  for (const role of roles) {
    const match = selectExplanationPath(population, { place, facets: { values: { place_role: role } } });
    const href = match?.notice_href ?? null;
    resolved[role] = href;
    if (href !== (expectedHrefByRole[role] ?? null)) {
      reasons.push(`${role}: resolved ${href ?? "nothing"}, expected ${expectedHrefByRole[role] ?? "nothing"}`);
    }
    if (href) {
      const priorRole = seenHrefs.get(href);
      if (priorRole && priorRole !== role) reasons.push(`${role} collapsed onto the same record as ${priorRole}`);
      seenHrefs.set(href, role);
    }
  }
  return { distinguished: reasons.length === 0, resolved, reasons };
}

/**
 * A3: the place-role predicate must survive discovery -> refinement (role change) -> view
 * change -> round trip, not merely the geography. Reuses the exact scope/watch/Following
 * wire functions every surface calls -- this never re-derives a parallel notion of "same".
 */
export function evaluateRoundTrip({
  scopes,
  placeRoleFromScope,
  routeHashFromScope,
  scopeFromRouteHash,
  nearYouUrlFromScope,
  scopeFromNearYouUrl,
  watchFromScope,
  scopeFromWatch,
  followingUrlFromWatch,
  watchFromFollowingParams,
  surfaces = ["meetings", "now", "map"],
}) {
  let failures = 0;
  const detail = [];
  const fail = (label) => {
    failures += 1;
    detail.push(label);
  };
  for (const scope of scopes) {
    const expectedRole = placeRoleFromScope(scope);
    const lens = scope.facets.domains[0];

    for (const surface of surfaces) {
      const hash = routeHashFromScope(scope, { surface });
      const replay = scopeFromRouteHash(hash);
      if (placeRoleFromScope(replay) !== expectedRole) fail(`route-hash/${surface}`);
    }

    const nearYouUrl = nearYouUrlFromScope(scope, { base: "https://cityscroll.org/near-you" });
    const backToNearYou = scopeFromNearYouUrl(nearYouUrl);
    if (placeRoleFromScope(backToNearYou) !== expectedRole) fail("near-you-url");

    const watch = watchFromScope(scope, { lens });
    const reopenedFromWatch = scopeFromWatch(watch, { lens });
    if (placeRoleFromScope(reopenedFromWatch) !== expectedRole) fail("watch");

    const followingHref = followingUrlFromWatch(watch, { matchCount: 1 });
    const previewedWatch = watchFromFollowingParams(new URL(followingHref).searchParams);
    const reopenedFromFollowing = scopeFromWatch(previewedWatch, { lens: previewedWatch.lens });
    if (placeRoleFromScope(reopenedFromFollowing) !== expectedRole) fail("following-round-trip");
  }
  return { failures, detail };
}

/**
 * A3: a saved Following watch must evaluate against future records the same way it was
 * described when saved -- a venue-only watch must never fire on affected-area-only
 * evidence and vice versa (disagreement between the predicate and its evaluation is a
 * regression, not a nuance). `matchesLocation` is the real retrieval predicate
 * (worker/src/lib/hearings.mjs hearingMatchesLocation); `records` supplies one fixture per
 * evidenced role the Following evaluator actually distinguishes. The Following evaluator
 * only ever discriminates venue vs. not-venue (matter and affected_area share evidence at
 * this layer -- see worker/src/lib/hearings.mjs areaForPlaceRole) so "matter" is
 * deliberately not asserted as separately distinguishable here.
 */
export function evaluateFollowingCorrectness({
  matchesLocation,
  records,
  roles = ["venue", "affected_area"],
}) {
  const disagreements = [];
  for (const { key, record, ownRole, filterBase = {} } of records) {
    for (const role of roles) {
      const matched = matchesLocation(record, { ...filterBase, place_role: role });
      const expected = role === ownRole;
      if (matched !== expected) disagreements.push(`${key}: place_role=${role} matched=${matched}, expected=${expected}`);
    }
  }
  return { holds: disagreements.length === 0, disagreements };
}

/**
 * A3: the explanation shown for a match must agree with the predicate that caused it
 * (the returned place_role and evidence tier), and a weak evidence tier must never
 * produce a confident exact-place explanation (never inflate weak inference into exact
 * local relevance).
 */
export function evaluateExplanationConsistency({
  selectExplanationPath,
  population,
  place,
  roles = PLACE_ROLES,
  weakPopulation = [],
}) {
  const reasons = [];
  for (const role of roles) {
    const match = selectExplanationPath(population, { place, facets: { values: { place_role: role } } });
    if (match && (match.location?.place_role !== role || !match.location?.tier)) {
      reasons.push(`${role}: explanation role/evidence tier does not agree with the matched predicate`);
    }
  }
  if (weakPopulation.length) {
    const weakEscaped = selectExplanationPath(weakPopulation, { place });
    if (weakEscaped) reasons.push("weak evidence produced a confident exact-place explanation");
  }
  return { consistent: reasons.length === 0, reasons };
}

/**
 * A2 / A3 / A4: the single grading gate. Built means retrieval alone is correct; complete
 * additionally requires relevance meaning, round trip, Following, and explanation
 * correctness all hold. `failing_surface` always names which one broke (A4) -- the caller
 * never has to re-derive that from a boolean.
 */
export function gradePlaceScopeDomain({
  domain,
  claimsPlaceRole,
  locationRetrieval,
  relevanceMeaning,
  roundTrip,
  followingCorrectness,
  explanationConsistency,
}) {
  if (!claimsPlaceRole) {
    return {
      domain, grade: "not_applicable", failing_surface: null,
      reason: "domain declares no evidenced place-role distinction (site/scope_v0.mjs PLACE_ROLE_SUPPORTED_DOMAINS)",
    };
  }
  if (!locationRetrieval?.correct) {
    return {
      domain, grade: "not_built", failing_surface: `${domain}/retrieval`,
      reason: locationRetrieval?.reason || "administrative-place retrieval is not correct",
    };
  }
  if (!relevanceMeaning?.distinguished) {
    return {
      domain, grade: "partial", failing_surface: `${domain}/place-role-meaning`,
      reason: `place filtering works but relationship meaning is collapsed or lost: ${relevanceMeaning?.reasons?.join("; ") || "unknown"}`,
    };
  }
  if ((roundTrip?.failures ?? 0) > 0) {
    return {
      domain, grade: "partial", failing_surface: `${domain}/round-trip`,
      reason: `place-role scope did not survive ${roundTrip.failures} discover/refine/view-change round trip(s): ${roundTrip.detail.join(", ")}`,
    };
  }
  if (!followingCorrectness?.holds) {
    return {
      domain, grade: "partial", failing_surface: `${domain}/following`,
      reason: `a saved Following watch disagreed with the place-role predicate it was saved with: ${followingCorrectness?.disagreements?.join("; ") || "unknown"}`,
    };
  }
  if (!explanationConsistency?.consistent) {
    return {
      domain, grade: "partial", failing_surface: `${domain}/explanation`,
      reason: `the rendered explanation did not agree with the predicate and evidence that caused the match: ${explanationConsistency?.reasons?.join("; ") || "unknown"}`,
    };
  }
  return { domain, grade: "complete", failing_surface: null, reason: null };
}

/** Grade every supplied domain and roll the result up, still naming every failing surface (A4). */
export function evaluatePlaceScopeCapability(domainSignals = []) {
  const domains = domainSignals.map(gradePlaceScopeDomain);
  const failingDomains = domains
    .filter((entry) => entry.grade === "partial" || entry.grade === "not_built")
    .map((entry) => entry.failing_surface);
  const overallGrade = domains.some((entry) => entry.grade === "not_built") ? "not_built"
    : domains.some((entry) => entry.grade === "partial") ? "partial"
    : domains.some((entry) => entry.grade === "complete") ? "complete"
    : "not_applicable";
  return {
    schema: PLACE_SCOPE_CAPABILITY_SCHEMA,
    ladder: PLACE_SCOPE_CAPABILITY_LADDER,
    domains,
    failing_domains: failingDomains,
    overall_grade: overallGrade,
  };
}
