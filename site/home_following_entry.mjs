/**
 * Homepage email-updates entry into the canonical Following builder.
 *
 * Generic: `/following/?onboarding=1`.
 * Validated topic / place / agency / record: the ordinary Following scope URL.
 * Invalid or absent context: the same generic onboarding href.
 * Never collects email, posts /subscribe, or invents a topicless watch.
 */

import { scopeFromWatch, watchFromScope } from "./scope_v0.mjs";
import {
  cleanFollowingFocusId,
  followingPreviewHandoffFromScope,
  reviewedFollowingLens,
} from "./following_preview_handoff.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";

export const HOME_FOLLOWING_ONBOARDING_HREF = "/following/?onboarding=1";

const CONTEXT_FILTER_KEYS = Object.freeze([
  "keywords", "q", "agency", "borough", "boro", "neighborhood",
  "communityBoard", "communityDistrict", "councilDistrict", "council",
  "noticeType", "asset", "saleMethod", "priceBand", "process", "stage",
  "locationScope", "name", "minAmount", "family", "futureAction",
  "when", "dateWindow",
]);

function presentValue(value) {
  if (value == null || value === "" || value === false) return false;
  if (Array.isArray(value)) return value.some((item) => presentValue(item));
  if (typeof value === "object") return Object.values(value).some(presentValue);
  return true;
}

function hasValidatedFilter(filter) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return false;
  for (const key of CONTEXT_FILTER_KEYS) {
    if (presentValue(filter[key])) return true;
  }
  if (presentValue(filter.entity_refs_all) || presentValue(filter.subject_refs_all)) return true;
  return false;
}

function hasValidatedRecord(context) {
  return Boolean(cleanFollowingFocusId(context?.noticeId) || cleanFollowingFocusId(context?.projectId));
}

function hasValidatedContext(context) {
  return hasValidatedFilter(context?.filter) || hasValidatedRecord(context);
}

/**
 * Destination for the front-page “Want email updates on this?” affordance.
 * @param {object} [context]
 * @param {object} [options]
 * @returns {string}
 */
export function homeFollowingEntryHref(context = {}, options = {}) {
  const input = context && typeof context === "object" && !Array.isArray(context) ? context : {};
  if (!hasValidatedContext(input)) return HOME_FOLLOWING_ONBOARDING_HREF;

  const reviewed = reviewedFollowingLens(input.lens);
  if (reviewed.status !== "ok") return HOME_FOLLOWING_ONBOARDING_HREF;

  const language = options.language || input.language || "en";
  const filter = watchFromScope(scopeFromWatch({
    lens: reviewed.lens,
    filter: input.filter || {},
  }, { language })).filter;
  const noticeId = options.noticeId ?? input.noticeId;
  const projectId = options.projectId ?? input.projectId;
  const originRoute = options.originRoute ?? input.originRoute;
  const matchCount = options.matchCount ?? input.matchCount;
  const frequency = options.frequency ?? options.freq ?? input.freq ?? input.frequency;
  const handoff = followingPreviewHandoffFromScope({
    lens: reviewed.lens,
    filter,
    noticeId,
    projectId,
    originRoute,
    matchCount,
    freq: frequency,
  });
  if (handoff.status !== "ok") return HOME_FOLLOWING_ONBOARDING_HREF;

  const href = followingUrlFromWatch({
    lens: handoff.lens,
    filter: handoff.filter,
    freq: handoff.frequency,
    matchCount: handoff.matchCount,
    noticeId: handoff.focus?.kind === "notice" ? handoff.focus.id : null,
    projectId: handoff.focus?.kind === "project" ? handoff.focus.id : null,
    originRoute: handoff.originRoute,
  }, {
    frequency,
    matchCount: handoff.matchCount,
    noticeId: handoff.focus?.kind === "notice" ? handoff.focus.id : null,
    projectId: handoff.focus?.kind === "project" ? handoff.focus.id : null,
    originRoute: handoff.originRoute,
    emptyBase: HOME_FOLLOWING_ONBOARDING_HREF,
  });
  if (!href || href === "/following/" || href === "/following") return HOME_FOLLOWING_ONBOARDING_HREF;
  if (/[?&]email=/i.test(href)) return HOME_FOLLOWING_ONBOARDING_HREF;
  return href;
}

export function isHomeFollowingOnboardingHref(href) {
  try {
    const url = new URL(String(href || ""), "https://cityscroll.org");
    if (!/^\/following\/?$/.test(url.pathname)) return false;
    return url.searchParams.get("onboarding") === "1";
  } catch {
    return false;
  }
}
