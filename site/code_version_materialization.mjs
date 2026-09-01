/**
 * Fail-closed materialization of source-stated code changes.
 *
 * A CodeChange is authoritative evidence that legislation instructed a
 * mutation. A CodeVersion is a derived result and is emitted only when both
 * the operative date and the exact text operation are safe to establish.
 */

export const CODE_VERSION_MATERIALIZATION_SCHEMA = "cityscroll.code_version_materialization.v1";
export const MATERIALIZATION_STATUSES = Object.freeze([
  "materialized", "partially_materialized", "unresolved",
]);
export const MATERIALIZATION_CONFIDENCE = Object.freeze(["high", "medium", "low", "unknown"]);

const ADMIN_CODE = "nyc-administrative-code";
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});
const NUMBER_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
});
const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const SHA256_INITIAL = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function clean(value, max = 50_000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function legalText(value, max = 50_000) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, max);
}

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
}

function validDate(value) {
  const match = clean(value, 40).match(ISO_DATE);
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[0]) return null;
  return match[0];
}

function addDays(value, days) {
  const date = validDate(value);
  if (!date || !Number.isInteger(days) || days < 0) return null;
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function dateFromWords(value) {
  const input = clean(value, 500);
  const match = input.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(\d{4})\b/i);
  if (!match) return null;
  return validDate(`${match[3]}-${String(MONTHS[match[1].toLowerCase()]).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`);
}

function dateFromText(value) {
  const input = clean(value, 2_000);
  const iso = input.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  return validDate(iso) || dateFromWords(input);
}

function numberValue(value) {
  const text = clean(value, 40).toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);
  return NUMBER_WORDS[text] ?? null;
}

function effectiveDateClause(change, options) {
  const law = options?.local_law || {};
  const clauses = [
    ...(Array.isArray(change?.effective_date_clauses) ? change.effective_date_clauses : []),
    ...(Array.isArray(options?.effective_date_clauses) ? options.effective_date_clauses : []),
  ];
  if (clauses.length > 1) {
    return { effective_at: null, basis: "source_stated", resolution: "unresolved", reason: "multiple effective-date clauses require clause-level assignment" };
  }
  const candidates = [
    change?.effective_at,
    change?.effective_date,
    change?.effective_on,
    options?.effective_at,
    options?.effective_date,
    law.effective_at,
    law.effective_date,
    law.effective_on,
  ];
  for (const candidate of candidates) {
    const date = validDate(candidate);
    if (date) return { effective_at: date, basis: "source_stated", resolution: "resolved", reason: null };
  }
  if (clauses.length === 1) {
    const clause = clauses[0];
    const date = validDate(clause?.effective_at || clause?.date) || dateFromText(clause?.text);
    if (date) return { effective_at: date, basis: "source_stated_clause", resolution: "resolved", reason: null };
  }
  if (clauses.length > 1) {
    return { effective_at: null, basis: "source_stated", resolution: "unresolved", reason: "multiple effective-date clauses require clause-level assignment" };
  }

  const text = clean(change?.effective_date_text || options?.effective_date_text || law.effective_date_text, 2_000);
  if (!text) return { effective_at: null, basis: "unknown", resolution: "unresolved", reason: "no operative effective date" };
  const explicitDates = text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
  const namedDates = text.match(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?\s+\d{4}\b/gi) || [];
  if (explicitDates.length > 1 || namedDates.length > 1 || /\b(?:different|separate|respectively|each\s+provision)\b/i.test(text)) {
    return { effective_at: null, basis: "source_stated", resolution: "unresolved", reason: "effective dates are clause-specific" };
  }
  if (/\b(?:conditional|conditioned|upon|unless|subject to|if|except|provided that)\b/i.test(text)) {
    return { effective_at: null, basis: "source_stated", resolution: "unresolved", reason: "conditional effective date" };
  }
  const sourceDate = dateFromText(text);
  if (sourceDate) return { effective_at: sourceDate, basis: "source_stated_text", resolution: "resolved", reason: null };
  const delayed = text.match(/\b(\d+|[a-z]+)(?:\s+calendar)?\s+days?\s+after\s+(?:the\s+date\s+of\s+)?(?:it\s+)?(?:enactment|signing|passage|becoming\s+law|becomes\s+law)\b/i);
  if (delayed) {
    const base = validDate(options?.enacted_at || change?.enacted_at || options?.signed_at || change?.signed_at || law.enacted_at || law.signed_at);
    const days = numberValue(delayed[1]);
    const date = addDays(base, days);
    if (date) return { effective_at: date, basis: "source_stated_delayed", resolution: "resolved", reason: null };
    return { effective_at: null, basis: "source_stated_delayed", resolution: "unresolved", reason: "delayed effective date has no valid enactment base" };
  }
  if (/\b(?:takes?|take|shall\s+take)\s+effect\s+immediately\b|\beffective\s+immediately\b/i.test(text)) {
    const date = validDate(options?.enacted_at || change?.enacted_at || options?.signed_at || change?.signed_at || law.enacted_at || law.signed_at);
    if (date) return { effective_at: date, basis: "source_stated_immediate", resolution: "resolved", reason: null };
    return { effective_at: null, basis: "source_stated_immediate", resolution: "unresolved", reason: "immediate effective date has no valid enactment base" };
  }
  return { effective_at: null, basis: "source_stated", resolution: "unresolved", reason: "effective date text is not safely resolvable" };
}

