/** Shared CityScroll link/control grammar. Keep these primitives presentation-neutral. */

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function dataAttributes(attributes, escape) {
  return Object.entries(attributes || {}).map(([name, value]) => {
    if (!/^data-[a-z0-9-]+$/.test(name) || value == null) return "";
    return ` ${name}="${escape(value)}"`;
  }).join("");
}

const AFFORDANCE_CANONICAL_ORIGIN = "https://cityscroll.org";
const AFFORDANCE_OWNED_HOSTS = new Set([
  "cityscroll.org",
  "www.cityscroll.org",
  "api.cityscroll.org",
  "crol-list.org",
  "www.crol-list.org",
  "api.crol-list.org",
]);
const AFFORDANCE_NAVIGATION_ONLY_ACTION_KINDS = new Set([
  "calendar",
  "copy",
  "export",
  "navigation",
  "open",
  "print",
  "qr",
  "watch",
]);

function affordanceText(value) {
  return String(value ?? "").trim();
}

/* ---------- action scent ---------- */

/**
 * What activating a named next step actually does. These three are the whole
 * vocabulary, because they are the three consequences a reader can be asked to
 * predict before clicking:
 *
 *   inspect  — answers a question in place. Nothing is navigated to, nothing is
 *              sent, and no publisher is contacted. A native button.
 *   navigate — opens another page of this site. An ordinary anchor, so it keeps
 *              working with scripting off, through the context menu and under a
 *              modified click.
 *   handoff  — leaves this site: an external page, a submission portal, a
 *              download, a calendar subscription, a mail or telephone handler.
 *              An anchor that says so before it is followed.
 *
 * The distinction is not decorative. A control that inspects must never submit
 * or subscribe, and a control that hands off to a publisher must never be
 * dressed as one that stays here.
 */
export const AFFORDANCE_ACTION_ROLES = Object.freeze({
  inspect: "inspect",
  navigate: "navigate",
  handoff: "handoff",
});

// A label that positions its subject relative to the reader's current document
// is a claim about layout, not about a destination. "Follow the response steps
// below" is true on the notice that carries the steps and false on every
// listing card that links to that notice. Such a label is therefore correct in
// one place and misleading in another, which is why it is judged against the
// surface rendering it rather than rewritten wherever it appears.
const AFFORDANCE_POSITIONAL_PROMISE = /\b(?:below|above|further down|overleaf|on this page)\b/i;

/** True when a label promises content positioned in the reader's own document. */
export function affordancePositionalPromise(label) {
  return AFFORDANCE_POSITIONAL_PROMISE.test(affordanceText(label));
}

/**
 * Classify one next step by what activating it does. `inspects` is the caller's
 * own declaration that the control answers in place; everything else is decided
 * by the destination, so an owned host stays navigation however it is spelled
 * and an absolute publisher URL can never be mistaken for a page of this site.
 *
 * Returns `null` for a step with no usable destination, which is not an action
 * a reader can be offered at all.
 */
export function affordanceActionRole({ href, inspects = false, canonicalOrigin = AFFORDANCE_CANONICAL_ORIGIN } = {}) {
  if (inspects === true) return AFFORDANCE_ACTION_ROLES.inspect;
  const kind = affordanceDestinationKind(href, canonicalOrigin);
  if (kind === "missing") return null;
  return kind === "internal" ? AFFORDANCE_ACTION_ROLES.navigate : AFFORDANCE_ACTION_ROLES.handoff;
}

/**
 * The presentation one destination is owed, factored out of the link renderers
 * so a surface with its own class vocabulary — the shared month component and
 * its two panels — inherits the same decision instead of restating it.
 *
 * A handoff always carries the visible glyph; only a real external page also
 * takes a new tab, and only that case announces one, because a mail or
 * telephone handler does not open a tab to announce.
 */
