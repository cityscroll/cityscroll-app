/**
 * Pure exact-continuation capability.
 *
 * A scope that can be serialized is not necessarily safe to publish as a
 * continuation. This adapter proves the stronger contract: accepted subject
 * relation, lossless Following reopen, both real compilers, and exact subject
 * identity in each downstream delivery proof. It never fetches or mutates.
 */

import {
  normalizeScope,
  scopeFromWatch,
  subscriptionParamsFromWatch,
  subscriptionWatchFromScope,
} from "../../../site/scope_v0.mjs";
import { watchFromFollowingParams } from "../../../site/following_view.mjs";
import { sanitize } from "./filter.mjs";
import { compileSub } from "./compile.mjs";
import { compileSub_d1 } from "./compile_d1.mjs";

export const CONTINUATION_REPLAY_SCHEMA = "cityscroll.continuation_replay.v1";
export const EXACT_RELATION_METHOD = "exact_notice_membership";

const SUBJECT_REF = /^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/;
const NOTICE_REF = /^notice:([A-Za-z0-9][A-Za-z0-9_-]{0,80})$/;

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ref(value) {
  if (typeof value === "string") return value.trim() || null;
  if (!record(value)) return null;
  return String(value.ref || value.subject_ref || value.target_ref || value.id || "").trim() || null;
}

function compact(value) {
  const out = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item == null || item === "" || item === false) continue;
    if (Array.isArray(item) && item.length === 0) continue;
    out[key] = item;
  }
  return out;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function exactNoticeIds(candidate) {
  const members = candidate?.relation?.member_refs
    || candidate?.relation?.notice_refs
    || candidate?.relation?.members;
  if (!Array.isArray(members) || members.length === 0) return null;
  const ids = members.map((value) => {
    const match = NOTICE_REF.exec(ref(value) || "");
    return match?.[1] || null;
  });
  if (ids.some((id) => !id)) return null;
  return [...new Set(ids)].sort();
}

function acceptedRelation(subjectRef, continuationRef, candidate) {
  const relation = candidate?.relation;
  if (!record(relation)
      || relation.status !== "accepted"
      || relation.method !== EXACT_RELATION_METHOD
      || relation.from !== subjectRef
      || relation.to !== continuationRef
      || relation.lossy === true) return null;
  return exactNoticeIds(candidate);
}

function exactSubjectRefs(proof, key, subjectRef) {
  const refs = proof?.delivery?.[key] || proof?.[key];
  return Array.isArray(refs) && refs.length === 1 && refs[0] === subjectRef ? refs : null;
}

function reopenedSubjectRef(proof) {
  return proof?.following?.subject_ref
    || proof?.reopened_subject_ref
    || proof?.reopen?.subject_ref
    || null;
}

function exactCompilerMembership(soda, d1, requestIds) {
  const sodaWhere = String(soda?.params?.["$where"] || "");
  if (!requestIds.every((id) => sodaWhere.includes(`'${id}'`))) return false;
  if (!equal(d1?.opts?.requestIds, requestIds)) return false;
  return true;
}

/**
 * Return a serializable capability descriptor, or null when exact replay is
 * not proven. `subject` is the originating action subject; `candidate` is an
 * accepted continuation candidate with a scope and replay proof.
 */
export function continuationReplayForSubject(subject, candidate = {}, {
  todayISO = "2026-08-28",
} = {}) {
  if (!record(candidate) || candidate.kind !== "subject" || candidate.replayable !== true) return null;
  if (candidate.lossy === true || candidate.supported === false || candidate.subject_exists !== true) return null;

  const subjectRef = ref(subject);
  const continuationRef = ref(candidate.subject_ref);
  if (!subjectRef || !continuationRef || !SUBJECT_REF.test(subjectRef) || !SUBJECT_REF.test(continuationRef)) return null;

  const requestIds = acceptedRelation(subjectRef, continuationRef, candidate);
  const rawScope = record(candidate.scope) ? candidate.scope : null;
  if (!rawScope || rawScope.schema && rawScope.schema !== "cityscroll.scope") return null;
  const scope = normalizeScope(rawScope);
  const watch = subscriptionWatchFromScope(scope);
  if (watch.lens !== "rules" || !equal(watch.filter.request_ids, requestIds)) return null;

  // This catches fields that Following's sanitizer would drop, including a
  // tempting body/agency fallback added beside the exact member predicate.
  const sanitized = sanitize(watch.lens, watch.filter);
  if (!equal(compact(watch.filter), compact(sanitized))) return null;

  const params = subscriptionParamsFromWatch({ lens: watch.lens, filter: sanitized });
  const reopened = watchFromFollowingParams(params);
  const reopenedScope = scopeFromWatch({ lens: reopened.lens, filter: reopened.filter });
  if (!equal(scope, reopenedScope)) return null;

  const soda = compileSub({ lens: watch.lens, filter: sanitized }, todayISO);
  const d1 = compileSub_d1({ lens: watch.lens, filter: sanitized }, todayISO);
  if (!soda || !d1 || !exactCompilerMembership(soda, d1, requestIds)) return null;

  const proof = candidate.replay_proof || candidate.replay || {};
  if (reopenedSubjectRef(proof) !== continuationRef) return null;
  const sodaSubjects = exactSubjectRefs(proof, "soda_subject_refs", continuationRef);
  const d1Subjects = exactSubjectRefs(proof, "d1_subject_refs", continuationRef);
  if (!sodaSubjects || !d1Subjects) return null;

  return Object.freeze({
    schema: CONTINUATION_REPLAY_SCHEMA,
    kind: "subject",
    subject_ref: continuationRef,
    scope: Object.freeze(scope),
    watch: Object.freeze({ lens: watch.lens, filter: Object.freeze({ ...sanitized }) }),
    following: Object.freeze({ params: params.toString(), subject_ref: continuationRef }),
    delivery: Object.freeze({ soda_subject_refs: [...sodaSubjects], d1_subject_refs: [...d1Subjects] }),
    compilers: Object.freeze({
      soda: Object.freeze({ url: soda.url, params: { ...soda.params } }),
      d1: Object.freeze({ opts: { ...d1.opts, requestIds: [...d1.opts.requestIds] } }),
    }),
  });
}

/** Return only the exact canonical scope, preserving the null fail-closed API. */
export function continuationScopeForSubject(subject, candidate = {}, options = {}) {
  return continuationReplayForSubject(subject, candidate, options)?.scope || null;
}