export function resolveCodeChangeEffectiveDate(change = {}, options = {}) {
  return Object.freeze(effectiveDateClause(change, options));
}

function patchFor(change = {}) {
  const patch = change.patch || change.materialization_patch || {};
  const before = legalText(
    patch.before_text || patch.old_text || patch.before || change.before_text || change.old_text || change.before,
    50_000,
  ) || null;
  const after = legalText(
    patch.after_text || patch.new_text || patch.after || patch.replacement_text
      || change.after_text || change.new_text || change.after || change.replacement_text || change.added_text,
    50_000,
  ) || null;
  const scope = clean(patch.scope || patch.mode || change.patch_scope, 80) || null;
  return before || after ? { before_text: before, after_text: after, scope } : null;
}

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

// Keep the read-model module Web-API-safe: this synchronous SHA-256 implementation
// matches the content hashes produced by Node's crypto module without importing a
// Node built-in into the Worker graph. Inputs are bounded by legalText/clean callers.
function sha256(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15];
      const b = words[index - 2];
      const smallSigma0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const smallSigma1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16] + smallSigma0 + words[index - 7] + smallSigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + bigSigma1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function hash(value) {
  return `sha256:${sha256(value)}`;
}

function versionId(provisionId, validFrom, text) {
  return `code-version:${provisionId}:${validFrom || "unknown"}:${hash(text).slice(7, 23)}`;
}

function normalizeVersion(version, fallback = {}) {
  const text = String(version?.text ?? "");
  const provisionId = String(version?.provision_id || fallback.provision_id || "");
  return {
    schema: "cityscroll.code_version.v1",
    id: version?.id || versionId(provisionId, version?.valid_from, text),
    provision_id: provisionId,
    valid_from: validDate(version?.valid_from),
    valid_to: validDate(version?.valid_to),
    text,
    source_ref: clean(version?.source_ref || fallback.source_ref, 500) || null,
    observed_at: clean(version?.observed_at || fallback.observed_at, 80) || null,
    content_hash: clean(version?.content_hash, 120) || hash(text),
    status: clean(version?.status || fallback.status, 40) || "current",
    materialized_from_change_id: clean(version?.materialized_from_change_id, 500) || null,
    legal_instrument_id: clean(version?.legal_instrument_id, 240) || null,
  };
}

/** The shared CodeVersion record shape, including its content hash. */
export function codeVersionRecord(version, fallback = {}) {
  return freeze(normalizeVersion(version, fallback));
}

function provisionIdFor(change, provision) {
  return provision?.id || change?.target?.provision_id || null;
}