export function affordanceHandoffPresentation({
  href,
  inspects = false,
  canonicalOrigin = AFFORDANCE_CANONICAL_ORIGIN,
  newTabLabel = "(opens in new tab)",
  escape = esc,
} = {}) {
  const role = affordanceActionRole({ href, inspects, canonicalOrigin });
  const external = affordanceDestinationKind(href, canonicalOrigin) === "external";
  const handoff = role === AFFORDANCE_ACTION_ROLES.handoff;
  return Object.freeze({
    role,
    external,
    attributes: external ? ' target="_blank" rel="noopener noreferrer"' : "",
    glyph: handoff ? '<span aria-hidden="true">↗</span>' : "",
    announcement: external && newTabLabel ? `<span class="sr-only"> ${escape(newTabLabel)}</span>` : "",
  });
}

/**
 * Audit one rendered next step against the shared naming rule: an action's name
 * describes what activating it does, and a card never spends the same words
 * twice on a fact and on the control beside it.
 *
 * `statedFacts` are the labels the same card already carries as non-interactive
 * text — its kind badge, its date label, its domain tag. Repeating one of them
 * verbatim as the control's name costs the reader a second reading and tells
 * them nothing new about the click.
 *
 * `carriesSubject` is the rendering surface's own declaration that the promised
 * material really is present in the same document. Only that surface knows;
 * a listing card does not, so it does not get to claim it.
 *
 * Pure and presentation-free: it returns findings, and the caller decides
 * whether a finding is a defect to fail on or a case it has justified.
 */
export function affordanceActionScent({
  label,
  href,
  inspects = false,
  statedFacts = [],
  carriesSubject = false,
  canonicalOrigin = AFFORDANCE_CANONICAL_ORIGIN,
} = {}) {
  const text = affordanceText(label);
  const role = affordanceActionRole({ href, inspects, canonicalOrigin });
  const problems = [];
  if (!text) problems.push("unnamed");
  if (!role) problems.push("undestined");
  if (text && !carriesSubject && affordancePositionalPromise(text)) problems.push("positional_promise");
  const comparable = affordanceComparableLabel(text);
  if (comparable && (Array.isArray(statedFacts) ? statedFacts : [])
    .some((fact) => affordanceComparableLabel(fact) === comparable)) {
    problems.push("repeats_stated_fact");
  }
  return Object.freeze({ role, ok: problems.length === 0, problems: Object.freeze(problems) });
}

