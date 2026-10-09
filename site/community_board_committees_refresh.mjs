/**
 * Refresh helpers for the reviewed Community Board committee registry.
 *
 * Identity stays reviewed and board-local. Refresh re-fetches the official
 * committee directory pages and restamps only records still evidenced by an
 * exact publisher name or reviewed alias on the page.
 */

import {
  COMMUNITY_BOARD_COMMITTEE_REGISTRY_SCHEMA,
  normalizeCommunityBoardCommitteeLabel,
  normalizeCommunityBoardCommitteeRegistry,
} from "./community_board_committees.mjs";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

export const DEFAULT_COMMITTEE_SOURCE_URLS = Object.freeze({
  "manhattan-cb-06": "https://cbsix.org/committees/",
  "brooklyn-cb-01": "https://www.nyc.gov/site/brooklyncb1/committees/committees.page",
});

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

/** Strip tags and collapse whitespace for exact label evidence checks. */
export function htmlToSearchText(html) {
  return clean(decodeEntities(String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")), 2_000_000);
}

function evidenceLabels(record) {
  const labels = [
    record.publisher_name,
    ...(Array.isArray(record.aliases) ? record.aliases : []),
  ]
    .map((label) => normalizeCommunityBoardCommitteeLabel(label))
    .filter(Boolean);
  // Directory pages often publish the short committee title without the
  // trailing "Committee" word retained in the reviewed publisher_name.
  if (record.committee_id) {
    labels.push(normalizeCommunityBoardCommitteeLabel(record.committee_id.replace(/-/g, " ")));
  }
  return [...new Set(labels)];
}

function normalizeEvidenceHaystack(value) {
  // Full-page haystacks must not use the short label cleaner (300-char ceiling).
  return clean(value, 2_000_000)
    .normalize("NFKC")
    .replace(/[\u2013\u2014]/g, "-")
    .toLowerCase();
}

export function pageEvidencesCommittee(html, record) {
  const haystack = normalizeEvidenceHaystack(htmlToSearchText(html));
  if (!haystack) return false;
  return evidenceLabels(record).some((label) => haystack.includes(label));
}

/**
 * Confirm each reviewed committee against its board capture and restamp
 * observed_on. Missing evidence fails closed so the last-known-good artifact
 * remains in place for the refresh runner.
 */
export function buildCommunityBoardCommitteesFromCaptures({
  priorRegistry,
  capturesByBoard = {},
  observedAt,
  sourceUrls = DEFAULT_COMMITTEE_SOURCE_URLS,
} = {}) {
  const observedInstant = clean(observedAt, 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(observedInstant)) {
    throw new Error("buildCommunityBoardCommitteesFromCaptures requires an ISO observedAt");
  }
  const observedOn = observedInstant.slice(0, 10);
  const prior = normalizeCommunityBoardCommitteeRegistry(priorRegistry);
  if (!prior.length) {
    throw new Error("committee refresh requires a non-empty reviewed prior registry");
  }

  const committees = [];
  const missing = [];
  for (const record of prior) {
    const html = capturesByBoard[record.board_id];
    if (!html) {
      missing.push(`${record.board_id}:${record.committee_id} (no capture)`);
      continue;
    }
    if (!pageEvidencesCommittee(html, record)) {
      missing.push(`${record.board_id}:${record.committee_id}`);
      continue;
    }
    const sourceUrl = sourceUrls[record.board_id] || record.source_url;
    committees.push({
      ...record,
      source_url: sourceUrl,
      observed_on: observedOn,
    });
  }

  if (missing.length) {
    throw new Error(`committee capture missing required evidence: ${missing.join(", ")}`);
  }

  return {
    schema: COMMUNITY_BOARD_COMMITTEE_REGISTRY_SCHEMA,
    version: Number(priorRegistry?.version) || 1,
    observed_on: observedOn,
    policy: priorRegistry?.policy || {
      identity: "community-board-committee:{board_id}:{committee_id}",
      board_local: true,
      publisher_name_and_aliases_are_exact: true,
      topic_facets_are_for_discovery_only: true,
      no_citywide_committee_identity: true,
    },
    committees,
  };
}
