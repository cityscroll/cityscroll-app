#!/usr/bin/env node

/**
 * Public engineering-record identity contract.
 *
 * This is the positive half of the repository naming boundary. It states what a
 * public cross-boundary identity must look like, rather than listing what it must
 * not be, so the contract can be committed without naming anything private.
 *
 * A CityScroll Engineering Record is the public identity for a unit of work that
 * crosses from private development into this repository. Its public identity is
 * the only identity this repository carries: whether a record also has a private
 * owner, and what that owner is called, is outside the public schema.
 *
 * The rules:
 *
 *   1. A public cross-boundary identity is `cityscroll-engineering/<descriptive-public-id>`.
 *   2. The descriptive part is words, not queue positions, so a public id cannot
 *      leak the size or ordering of any private queue.
 *   3. A raw identity field is spelled plainly. Character escapes in the source
 *      text are rejected even when they parse to a legal identity, because an
 *      escaped identity defeats reading the file.
 *   4. A file path decodes to exactly the identity the document declares.
 *   5. Fields that would carry a private source id or a private alias mapping are
 *      not valid public fields.
 *   6. Where no descriptive name applies yet, a fallback token — the letter `c`
 *      followed by 12 lowercase hex characters — is accepted as a public id in
 *      its own right. It is minted outside this repository from a key this
 *      repository never holds, so it carries no descriptive words and no queue
 *      position: the same guarantee rule 2 makes for a descriptive id, met a
 *      different way for the record that does not have one yet.
 *
 * Every violation message names the contract that was broken and the field that
 * broke it. None of them echo a value, so a document that leaks a private term
 * cannot leak it a second time through this tool's own output.
 */

export const PUBLIC_NAMESPACE = "cityscroll-engineering";
export const REFERENCE_SCHEME = "engineering-record";
export const CONTRACT_VERSION = "cityscroll.public-engineering-record-identity.v1";

/**
 * Each `-` separated word starts with a letter, so `shared-dependency-store` is a
 * legal public id and a bare queue position such as `<prefix>-07` is not.
 */
const PUBLIC_WORD = "[a-z][a-z0-9]*";
/**
 * Rule 6's fallback token: `c` plus exactly 12 lowercase hex characters. The
 * leading letter is not decorative — it is what lets this token stand as its
 * own public id under rule 2's letter-led-word requirement, the same way a
 * descriptive word does.
 */
const ALIAS_TOKEN = "c[0-9a-f]{12}";
export const PUBLIC_ALIAS_PATTERN = new RegExp(`^${ALIAS_TOKEN}$`);
export const PUBLIC_ID_PATTERN = new RegExp(
  `^${PUBLIC_NAMESPACE}/(?:${ALIAS_TOKEN}|${PUBLIC_WORD}(?:-${PUBLIC_WORD})*)$`,
);
export const REFERENCE_PATTERN = new RegExp(
  `^${REFERENCE_SCHEME}:${PUBLIC_NAMESPACE}/(?:${ALIAS_TOKEN}|${PUBLIC_WORD}(?:-${PUBLIC_WORD})*)(?:#[a-z0-9]+(?:-[a-z0-9]+)*)?$`,
);

/**
 * True only for the exact rule-6 fallback shape inside the public namespace —
 * not for a descriptive word that merely happens to start with a letter and
 * contain hex-looking characters.
 */
export function isPublicAliasIdentity(value) {
  if (!isPublicNamespaceIdentity(value)) return false;
  return PUBLIC_ALIAS_PATTERN.test(value.slice(`${PUBLIC_NAMESPACE}/`.length));
}

/**
 * Field names that would carry the private side of an alias mapping. A public
 * document may say what a record is called here; it may not say what it is called
 * anywhere else, or that an "anywhere else" exists.
 */
export const FORBIDDEN_PRIVATE_FIELDS = Object.freeze([
  "alias_map",
  "private_alias",
  "private_alias_map",
  "private_identity",
  "private_owner",
  "private_record",
  "private_record_id",
  "private_register_id",
  "private_source_id",
  "source_register_id",
  "upstream_register_id",
]);

