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
    const kind = String(subject.kind || subject.target_kind || "").trim();
    const kindAttr = kind ? ` data-pivot-target-kind="${escape(kind)}"` : "";
    const idAttr = subject.id ? ` data-pivot-target-id="${escape(subject.id)}"` : "";
    return `<a class="act primary notice-subject-link" href="${escape(subject.href)}" data-notice-subject-continuation="${escape(continuation)}" data-notice-subject-id="${escape(subject.id)}"${kindAttr}${idAttr} aria-label="${escape(accessible)}">${escape(subject.label)}</a>`;
  }).join("");
  return `<p class="notice-subject-links" data-notice-subject-count="${escape(String(list.length))}">${links}</p>`;
}

function finding(code, message, extra = {}) {
  return { code, message, ...extra };
}

function countedSubjects(lookup) {
  const byNotice = lookup?.by_notice && typeof lookup.by_notice === "object"
    ? lookup.by_notice
    : {};
  const noticeIds = Object.keys(byNotice);
  let subjectLinkCount = 0;
  for (const noticeId of noticeIds) {
    const rows = byNotice[noticeId];
    if (!Array.isArray(rows)) {
      return {
        noticeCount: noticeIds.length,
        subjectLinkCount: null,
        invalidNoticeId: noticeId,
      };
    }
    subjectLinkCount += rows.length;
  }
  return { noticeCount: noticeIds.length, subjectLinkCount, invalidNoticeId: null };
}

/**
 * Build/check detection for a stale or incoherent reverse-index projection.
 * Feeds a mismatched source fingerprint or broken counts and requires the
 * checker to refuse the artifact.
 */
export function checkNoticeProcurementSubjectsLookup(lookup, {
  expectedSourceModelFingerprint = undefined,
  expectedGeneratedAt = undefined,
  rebuildFromRows = undefined,
  manifestDescriptor = undefined,
} = {}) {
  const findings = [];
  if (!lookup || typeof lookup !== "object") {
    return {
      ok: false,
      findings: [finding("missing_lookup", "notice procurement subjects lookup is missing")],
    };
  }
  if (lookup.schema !== NOTICE_PROCUREMENT_SUBJECTS_SCHEMA) {
    findings.push(finding(
      "schema_mismatch",
      `lookup schema must be ${NOTICE_PROCUREMENT_SUBJECTS_SCHEMA}`,
      { actual: lookup.schema || null },
    ));
  }
  if (lookup.method !== NOTICE_PROCUREMENT_SUBJECTS_METHOD) {
    findings.push(finding(
      "method_mismatch",
      `lookup method must be ${NOTICE_PROCUREMENT_SUBJECTS_METHOD}`,
      { actual: lookup.method || null },
    ));
  }

  const counted = countedSubjects(lookup);
  if (counted.invalidNoticeId) {
    findings.push(finding(
      "incoherent_subjects",
      `by_notice[${counted.invalidNoticeId}] must be an array of subject links`,
    ));
  } else {
    if (lookup.counts?.notices !== counted.noticeCount) {
      findings.push(finding(
        "notice_count_mismatch",
        "lookup counts.notices must match the number of by_notice keys",
        { expected: counted.noticeCount, actual: lookup.counts?.notices ?? null },
      ));
    }
    if (lookup.counts?.subject_links !== counted.subjectLinkCount) {
      findings.push(finding(
        "subject_link_count_mismatch",
        "lookup counts.subject_links must match the total subject rows",
        { expected: counted.subjectLinkCount, actual: lookup.counts?.subject_links ?? null },
      ));
    }
  }

  if (expectedSourceModelFingerprint !== undefined
    && lookup.source_model_fingerprint !== expectedSourceModelFingerprint) {
    findings.push(finding(
      "source_fingerprint_mismatch",
      "lookup source_model_fingerprint does not match the shared read-model fingerprint",
      {
        expected: expectedSourceModelFingerprint,
        actual: lookup.source_model_fingerprint || null,
      },
    ));
  }

  if (expectedGeneratedAt !== undefined && lookup.generated_at !== expectedGeneratedAt) {
    findings.push(finding(
      "generated_at_mismatch",
      "lookup generated_at does not match the shared read-model vintage",
      { expected: expectedGeneratedAt, actual: lookup.generated_at || null },
    ));
  }

  if (manifestDescriptor && typeof manifestDescriptor === "object") {
    if (manifestDescriptor.schema !== NOTICE_PROCUREMENT_SUBJECTS_SCHEMA) {
      findings.push(finding(
        "manifest_schema_mismatch",
        `manifest notice_procurement_subjects.schema must be ${NOTICE_PROCUREMENT_SUBJECTS_SCHEMA}`,
        { actual: manifestDescriptor.schema || null },
      ));
    }
    if (manifestDescriptor.source_model_fingerprint !== lookup.source_model_fingerprint) {
      findings.push(finding(
        "manifest_fingerprint_mismatch",
        "manifest descriptor fingerprint must match the lookup fingerprint",
        {
          expected: lookup.source_model_fingerprint || null,
          actual: manifestDescriptor.source_model_fingerprint || null,
        },
      ));
    }
    if (manifestDescriptor.notice_count !== lookup.counts?.notices) {
      findings.push(finding(
        "manifest_notice_count_mismatch",
        "manifest notice_count must match lookup counts.notices",
        {
          expected: lookup.counts?.notices ?? null,
          actual: manifestDescriptor.notice_count ?? null,
        },
      ));
    }
    if (manifestDescriptor.subject_link_count !== lookup.counts?.subject_links) {
      findings.push(finding(
        "manifest_subject_link_count_mismatch",
        "manifest subject_link_count must match lookup counts.subject_links",
        {
          expected: lookup.counts?.subject_links ?? null,
          actual: manifestDescriptor.subject_link_count ?? null,
        },
      ));
    }
  }

  if (rebuildFromRows !== undefined) {
    const expected = buildNoticeProcurementSubjectsLookup(rebuildFromRows, {
      generatedAt: expectedGeneratedAt !== undefined ? expectedGeneratedAt : lookup.generated_at,
      sourceModelFingerprint: expectedSourceModelFingerprint !== undefined
        ? expectedSourceModelFingerprint
        : lookup.source_model_fingerprint,
    });
    if (JSON.stringify(expected.by_notice) !== JSON.stringify(lookup.by_notice || {})) {
      findings.push(finding(
        "projection_rebuild_mismatch",
        "lookup by_notice does not match a rebuild from the shared read-model rows",
      ));
    }
  }

  return { ok: findings.length === 0, findings };
}
