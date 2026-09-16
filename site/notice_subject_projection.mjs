/**
 * Reverse projection from an accepted City Record notice to its procurement
 * subjects. Built offline from compatibility.city_record_notice_hrefs; the
 * reader path only looks up already-accepted identities.
 */

import {
  NOTICE_OBJECT_LINK_SCHEMA,
  noticeEvidenceTarget,
  projectNoticeObjectTarget,
} from "./notice_object_links.mjs";
import { procurementCanonicalHref } from "./procurement_route.mjs";

export const NOTICE_PROCUREMENT_SUBJECTS_SCHEMA = "cityscroll.notice_procurement_subjects.v1";
export const NOTICE_PROCUREMENT_SUBJECTS_METHOD = "compatibility.city_record_notice_hrefs";
export const NOTICE_PROCUREMENT_SUBJECTS_LOOKUP_PATH = "data/notice_procurement_subjects_lookup.json";
export const NOTICE_SUBJECT_VIEW_CONTRACT_LABEL = "View contract";
export const NOTICE_SUBJECT_SEARCH_CONTINUATION = "search";
export const NOTICE_SUBJECT_CANONICAL_CONTINUATION = "canonical";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function noticeIdFromValue(value) {
  const raw = clean(value, 120);
  if (!raw) return null;
  const fromHref = raw.match(/\/notices\/([A-Za-z0-9_-]{1,80})\/?$/i);
  const id = (fromHref?.[1] || raw.replace(/^notice:/i, "")).trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

function safeCanonicalHref(value) {
  const href = clean(value, 500);
  if (!href || href.startsWith("//")) return null;
  return href.startsWith("/") || /^https:\/\//i.test(href) ? href : null;
}

function subjectSortKey(subject) {
  return `${subject.procurement_id}\0${subject.href}`;
}

/**
 * Invert accepted procurement → notice compatibility hrefs into a bounded
 * by-notice lookup. Arrays are retained so one notice can name many subjects.
 */
export function buildNoticeProcurementSubjectsLookup(rows = [], {
  generatedAt = null,
  sourceModelFingerprint = null,
} = {}) {
  const byNotice = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const procurementId = clean(row?.procurement_id, 240);
    if (!procurementId) continue;
    const href = safeCanonicalHref(
      row?.compatibility?.canonical_href || procurementCanonicalHref(procurementId),
    );
    if (!href) continue;
    const noticeHrefs = Array.isArray(row?.compatibility?.city_record_notice_hrefs)
      ? row.compatibility.city_record_notice_hrefs
      : [];
    for (const noticeHref of noticeHrefs) {
      const noticeId = noticeIdFromValue(noticeHref);
      if (!noticeId) continue;
      const list = byNotice.get(noticeId) || [];
      if (list.some((entry) => entry.procurement_id === procurementId && entry.href === href)) {
        continue;
      }
      list.push(Object.freeze({
        procurement_id: procurementId,
        href,
        relation_basis: NOTICE_PROCUREMENT_SUBJECTS_METHOD,
      }));
      byNotice.set(noticeId, list);
    }
  }

  const by_notice = Object.fromEntries(
    [...byNotice.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([noticeId, subjects]) => [
        noticeId,
        Object.freeze(
          [...subjects].sort((left, right) => subjectSortKey(left).localeCompare(subjectSortKey(right))),
        ),
      ]),
  );
  const subjectLinkCount = Object.values(by_notice)
    .reduce((sum, subjects) => sum + subjects.length, 0);
  return Object.freeze({
    schema: NOTICE_PROCUREMENT_SUBJECTS_SCHEMA,
    version: 1,
    generated_at: generatedAt || null,
    method: NOTICE_PROCUREMENT_SUBJECTS_METHOD,
    source_model_fingerprint: sourceModelFingerprint || null,
    counts: Object.freeze({
      notices: Object.keys(by_notice).length,
      subject_links: subjectLinkCount,
    }),
    by_notice: Object.freeze(by_notice),
  });
}