function initialVersions(provision, versions) {
  const provided = Array.isArray(versions) ? versions : [];
  if (provided.length) return provided.map((version) => normalizeVersion(version, { provision_id: provision?.id }));
  if (!provision?.id || (!provision.current_text && provision.status === "repealed")) return [];
  return [normalizeVersion({
    provision_id: provision.id,
    valid_from: provision.valid_from,
    text: provision.current_text,
    source_ref: provision.source?.source_ref || provision.source?.url,
    observed_at: provision.source?.observed_at,
    content_hash: provision.source?.content_hash,
    status: provision.status,
  })];
}

function versionCovers(version, asOf) {
  const from = validDate(version?.valid_from);
  const to = validDate(version?.valid_to);
  if (from && from > asOf) return false;
  if (to && to <= asOf) return false;
  return true;
}

function sortVersions(versions) {
  return [...versions].sort((left, right) => String(left.valid_from || "").localeCompare(String(right.valid_from || "")));
}

export function selectCodeVersionAt(versions = [], asOf = null) {
  const rows = (Array.isArray(versions) ? versions : []).filter((version) => version && version.provision_id);
  const dated = validDate(asOf);
  if (dated) {
    return sortVersions(rows.filter((version) => versionCovers(version, dated))).at(-1) || null;
  }
  return sortVersions(rows.filter((version) => !version.valid_to && !validDate(version.valid_from))).at(-1)
    || sortVersions(rows.filter((version) => !version.valid_to)).at(-1)
    || null;
}

function openVersionAt(versions, effectiveAt) {
  return sortVersions(versions.filter((version) => !version.valid_to && (!version.valid_from || !effectiveAt || version.valid_from <= effectiveAt))).at(-1) || null;
}

function changeWithStatus(change, status, confidence, materialization) {
  return freeze({
    ...change,
    ...(materialization?.effective_at ? { effective_at: materialization.effective_at } : {}),
    materialization_status: status,
    materialization_confidence: confidence,
    ...(materialization ? { materialization } : {}),
  });
}

function unresolved(change, date, reason, versions = [], provision = null) {
  const statusReason = date?.reason || reason;
  return freeze({
    schema: CODE_VERSION_MATERIALIZATION_SCHEMA,
    change: changeWithStatus(change, "unresolved", "unknown", {
      status: "unresolved",
      reason: statusReason,
      effective_at: date?.effective_at || null,
      effective_date_basis: date?.basis || "unknown",
    }),
    materialization_status: "unresolved",
    materialization_confidence: "unknown",
    effective_at: date?.effective_at || null,
    effective_date_basis: date?.basis || "unknown",
    reason: statusReason,
    versions: freeze(versions),
    provision: provision ? freeze(provision) : null,
    before_text: null,
    after_text: null,
    diff: null,
  });
}

function makeProvision(provision, change, text, status = "current") {
  if (provision) return {
    ...provision,
    status,
    current_text: text,
  };
  const target = change.target || {};
  if (target.corpus_id !== ADMIN_CODE || !target.provision_id || !target.citation) return null;
  return {
    schema: "cityscroll.code_provision.v1",
    id: target.provision_id,
    corpus_id: target.corpus_id,
    citation: target.citation,
    heading: target.heading || null,
    parent_id: null,
    level: "section",
    status,
    current_text: text,
    source: {
      url: change.source?.url || null,
      system: change.source?.source_system || null,
      source_ref: change.source?.source_ref || null,
      observed_at: change.source?.observed_at || null,
      content_hash: hash(text),
    },
    hierarchy: [],
  };
}

function replaceExact(text, before, after) {
  if (!before || after == null) return null;
  const occurrences = text.split(before).length - 1;
  if (occurrences !== 1) return null;
  return text.replace(before, after);
}

function codeVersionFor(provisionId, text, effectiveAt, change, context, status = "current") {
  return normalizeVersion({
    provision_id: provisionId,
    valid_from: effectiveAt,
    valid_to: null,
    text,
    source_ref: change.source?.source_ref || change.source?.url,
    observed_at: context.observed_at || change.source?.observed_at,
    content_hash: hash(text),
    status,
    materialized_from_change_id: change.id,
    legal_instrument_id: change.legal_instrument_id,
  });
}

function versionStatusAt(effectiveAt, asOf, operativeStatus = "current") {
  const dated = validDate(asOf);
  if (dated && effectiveAt && dated < effectiveAt) return "pending";
  return operativeStatus;
}