// Labels are compared as a reader hears them, not as bytes: case, surrounding
// punctuation and repeated spacing are not distinctions a card is making.
function affordanceComparableLabel(value) {
  return affordanceText(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function affordanceDestinationKind(href, canonicalOrigin = AFFORDANCE_CANONICAL_ORIGIN) {
  const value = affordanceText(href);
  if (!value) return "missing";
  if (/^(?:mailto|tel):/i.test(value)) return "protocol_handoff";
  if (/^(?:#|\/|\.|\?)/.test(value)) return "internal";
  let url;
  try { url = new URL(value, canonicalOrigin); }
  catch { return "missing"; }
  if (!/^https?:$/.test(url.protocol)) return "protocol_handoff";
  return AFFORDANCE_OWNED_HOSTS.has(url.hostname.toLowerCase()) ? "internal" : "external";
}

function affordanceCanonicalTargetUrl(href, canonicalOrigin = AFFORDANCE_CANONICAL_ORIGIN) {
  if (affordanceDestinationKind(href, canonicalOrigin) !== "internal") return null;
  try { return new URL(affordanceText(href), canonicalOrigin).href; }
  catch { return null; }
}

function normalizeAffordanceTarget(target, canonicalOrigin) {
  const href = affordanceText(target?.href);
  const label = affordanceText(target?.label);
  if (!href || !label || affordanceDestinationKind(href, canonicalOrigin) !== "internal") return null;
  return Object.freeze({ href, label, current: target?.current === true });
}

function normalizeAffordanceRelation(relation, canonicalOrigin) {
  const label = affordanceText(relation?.label);
  if (!label) return null;
  const href = affordanceText(relation?.href);
  const verified = relation?.verified === true && affordanceDestinationKind(href, canonicalOrigin) === "internal";
  return Object.freeze({
    label,
    href: verified ? href : null,
    verified,
  });
}

function normalizeAffordanceHandoff(handoff, canonicalOrigin) {
  const label = affordanceText(handoff?.label);
  const href = affordanceText(handoff?.href);
  const kind = affordanceDestinationKind(href, canonicalOrigin);
  if (!label || !href || !["external", "protocol_handoff"].includes(kind)) return null;
  return Object.freeze({
    label,
    href,
    kind: affordanceText(handoff?.kind) || "handoff",
    primary: handoff?.primary === true,
  });
}

function normalizeAffordanceKineticAction(action, canonicalOrigin) {
  const label = affordanceText(action?.label);
  const href = affordanceText(action?.href || action?.destination);
  const kind = affordanceText(action?.kind || action?.type).toLowerCase();
  if (!label || !href || !kind || action?.context_ready !== true || AFFORDANCE_NAVIGATION_ONLY_ACTION_KINDS.has(kind)) return null;
  if (affordanceDestinationKind(href, canonicalOrigin) === "missing") return null;
  return Object.freeze({
    label,
    href,
    kind: kind || "kinetic",
    primary: action?.primary !== false,
    attributes: action?.attributes && typeof action.attributes === "object"
      ? Object.freeze({ ...action.attributes })
      : Object.freeze({}),
  });
}

/**
 * Normalize producer-owned evidence into the shared object-card interaction grammar.
 * Producers decide whether a relation is verified and whether an action/guide is ready;
 * this projection owns the stable presentation boundary used by card renderers.
 */
export function objectCardInteractionProjection({
  target,
  relations = [],
  external_handoffs = [],
  kinetic_actions = [],
  guide = null,
  canonicalOrigin = AFFORDANCE_CANONICAL_ORIGIN,
} = {}) {
  const normalized = normalizeAffordanceTarget(target, canonicalOrigin);
  const projectedGuide = guide?.context_ready === true && guide?.source_backed === true && affordanceText(guide?.html)
    ? Object.freeze({ html: String(guide.html) })
    : null;
  return Object.freeze({
    target: normalized,
    relations: Object.freeze((Array.isArray(relations) ? relations : []).map((relation) => normalizeAffordanceRelation(relation, canonicalOrigin)).filter(Boolean)),
    external_handoffs: Object.freeze((Array.isArray(external_handoffs) ? external_handoffs : []).map((handoff) => normalizeAffordanceHandoff(handoff, canonicalOrigin)).filter(Boolean)),
    copy_target: normalized ? affordanceCanonicalTargetUrl(normalized.href, canonicalOrigin) : null,
    kinetic_actions: Object.freeze(normalized
      ? (Array.isArray(kinetic_actions) ? kinetic_actions : []).map((action) => normalizeAffordanceKineticAction(action, canonicalOrigin)).filter(Boolean)
      : []),
    guide: projectedGuide,
  });
}

/** Internal graph travel: same-tab, blue, solid underline, leading node glyph. */
export function constellationLink({ href, label, labelMarkup = null, count = null, className = "", current = false, attributes = {}, escape = esc } = {}) {
  const countMarkup = count == null ? "" : `<span class="ct">${escape(count)}</span>`;
  const renderedLabel = labelMarkup == null ? escape(label) : String(labelMarkup);
  return `<a class="ui-constellation-link${className ? ` ${escape(className)}` : ""}" href="${escape(href)}"${current ? ' aria-current="page"' : ""}${dataAttributes(attributes, escape)}><span aria-hidden="true">◆</span>${renderedLabel}${countMarkup}</a>`;
}

/** Authoritative external record: new tab, neutral dotted underline, trailing arrow. */
export function officialSourceLink({
  href,
  label,
  className = "",
  attributes = {},
  escape = esc,
  newTabLabel = "",
} = {}) {
  const announcement = newTabLabel ? `<span class="sr-only"> ${escape(newTabLabel)}</span>` : "";
  return `<a class="ui-official-source-link${className ? ` ${escape(className)}` : ""}" href="${escape(href)}" target="_blank" rel="noopener noreferrer"${dataAttributes(attributes, escape)}>${escape(label)}<span aria-hidden="true">↗</span>${announcement}</a>`;
}

/** Kinetic off-site handoff: visible arrow plus accessible new-tab disclosure. */
export function externalActionLink({
  href,
  label,
  primary = false,
  className = "",
  ariaLabel = null,
  title = null,
  attributes = {},
  escape = esc,
  canonicalOrigin = AFFORDANCE_CANONICAL_ORIGIN,
  newTabLabel = "(opens in new tab)",
} = {}) {
  const presentation = affordanceHandoffPresentation({ href, canonicalOrigin, newTabLabel, escape });
  if (!presentation.role) return "";
  const navigates = presentation.role === AFFORDANCE_ACTION_ROLES.navigate;
  const classes = [navigates ? "ui-action-link" : "ui-external-action", primary ? "primary" : "", className]
    .filter(Boolean).map((value) => escape(value)).join(" ");
  const accessibleAttrs = `${ariaLabel ? ` aria-label="${escape(ariaLabel)}"` : ""}${title ? ` title="${escape(title)}"` : ""}`;
  return `<a class="${classes}" href="${escape(href)}"${accessibleAttrs}${presentation.attributes}${dataAttributes(attributes, escape)}>${escape(label)}${presentation.glyph}${presentation.announcement}</a>`;
}

export function renderObjectCardTitle(projection, { className = "ui-object-card-title", labelMarkup = null, escape = esc } = {}) {
  if (!projection?.target) return "";
  return constellationLink({
    href: projection.target.href,
    label: projection.target.label,
    labelMarkup,
    current: projection.target.current,
    className,
    escape,
  });
}

export function renderObjectCardCopy(projection, {
  className = "ui-object-card-copy",
  label = "Copy link",
  attributes = {},
  escape = esc,
} = {}) {
  if (!projection?.copy_target) return "";
  return `<button type="button" class="${escape(className)}" data-object-card-copy="${escape(projection.copy_target)}" aria-live="polite"${dataAttributes(attributes, escape)}>${escape(label)}</button>`;
}

export function renderObjectCardRelations(projection, { escape = esc } = {}) {
  const relations = (projection?.relations || []).map((relation) => relation.verified
    ? constellationLink({ href: relation.href, label: relation.label, className: "ui-object-card-relation", escape })
    : staticFact({ label: relation.label, className: "ui-object-card-relation-unresolved", escape }));
  return relations.length ? `<div class="ui-object-card-relations">${relations.join("")}</div>` : "";
}

export function renderObjectCardActionRail(projection, {
  heading = "What can I do now?",
  escape = esc,
  newTabLabel = "(opens in new tab)",
} = {}) {
  const actions = (projection?.kinetic_actions || []).map((action) => externalActionLink({
    href: action.href,
    label: action.label,
    primary: action.primary,
    attributes: action.attributes,
    escape,
    newTabLabel,
  }));
  if (!actions.length && !projection?.guide) return "";
  return `<section class="ui-object-card-action-rail"><h3>${escape(heading)}</h3>${actions.length ? `<div class="ui-object-card-action-list">${actions.join("")}</div>` : ""}${projection?.guide?.html || ""}</section>`;
}

/** Render the shared primitives as a fragment; the owning row remains a non-anchor selector. */
export function renderObjectCardPrimitives(projection, {
  escape = esc,
  titleMarkup = null,
  titleClassName = "ui-object-card-title",
  copyLabel = "Copy link",
  actionHeading = "What can I do now?",
  newTabLabel = "(opens in new tab)",
} = {}) {
  if (!projection?.target) return "";
  const handoffs = (projection.external_handoffs || []).map((handoff) => handoff.kind === "official_source"
    ? officialSourceLink({ href: handoff.href, label: handoff.label, escape })
    : externalActionLink({ href: handoff.href, label: handoff.label, primary: handoff.primary, escape }));
  return `<div class="ui-object-card-interactions"><div class="ui-object-card-primary">${renderObjectCardTitle(projection, { escape, labelMarkup: titleMarkup, className: titleClassName })}${renderObjectCardCopy(projection, { escape, label: copyLabel })}</div>${renderObjectCardRelations(projection, { escape })}${handoffs.length ? `<div class="ui-object-card-handoffs">${handoffs.join("")}</div>` : ""}${renderObjectCardActionRail(projection, { escape, heading: actionHeading, newTabLabel })}</div>`;
}

/** Copy one projected canonical URL and expose the result through the focused button. */
export async function copyObjectCardCanonicalUrl(button, {
  writeText = null,
  navigatorRef = globalThis.navigator,
  documentRef = globalThis.document,
  successLabel = "Copied ✓",
  failureLabel = "Copy failed",
} = {}) {
  const value = affordanceText(button?.dataset?.objectCardCopy);
  if (!button || !value) return false;
  button.setAttribute?.("aria-live", "polite");
  let copied = false;
  try {
    if (writeText) await writeText(value);
    else if (navigatorRef?.clipboard?.writeText) await navigatorRef.clipboard.writeText(value);
    else {
      const textarea = documentRef?.createElement?.("textarea");
      if (!textarea) throw new Error("clipboard unavailable");
      textarea.value = value;
      documentRef.body.appendChild(textarea);
      textarea.select();
      copied = documentRef.execCommand?.("copy") === true;
      textarea.remove();
      if (!copied) throw new Error("copy command failed");
    }
    copied = true;
  } catch {
    copied = false;
  }
  const resultLabel = copied ? successLabel : failureLabel;
  button.textContent = typeof resultLabel === "function" ? resultLabel() : resultLabel;
  return copied;
}

const copyRoots = new WeakSet();

/** Delegated binding covers both static first paint and later hydrated cards. */
export function installObjectCardCopyLinks(root = globalThis.document, options = {}) {
  if (!root?.addEventListener || copyRoots.has(root)) return;
  copyRoots.add(root);
  root.addEventListener("click", (event) => {
    const button = event?.target?.closest?.("[data-object-card-copy]");
    if (!button || (root !== globalThis.document && !root.contains?.(button))) return;
    copyObjectCardCanonicalUrl(button, options);
  });
}

/** Keep repeated official links available without making them the object's visual rhythm. */
export function officialSourceDisclosure({ items = [], label = "Open official sources", className = "", escape = esc } = {}) {
  const seen = new Set();
  const links = (Array.isArray(items) ? items : []).map((item) => {
    const href = String(item?.href || "").trim();
    const text = String(item?.label || "").trim();
    if (!href || !text || seen.has(href)) return "";
    seen.add(href);
    return `<li>${officialSourceLink({ href, label: text, className: "node-source-link", escape })}</li>`;
  }).filter(Boolean);
  if (!links.length) return "";
  return `<details class="node-source-disclosure${className ? ` ${escape(className)}` : ""}"><summary class="node-action">${escape(label)}</summary><ul>${links.join("")}</ul></details>`;
}

/** View-changing control: pill button with aria-pressed; deliberately not a link. */
export function filterChip({ label, count = null, pressed = false, className = "", attributes = {}, escape = esc } = {}) {
  const countMarkup = count == null ? "" : `<span class="ct">${escape(count)}</span>`;
  return `<button type="button" class="ui-filter-chip${className ? ` ${escape(className)}` : ""}" aria-pressed="${pressed ? "true" : "false"}"${dataAttributes(attributes, escape)}>${escape(label)}${countMarkup}</button>`;
}

/** Non-interactive information: plain semantic text with no link affordance. */
export function staticFact({ label, count = null, className = "", escape = esc } = {}) {
  const countMarkup = count == null ? "" : `<span class="ct">${escape(count)}</span>`;
  return `<span class="ui-static-fact${className ? ` ${escape(className)}` : ""}">${escape(label)}${countMarkup}</span>`;
}

/** Install navigation behavior for filter buttons carrying their shareable destination. */
export function installFilterChipNavigation(root = globalThis.document, locationRef = globalThis.location) {
  if (!root?.querySelectorAll || !locationRef) return;
  root.querySelectorAll(".ui-filter-chip[data-filter-href]").forEach((button) => {
    if (button.dataset.filterNavigationInstalled === "true") return;
    button.dataset.filterNavigationInstalled = "true";
    button.addEventListener("click", () => {
      const href = button.getAttribute("data-filter-href");
      if (href) locationRef.assign(href);
    });
  });
}
