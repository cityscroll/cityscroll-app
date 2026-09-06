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
 *   6. A tracked path in a public evidence root is named the same way: its
 *      segments carry descriptive words, never a register namespace and never a
 *      queue position. A file under the evidence registry is
 *      `<namespace>--<descriptive-public-id>.json` for the one public namespace,
 *      and no segment anywhere in these roots is a short abbreviation followed by
 *      an ordinal.
 *   7. Where no descriptive name applies yet, a fallback token — the letter `c`
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
 * Rule 7's fallback token: `c` plus exactly 12 lowercase hex characters. The
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
 * True only for the exact rule-7 fallback shape inside the public namespace —
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

/**
 * Rule 6: the public evidence roots. Every tracked path under one of these is a
 * public naming surface, so the same words-not-queue-positions rule that governs
 * an identity governs the path that carries it.
 */
export const PUBLIC_PATH_ROOTS = Object.freeze([
  "architecture/evidence.d",
  "docs/evidence",
  "artifacts",
  "data",
]);

/**
 * Shape A — a registry namespace other than the one public namespace. The
 * evidence registry encodes `<namespace>/<public-id>` as `<namespace>--<public-id>`,
 * so a file named `cityscroll-<something-else>--...` is publishing a second
 * namespace this repository does not have.
 */
export const PRIVATE_NAMESPACE_FILENAME_PATTERN = /(^|\/)cityscroll-(?!engineering--)[a-z0-9-]+--/;

/**
 * Shape B — a queue position. A short letter abbreviation followed by a one- to
 * three-digit ordinal at the head of a path segment is an index into an ordered
 * register, not a description of anything: `<abbr>-<n>-<words>` names the words'
 * position, and a bare `<abbr>-<n>` names nothing else at all.
 *
 * A bare segment is only read this way for a one- or two-digit ordinal, because a
 * longer terminal number in these roots is a measurement — a viewport width, a
 * shard index — and a measurement is a description. This is the same stance
 * tools/check_stale_repo_name.mjs takes: state the shape that is legal and let
 * the rule decide, rather than committing a list of the names to keep out. There
 * is deliberately no allowlist here; a path that trips this rule is renamed.
 */
export const QUEUE_POSITION_SEGMENT_PATTERN = /(^|\/)[a-z]{2,6}-\d{1,3}-|(^|\/)[a-z]{2,6}-\d{1,2}(\.[a-z0-9]+)*$/;

/**
 * Rule 6, applied to one tracked path. Returns [] for a path outside the public
 * evidence roots: those roots are the surface this rule governs.
 */
export function inspectPublicPath(path) {
  const value = String(path || "").split("\\").join("/");
  if (!PUBLIC_PATH_ROOTS.some((root) => value === root || value.startsWith(`${root}/`))) return [];
  const violations = [];
  if (PRIVATE_NAMESPACE_FILENAME_PATTERN.test(value)) {
    violations.push(violation(
      value,
      "public-path-namespace",
      "path",
      `an evidence registry file names the one public namespace; ${PUBLIC_NAMESPACE}--<descriptive-public-id>.json is the only registry filename form`,
    ));
  }
  if (QUEUE_POSITION_SEGMENT_PATTERN.test(value)) {
    violations.push(violation(
      value,
      "public-path-queue-position",
      "path",
      "a path segment in a public evidence root is hyphen-separated words that each begin with a letter; an abbreviation followed by an ordinal is a queue position, not a description",
    ));
  }
  return violations;
}

/**
 * Rule 6 over a whole tracked-file listing.
 */
export function inspectPublicPaths(paths) {
  return paths.flatMap((path) => inspectPublicPath(path));
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
    public_path_roots: [...PUBLIC_PATH_ROOTS],
    private_namespace_filename_pattern: PRIVATE_NAMESPACE_FILENAME_PATTERN.source,
    queue_position_segment_pattern: QUEUE_POSITION_SEGMENT_PATTERN.source,
  };
}