function closeVersion(version, effectiveAt, change, status = "superseded") {
  return normalizeVersion({
    ...version,
    valid_to: effectiveAt,
    status,
    source_ref: version.source_ref,
    observed_at: version.observed_at,
    content_hash: version.content_hash,
    materialized_from_change_id: version.materialized_from_change_id || null,
    legal_instrument_id: version.legal_instrument_id || change.legal_instrument_id || null,
  });
}

function deriveProvision(provision, change, versions, asOf, { repealed = false, effectiveAt = null } = {}) {
  const dated = validDate(asOf);
  if (repealed && dated && effectiveAt && dated >= effectiveAt) {
    return makeProvision(provision, change, "", "repealed");
  }
  const operative = selectCodeVersionAt(versions, dated);
  if (!dated) {
    return makeProvision(
      provision,
      change,
      provision?.current_text ?? "",
      provision?.status || "current",
    );
  }
  return makeProvision(
    provision,
    change,
    operative?.text ?? provision?.current_text ?? "",
    "current",
  );
}

export function readableCodeDiff(before, after) {
  const left = String(before ?? "").split("\n");
  const right = String(after ?? "").split("\n");
  if (left.join("\n") === right.join("\n")) return freeze({ format: "unified", text: "No textual difference.", lines: [] });
  const lines = [
    ...left.map((text) => ({ kind: "removed", text })),
    ...right.map((text) => ({ kind: "added", text })),
  ];
  return freeze({
    format: "unified",
    text: lines.map((line) => `${line.kind === "removed" ? "-" : "+"} ${line.text}`).join("\n"),
    lines,
  });
}