/** Public-safe subjects for one notice id. Missing lookup or id → []. */
export function noticeProcurementSubjectsForId(lookup, noticeId) {
  const id = noticeIdFromValue(noticeId);
  if (!id || !lookup || typeof lookup !== "object") return [];
  const rows = lookup.by_notice?.[id];
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows
    .map((row) => {
      const procurementId = clean(row?.procurement_id, 240);
      const href = safeCanonicalHref(row?.href || procurementCanonicalHref(procurementId));
      if (!procurementId || !href) return null;
      return {
        procurement_id: procurementId,
        href,
        relation_basis: clean(row?.relation_basis, 120) || NOTICE_PROCUREMENT_SUBJECTS_METHOD,
      };
    })
    .filter(Boolean);
}

function canonicalSubjectTarget(subject) {
  return {
    kind: "procurement",
    id: subject.procurement_id,
    href: subject.href,
    label: NOTICE_SUBJECT_VIEW_CONTRACT_LABEL,
    continuation: NOTICE_SUBJECT_CANONICAL_CONTINUATION,
    relation_basis: subject.relation_basis,
  };
}

function legacySubjectTarget(target) {
  if (!target || typeof target !== "object") return null;
  const href = safeCanonicalHref(target.href);
  const id = clean(target.id, 240);
  if (!href || !id) return null;
  const isSearch = href.includes("/browse/contracts/");
  return {
    kind: clean(target.kind, 80) || "procurement",
    id,
    href,
    label: clean(target.label, 240) || (isSearch ? `Contract award · ${id}` : NOTICE_SUBJECT_VIEW_CONTRACT_LABEL),
    continuation: isSearch
      ? NOTICE_SUBJECT_SEARCH_CONTINUATION
      : NOTICE_SUBJECT_CANONICAL_CONTINUATION,
    relation_basis: isSearch ? "notice_object_links.public_comment_search" : null,
  };
}

/**
 * Project the notice's subject links. Accepted reverse-index hits become
 * canonical "View contract" destinations. Public-comment search targets remain
 * labeled as searches. Multiple accepted subjects stay explicit — there is no
 * automatic first-target choice or redirect.
 */
export function projectNoticeSubjectLinks(row = {}, {
  subjectsLookup = null,
  mandate = null,
} = {}) {
  const evidence = noticeEvidenceTarget(
    row.request_id || row.requestId || row.notice_id || row.subject_ref,
  );
  if (!evidence) {
    return {
      schema: NOTICE_OBJECT_LINK_SCHEMA,
      state: "unknown",
      target: null,
      subjects: [],
      evidence: null,
    };
  }

  const accepted = noticeProcurementSubjectsForId(subjectsLookup, evidence.id)
    .map(canonicalSubjectTarget);
  if (accepted.length) {
    return {
      schema: NOTICE_OBJECT_LINK_SCHEMA,
      state: "matched",
      // A3: only expose a singular target when exactly one subject is accepted.
      target: accepted.length === 1 ? accepted[0] : null,
      subjects: accepted,
      evidence,
    };
  }

  const legacy = projectNoticeObjectTarget(row, { mandate });
  const subjects = legacy.target && legacy.target.kind !== "notice"
    ? [legacySubjectTarget(legacy.target)].filter(Boolean)
    : [];
  return {
    schema: NOTICE_OBJECT_LINK_SCHEMA,
    state: legacy.state,
    target: subjects.length === 1 ? subjects[0] : legacy.target,
    subjects,
    evidence: legacy.evidence || evidence,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render explicit subject continuation links for edge and client templates. */
export function renderNoticeSubjectLinksHtml(subjects = [], { escape = escapeHtml } = {}) {
  const list = Array.isArray(subjects) ? subjects.filter((subject) => subject?.href && subject?.label) : [];
  if (!list.length) return "";
  const links = list.map((subject) => {
    const continuation = subject.continuation === NOTICE_SUBJECT_SEARCH_CONTINUATION
      ? NOTICE_SUBJECT_SEARCH_CONTINUATION
      : NOTICE_SUBJECT_CANONICAL_CONTINUATION;
    const accessible = continuation === NOTICE_SUBJECT_SEARCH_CONTINUATION
      ? subject.label
      : list.length > 1
        ? `${subject.label}: ${subject.id}`
        : subject.label;
    return `<a class="act primary notice-subject-link" href="${escape(subject.href)}" data-notice-subject-continuation="${escape(continuation)}" data-notice-subject-id="${escape(subject.id)}" aria-label="${escape(accessible)}">${escape(subject.label)}</a>`;
  }).join("");
  return `<p class="notice-subject-links" data-notice-subject-count="${escape(String(list.length))}">${links}</p>`;
}
