/**
 * Restore PASSPort Public title, procurement_method, program, and industry.
 *
 * The public dump already parses these fields. The committed spine historically
 * kept identity, vendor, agency, amounts, and dates only. This module copies
 * the four publisher fields onto spine / observation snapshots after a quality
 * gate. It does not invent scope, line-item pricing, deliverables, or place of
 * performance — those columns are not in the public dump.
 */

export const PASSPORT_PUBLIC_FIELD_NAMES = Object.freeze([
  "title",
  "procurement_method",
  "program",
  "industry",
]);

const PLACEHOLDERS = new Set([
  "N/A", "NA", "NULL", "NONE", "UNKNOWN", "TEST", "UNTITLED", "TBD", "N A", "-", ".",
]);

function text(value, max = 500) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function exactKey(value) {
  return text(value, 120).toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
}

function isPlaceholder(value) {
  const compact = text(value, 80).toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  return !compact || PLACEHOLDERS.has(compact);
}

function isIdentityEcho(value, row = {}) {
  const key = exactKey(value);
  if (!key || key.length < 6) return false;
  const identities = [
    row.contract_id, row.ctr_id, row.epin, row.epin_norm, row.pin,
  ].map(exactKey).filter(Boolean);
  if (identities.includes(key)) return true;
  if (/^CONTRACT/.test(key) && identities.some((id) => key.endsWith(id) || key === `CONTRACT${id}`)) {
    return true;
  }
  return false;
}

function tokens(value) {
  return text(value).split(/[\s/_:,;|()[\]]+/).filter(Boolean);
}

function hasHumanWord(value) {
  return tokens(value).some((token) => /^[A-Za-z][A-Za-z'’-]{2,}$/.test(token.replace(/[#.,]+$/g, "")));
}

function stripLeadingPinTokens(value) {
  let remainder = text(value);
  while (remainder) {
    const match = remainder.match(/^(\d{3,}[A-Za-z0-9]{2,})([-_/]+|$)/);
    if (!match) break;
    remainder = remainder.slice(match[0].length).trim();
  }
  return remainder;
}

export function cleanPassportPublicTitle(value, row = {}) {
  const original = text(value, 500);
  if (!original || !/[A-Za-z]/.test(original) || original.length < 4) return null;
  if (isPlaceholder(original) || isIdentityEcho(original, row)) return null;
  const stripped = stripLeadingPinTokens(original);
  const candidate = stripped && hasHumanWord(stripped) ? stripped : original;
  if (!hasHumanWord(candidate)) return null;
  if (isIdentityEcho(candidate, row) || isPlaceholder(candidate)) return null;
  return candidate;
}

export function cleanPassportPublicLabel(value, row = {}, max = 240) {
  const cleaned = text(value, max);
  if (!cleaned || cleaned.length < 3 || !/[A-Za-z]/.test(cleaned)) return null;
  if (isPlaceholder(cleaned) || isIdentityEcho(cleaned, row)) return null;
  return cleaned;
}

export function passportPublicFieldsFromRow(row = {}, identityRow = row) {
  return {
    title: cleanPassportPublicTitle(row.title, identityRow),
    procurement_method: cleanPassportPublicLabel(row.procurement_method, identityRow, 240),
    program: cleanPassportPublicLabel(row.program, identityRow, 240),
    industry: cleanPassportPublicLabel(row.industry, identityRow, 120),
  };
}

export function attachPassportPublicFields(target = {}, source = target) {
  const identity = { ...target, ...source };
  const incoming = passportPublicFieldsFromRow(source, identity);
  const current = passportPublicFieldsFromRow(target, identity);
  const next = { ...target };
  let changed = false;
  for (const name of PASSPORT_PUBLIC_FIELD_NAMES) {
    const value = incoming[name] || current[name];
    if (value) {
      if (next[name] !== value) {
        next[name] = value;
        changed = true;
      }
    } else if (Object.hasOwn(next, name)) {
      delete next[name];
      changed = true;
    }
  }
  return changed ? next : target;
}

function indexKey(parts) {
  const values = parts.map(exactKey).filter(Boolean);
  return values.length === parts.filter(Boolean).length && values.length
    ? values.join(":")
    : null;
}

export function indexPassportPublicFieldRows(rows = []) {
  const byCtr = new Map();
  const byContractEpin = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const ctr = exactKey(row.ctr_id);
    if (ctr && !byCtr.has(ctr)) byCtr.set(ctr, row);
    const pair = indexKey([row.contract_id, row.epin_norm || row.epin]);
    if (pair && !byContractEpin.has(pair)) byContractEpin.set(pair, row);
  }
  return { byCtr, byContractEpin };
}

export function lookupPassportPublicFieldRow(index, row = {}) {
  const ctr = exactKey(row.ctr_id);
  if (ctr && index?.byCtr?.has(ctr)) return index.byCtr.get(ctr);
  const pair = indexKey([row.contract_id, row.epin_norm || row.epin]);
  if (pair && index?.byContractEpin?.has(pair)) return index.byContractEpin.get(pair);
  return null;
}

export function densifyPassportPublicFields(spineRows = [], dumpRows = []) {
  const index = indexPassportPublicFieldRows(dumpRows);
  let matched = 0;
  let titled = 0;
  let method = 0;
  const rows = (Array.isArray(spineRows) ? spineRows : []).map((row) => {
    const source = lookupPassportPublicFieldRow(index, row);
    if (!source) return row;
    matched += 1;
    const next = attachPassportPublicFields(row, source);
    if (next.title) titled += 1;
    if (next.procurement_method) method += 1;
    return next;
  });
  return {
    rows,
    matched,
    titled,
    method,
    dump_rows: Array.isArray(dumpRows) ? dumpRows.length : 0,
    spine_rows: Array.isArray(spineRows) ? spineRows.length : 0,
  };
}