export function materializeCodeChange(change = {}, { provision = null, versions = [], ...context } = {}) {
  const date = effectiveDateClause(change, context);
  const existingVersions = initialVersions(provision, versions);
  if (change.state === "prospective" || (!change.legal_instrument_id && change.state !== "enacted")) {
    return unresolved(change, date, "prospective change is not current law", existingVersions, provision);
  }
  if (!date.effective_at) return unresolved(change, date, "operative date is unresolved", existingVersions, provision);
  const operation = clean(change.operation, 40).toLowerCase();
  const id = provisionIdFor(change, provision);
  if (!id || change.target?.corpus_id !== ADMIN_CODE) return unresolved(change, date, "target is not an ingested Administrative Code provision", existingVersions, provision);

  const asOf = validDate(context.as_of || context.now);
  const active = openVersionAt(existingVersions, date.effective_at);
  if (["amend", "repeal"].includes(operation) && !active) {
    return unresolved(change, date, "no active prior version is available", existingVersions, provision);
  }

  if (operation === "amend") {
    const patch = patchFor(change);
    if (!patch?.after_text) return unresolved(change, date, "amendment does not contain an exact before/after patch", existingVersions, provision);
    const after = patch.scope === "whole_provision"
      ? patch.after_text
      : patch.before_text ? replaceExact(active.text, patch.before_text, patch.after_text) : null;
    if (after == null) return unresolved(change, date, "before text is absent or ambiguous in the active version", existingVersions, provision);
    const closed = closeVersion(active, date.effective_at, change);
    const next = codeVersionFor(id, after, date.effective_at, change, context, versionStatusAt(date.effective_at, asOf));
    const nextVersions = existingVersions.filter((version) => version.id !== active.id).concat(closed, next);
    const materialization = {
      status: "materialized",
      effective_at: date.effective_at,
      effective_date_basis: date.basis,
      before_text: active.text,
      after_text: after,
      diff: readableCodeDiff(active.text, after),
      superseded_version_id: closed.id,
      version_id: next.id,
    };
    const updated = deriveProvision(provision, change, nextVersions, asOf, { effectiveAt: date.effective_at });
    return freeze({
      schema: CODE_VERSION_MATERIALIZATION_SCHEMA,
      change: changeWithStatus(change, "materialized", "high", materialization),
      materialization_status: "materialized",
      materialization_confidence: "high",
      effective_at: date.effective_at,
      effective_date_basis: date.basis,
      reason: null,
      versions: nextVersions,
      provision: updated,
      before_text: active.text,
      after_text: after,
      diff: materialization.diff,
    });
  }

  if (operation === "add") {
    const patch = patchFor(change);
    const after = patch?.after_text;
    if (!after) return unresolved(change, date, "addition does not contain text for the new provision", existingVersions, provision);
    if (provision && (provision.current_text || existingVersions.length)) return unresolved(change, date, "addition targets an already materialized provision", existingVersions, provision);
    const next = codeVersionFor(id, after, date.effective_at, change, context, versionStatusAt(date.effective_at, asOf));
    const nextVersions = [next];
    const updated = deriveProvision(null, change, nextVersions, asOf || date.effective_at, { effectiveAt: date.effective_at });
    const materialization = {
      status: "materialized",
      effective_at: date.effective_at,
      effective_date_basis: date.basis,
      before_text: null,
      after_text: after,
      diff: readableCodeDiff("", after),
      version_id: next.id,
    };
    return freeze({
      schema: CODE_VERSION_MATERIALIZATION_SCHEMA,
      change: changeWithStatus(change, "materialized", "high", materialization),
      materialization_status: "materialized",
      materialization_confidence: "high",
      effective_at: date.effective_at,
      effective_date_basis: date.basis,
      reason: null,
      versions: nextVersions,
      provision: updated,
      before_text: null,
      after_text: after,
      diff: materialization.diff,
    });
  }

  if (operation === "redesignate") {
    const redesignation = change.redesignation;
    if (!redesignation?.former_label && !redesignation?.successor_label && !redesignation?.successor_provision_id) {
      return unresolved(change, date, "redesignation is missing an explicit former or successor identity", existingVersions, provision);
    }
    const successorId = redesignation.successor_provision_id;
    const wholeProvisionMove = Boolean(successorId && successorId !== id);
    if (wholeProvisionMove && !active) {
      return unresolved(change, date, "no active prior version is available", existingVersions, provision);
    }
    if (wholeProvisionMove) {
      const closed = closeVersion(active, date.effective_at, change, "superseded");
      const inactive = codeVersionFor(
        id,
        "",
        date.effective_at,
        change,
        context,
        versionStatusAt(date.effective_at, asOf, "redesignated"),
      );
      const successor = codeVersionFor(
        successorId,
        active.text,
        date.effective_at,
        change,
        context,
        versionStatusAt(date.effective_at, asOf),
      );
      const nextVersions = existingVersions.filter((version) => version.id !== active.id).concat(closed, inactive);
      const successorProvision = deriveProvision(
        makeProvision(null, {
          ...change,
          target: {
            ...change.target,
            provision_id: successorId,
            citation: redesignation.successor_citation ? `§ ${redesignation.successor_citation}` : change.target.citation,
          },
        }, active.text, "current"),
        change,
        [successor],
        asOf || date.effective_at,
        { effectiveAt: date.effective_at },
      );
      const materialization = {
        status: "materialized",
        effective_at: date.effective_at,
        effective_date_basis: date.basis,
        before_text: active.text,
        after_text: active.text,
        diff: readableCodeDiff(active.text, active.text),
        superseded_version_id: closed.id,
        version_id: successor.id,
        redesignation,
      };
      const moved = Boolean(asOf && date.effective_at && asOf >= date.effective_at);
      const updated = deriveProvision(provision, change, nextVersions, asOf, {
        effectiveAt: date.effective_at,
      });
      return freeze({
        schema: CODE_VERSION_MATERIALIZATION_SCHEMA,
        change: changeWithStatus(change, "materialized", "high", materialization),
        materialization_status: "materialized",
        materialization_confidence: "high",
        effective_at: date.effective_at,
        effective_date_basis: date.basis,
        reason: null,
        versions: nextVersions,
        provision: updated && moved
          ? { ...updated, status: "redesignated", current_text: "" }
          : updated,
        successor_versions: [successor],
        successor_provision: successorProvision,
        before_text: active.text,
        after_text: active.text,
        diff: materialization.diff,
        redesignation,
      });
    }
    const materialization = {
      status: "materialized",
      effective_at: date.effective_at,
      effective_date_basis: date.basis,
      before_text: active?.text || provision?.current_text || null,
      after_text: active?.text || provision?.current_text || null,
      diff: null,
      redesignation,
    };
    return freeze({
      schema: CODE_VERSION_MATERIALIZATION_SCHEMA,
      change: changeWithStatus(change, "materialized", "high", materialization),
      materialization_status: "materialized",
      materialization_confidence: "high",
      effective_at: date.effective_at,
      effective_date_basis: date.basis,
      reason: null,
      versions: existingVersions,
      provision: deriveProvision(provision, change, existingVersions, asOf, { effectiveAt: date.effective_at }),
      before_text: materialization.before_text,
      after_text: materialization.after_text,
      diff: null,
      redesignation,
    });
  }

  if (operation === "repeal") {
    const closed = closeVersion(active, date.effective_at, change);
    const inactive = codeVersionFor(
      id,
      "",
      date.effective_at,
      change,
      context,
      versionStatusAt(date.effective_at, asOf, "repealed"),
    );
    const nextVersions = existingVersions.filter((version) => version.id !== active.id).concat(closed, inactive);
    const updated = deriveProvision(provision, change, nextVersions, asOf, {
      repealed: true,
      effectiveAt: date.effective_at,
    });
    const materialization = {
      status: "materialized",
      effective_at: date.effective_at,
      effective_date_basis: date.basis,
      before_text: active.text,
      after_text: null,
      diff: readableCodeDiff(active.text, ""),
      superseded_version_id: closed.id,
    };
    return freeze({
      schema: CODE_VERSION_MATERIALIZATION_SCHEMA,
      change: changeWithStatus(change, "materialized", "high", materialization),
      materialization_status: "materialized",
      materialization_confidence: "high",
      effective_at: date.effective_at,
      effective_date_basis: date.basis,
      reason: null,
      versions: nextVersions,
      provision: updated,
      before_text: active.text,
      after_text: null,
      diff: materialization.diff,
    });
  }

  return unresolved(change, date, `operation ${operation || "unknown"} is not safely materializable`, existingVersions, provision);
}