export function isPublicNamespaceIdentity(value) {
  return typeof value === "string" && value.startsWith(`${PUBLIC_NAMESPACE}/`);
}

export function isPublicReference(value) {
  return typeof value === "string" && value.startsWith(`${REFERENCE_SCHEME}:`);
}

function violation(path, rule, field, detail) {
  return { path, rule, field, detail, contract: CONTRACT_VERSION };
}

/**
 * Rule 1 and 2: an identity in the public namespace is well formed and descriptive.
 */
export function inspectPublicIdentity(value, { path, field }) {
  if (!isPublicNamespaceIdentity(value)) return [];
  if (PUBLIC_ID_PATTERN.test(value)) return [];
  return [violation(
    path,
    "public-identity-form",
    field,
    `a ${PUBLIC_NAMESPACE} identity must be ${PUBLIC_NAMESPACE}/<descriptive-public-id>, where the descriptive part is hyphen-separated words that each begin with a letter; queue positions and bare ordinals are not public identities`,
  )];
}

/**
 * Rule 1 and 2, applied to a reference rather than an identity.
 */
export function inspectPublicReference(value, { path, field }) {
  if (!isPublicReference(value)) return [];
  if (REFERENCE_PATTERN.test(value)) return [];
  return [violation(
    path,
    "public-reference-form",
    field,
    `a cross-boundary reference must be ${REFERENCE_SCHEME}:${PUBLIC_NAMESPACE}/<descriptive-public-id> with an optional #fragment`,
  )];
}

/**
 * Rule 5: no field carries the private side of a mapping.
 */
export function inspectForbiddenFields(document, { path, prefix = "" } = {}) {
  const violations = [];
  const walk = (node, trail) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${trail}[${index}]`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const field = trail ? `${trail}.${key}` : key;
      if (FORBIDDEN_PRIVATE_FIELDS.includes(key)) {
        violations.push(violation(
          path,
          "private-field-in-public-document",
          field,
          "a private source id or private alias mapping is not a valid public field; the mapping belongs to the private control plane",
        ));
      }
      walk(value, field);
    }
  };
  walk(document, prefix);
  return violations;
}

/**
 * Rule 3: an identity field is spelled plainly in the source text.
 *
 * A JSON parser resolves an escape to the character it denotes before any
 * value-level check ever sees it, so a value-level check cannot detect an
 * escaped identity at all. This inspects the raw text instead and compares each
 * identity field's source literal against the string it denotes. Any difference
 * means the file does not read as what it means.
 */
export function inspectRawIdentityEscapes(text, { path, fields }) {
  const violations = [];
  for (const field of fields) {
    const pattern = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "g");
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const literal = match[1];
      let decoded;
      try {
        decoded = JSON.parse(`"${literal}"`);
      } catch {
        continue;
      }
      if (literal !== decoded) {
        violations.push(violation(
          path,
          "escaped-identity-field",
          field,
          "a raw identity field must not use character escapes; write the identity in plain characters so the file reads as what it means",
        ));
      }
    }
  }
  return violations;
}

/**
 * Rule 4: the path a document lives at decodes to exactly the identity it declares.
 * The encoder is supplied by the caller, because each registry owns its own
 * path encoding.
 */
export function inspectPathIdentityAgreement({ path, id, expectedPath }) {
  if (path === expectedPath) return [];
  return [violation(
    path,
    "path-identity-mismatch",
    "id",
    `the file path must decode to exactly the declared identity; expected ${expectedPath}`,
  )].map((row) => ({ ...row, id }));
}

export function describeContract() {
  return {
    contract: CONTRACT_VERSION,
    namespace: PUBLIC_NAMESPACE,
    reference_scheme: REFERENCE_SCHEME,
    identity_pattern: PUBLIC_ID_PATTERN.source,
    reference_pattern: REFERENCE_PATTERN.source,
    alias_pattern: PUBLIC_ALIAS_PATTERN.source,
    forbidden_private_fields: [...FORBIDDEN_PRIVATE_FIELDS],
  };
}
