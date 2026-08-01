// Structured authority-key registry for identifiers that are only meaningful
// inside a declared scheme, issuer, and scope.

export const AUTHORITY_KEY_REGISTRY_VERSION = "authority_key_pin_epin_v1";

const NULLISH = new Set([
  "0",
  "NA",
  "NONE",
  "NULL",
  "TBD",
  "UNKNOWN",
  "UNAVAILABLE",
  "NOTAPPLICABLE",
  "NOTPROVIDED",
]);

const cleanIdentifier = (value) => {
  const normalized = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return NULLISH.has(normalized) ? "" : normalized;
};

const cleanScheme = (value) => String(value ?? "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

const cleanScope = (value) => String(value ?? "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9:_-]+/g, "")
  .replace(/-/g, "_");

const PIN_EPIN = Object.freeze({
  scheme: "nyc_procurement_pin",
  scope: "nyc_procurement",
  fields: Object.freeze(["pin", "epin"]),
});

export const AUTHORITY_KEY_REGISTRY = Object.freeze({
  pin: PIN_EPIN,
  epin: PIN_EPIN,
});

function normalizedExplicitKey(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const scheme = cleanScheme(input.scheme);
  const issuingAuthority = cleanIdentifier(input.issuing_authority);
  const value = cleanIdentifier(input.value);
  const scope = cleanScope(input.scope);
  if (!scheme || !issuingAuthority || !value || !scope) return null;
  return { scheme, issuing_authority: issuingAuthority, value, scope };
}

/** Parse one registry field into a structured authority key. */
export function parseAuthorityKey(field, rawValue, context = {}) {
  const fieldName = String(field ?? "").trim().toLowerCase();
  const descriptor = AUTHORITY_KEY_REGISTRY[fieldName];
  if (!descriptor) return null;
  const value = cleanIdentifier(rawValue);
  if (!/^\d{3}[A-Z0-9]{4,}$/.test(value)) return null;
  const issuingAuthority = cleanIdentifier(
    context.issuing_authority ?? context[`${fieldName}_issuing_authority`] ?? value.slice(0, 3),
  );
  const scope = cleanScope(context.scope ?? context[`${fieldName}_scope`] ?? descriptor.scope);
  if (!issuingAuthority || !scope) return null;
  return {
    scheme: descriptor.scheme,
    issuing_authority: issuingAuthority,
    value,
    scope,
  };
}

/** Stable tuple identity; equality never falls back to raw value alone. */
export function authorityKeyId(key) {
  const normalized = normalizedExplicitKey(key);
  if (!normalized) return "";
  return [
    normalized.scheme,
    normalized.issuing_authority,
    normalized.value,
    normalized.scope,
  ].join(":");
}

function values(value) {
  return Array.isArray(value) ? value : [value];
}

/** Extract registered and explicitly supplied authority keys from one side. */
export function authorityKeysForSide(side = {}) {
  const attrs = side?.attrs && typeof side.attrs === "object" ? side.attrs : {};
  const keys = new Map();
  for (const container of [side, attrs]) {
    for (const raw of values(container?.authority_keys)) {
      const key = normalizedExplicitKey(raw);
      const id = authorityKeyId(key);
      if (id) keys.set(id, key);
    }
  }
  for (const field of PIN_EPIN.fields) {
    for (const container of [side, attrs]) {
      const context = {
        issuing_authority:
          container?.[`${field}_issuing_authority`] ??
          attrs?.[`${field}_issuing_authority`] ??
          side?.[`${field}_issuing_authority`] ??
          container?.issuing_authority ?? attrs?.issuing_authority ?? side?.issuing_authority,
        scope:
          container?.[`${field}_scope`] ?? attrs?.[`${field}_scope`] ?? side?.[`${field}_scope`] ??
          container?.authority_scope ?? attrs?.authority_scope ?? side?.authority_scope,
      };
      for (const raw of values(container?.[field])) {
        const key = parseAuthorityKey(field, raw, context);
        const id = authorityKeyId(key);
        if (id) keys.set(id, key);
      }
    }
  }
  return [...keys.values()].sort((a, b) => authorityKeyId(a).localeCompare(authorityKeyId(b)));
}

export function sharedAuthorityKeys(left, right) {
  const rightIds = new Set(authorityKeysForSide(right).map(authorityKeyId));
  return authorityKeysForSide(left).filter((key) => rightIds.has(authorityKeyId(key)));
}