function values(input, key) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") return Object.values(input[key] || input);
  return [];
}

export function materializeCodeChanges(changes = [], { provisions = [], versions = [], ...context } = {}) {
  const provisionValues = values(provisions, "provisions").flatMap((value) => Array.isArray(value) ? value : [value]);
  const versionValues = values(versions, "versions").flatMap((value) => Array.isArray(value) ? value : [value]);
  const provisionMap = new Map(provisionValues.filter((row) => row?.id).map((row) => [row.id, row]));
  const versionsMap = new Map();
  for (const version of versionValues) {
    if (!version?.provision_id) continue;
    versionsMap.set(version.provision_id, [...(versionsMap.get(version.provision_id) || []), version]);
  }
  const results = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const id = provisionIdFor(change, null);
    const result = materializeCodeChange(change, {
      ...context,
      provision: provisionMap.get(id) || null,
      versions: versionsMap.get(id) || [],
    });
    results.push(result);
    if (result.materialization_status === "materialized" && result.provision?.id) {
      provisionMap.set(result.provision.id, result.provision);
      versionsMap.set(result.provision.id, result.versions);
    }
    if (result.materialization_status === "materialized" && result.successor_provision?.id) {
      provisionMap.set(result.successor_provision.id, result.successor_provision);
      versionsMap.set(result.successor_provision.id, result.successor_versions || []);
    }
  }
  const materialized = results.filter((result) => result.materialization_status === "materialized").length;
  return freeze({
    schema: CODE_VERSION_MATERIALIZATION_SCHEMA,
    changes: results.map((result) => result.change),
    results,
    provisions: Object.fromEntries(provisionMap),
    versions: Object.fromEntries(versionsMap),
    coverage: {
      changes: results.length,
      materialized,
      unresolved: results.length - materialized,
    },
  });
}

export const materializeLegalChange = materializeCodeChange;
export const materializeCodeVersion = materializeCodeChange;
export const resolveEffectiveDate = resolveCodeChangeEffectiveDate;
