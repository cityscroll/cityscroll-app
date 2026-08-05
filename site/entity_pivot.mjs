/**
 * Pure typed-entity pivot helpers.
 *
 * Entity refs are the truth boundary; display labels never create links by
 * themselves. Routes remain the existing agency/vendor/official hash routes.
 */

const clean = (value, max = 320) =>
  String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const escapeHTML = (value) => clean(value).replace(/[<>&'"]/g, (char) => ({
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "'": "&#39;",
  '"': "&quot;",
})[char]);

const escapeAttr = escapeHTML;

function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

/** Parse only the entity families with public routes in the first slice. */
export function parseEntityRef(value) {
  const ref = clean(value);
  if (!ref || /\s/.test(ref)) return null;
  if (ref.startsWith("agency:")) {
    const id = ref.slice("agency:".length);
    return id ? { kind: "agency", id, ref } : null;
  }
  if (ref.startsWith("vendor:stem:")) {
    const id = ref.slice("vendor:".length);
    return decoded(id.slice("stem:".length)) ? { kind: "vendor", id, ref } : null;
  }
  if (ref.startsWith("entity:official:")) {
    const id = ref.slice("entity:official:".length);
    return id ? { kind: "official", id, ref } : null;
  }
  return null;
}

/**
 * Compatibility adapter for already-accepted entity mentions that currently
 * have a routed display value but not a materialized ref at the call site.
 */
export function entityRouteRef(kind, value) {
  const label = clean(value);
  if (!label) return "";
  if (kind === "agency") return `agency:name:${encodeURIComponent(label)}`;
  if (kind === "vendor") return `vendor:stem:${encodeURIComponent(label)}`;
  if (kind === "official") return `entity:official:${encodeURIComponent(label)}`;
  return "";
}

/** Return the existing public route for an allowlisted typed entity ref. */
export function entityHref(entity = {}, options = {}) {
  const parsed = parseEntityRef(entity.ref);
  if (!parsed) return "";
  const label = clean(entity.label);
  const query = new URLSearchParams();
  let route = "";
  if (parsed.kind === "official") {
    route = `#official/${encodeURIComponent(decoded(parsed.id) || parsed.id)}`;
    if (options.eventId) query.set("event", clean(options.eventId));
    if (options.noticeId) query.set("notice", clean(options.noticeId));
  } else {
    const fallback = parsed.kind === "vendor"
      ? decoded(parsed.id.slice("stem:".length))
      : decoded(parsed.id.replace(/^(?:id|name):/, ""));
    // Vendor stems are the routed identity handle; a presentation label may be
    // a source variant. Agency pages still need the accepted display name.
    const routedName = parsed.kind === "vendor" ? fallback : (label || fallback);
    if (!routedName) return "";
    route = `#${parsed.kind}/${encodeURIComponent(routedName)}`;
    if (options.tab) query.set("tab", clean(options.tab));
  }
  const suffix = query.toString();
  return `${route}${suffix ? `?${suffix}` : ""}`;
}

/** Recover a typed descriptor from an existing entity hash route. */
export function entityFromHref(href, label = "") {
  const raw = clean(href, 1_000);
  const match = raw.match(/^#(agency|vendor|official)\/([^?]+)(?:\?(.*))?$/);
  if (!match) return null;
  const kind = match[1];
  const routed = decoded(match[2]);
  if (!routed) return null;
  const ref = entityRouteRef(kind, routed);
  if (!parseEntityRef(ref)) return null;
  return {
    ref,
    label: clean(label) || routed,
    options: (() => {
      const params = new URLSearchParams(match[3] || "");
      return {
        tab: params.get("tab") || "",
        eventId: params.get("event") || "",
        noticeId: params.get("notice") || "",
      };
    })(),
  };
}

/**
 * Render one public entity mention. Strong and tentative published links pivot;
 * review-only/unknown candidates remain escaped text.
 */
export function entityChipHTML(entity = {}, options = {}) {
  const label = escapeHTML(entity.label || "");
  const confidence = clean(entity.link_confidence || entity.confidence).toLowerCase();
  if (!label || !["strong", "tentative"].includes(confidence)) return label;
  const href = entityHref(entity, options);
  if (!href) return label;

  const relation = clean(entity.relation, 80);
  const evidence = clean(entity.evidence, 240);
  const relationAttr = relation ? ` data-relation="${escapeAttr(relation)}"` : "";
  const extraClass = clean(options.className, 80).replace(/[^a-zA-Z0-9 _-]/g, "");
  const classes = ["pivot", "entity-pivot", extraClass].filter(Boolean).join(" ");
  const link = `<a class="${classes}" href="${escapeAttr(href)}" data-entity-ref="${escapeAttr(entity.ref)}" data-link-confidence="${confidence}"${relationAttr}>${label}</a>`;
  if (confidence === "strong") return link;

  const evidenceHTML = evidence
    ? ` <span class="entity-pivot-evidence" title="${escapeAttr(evidence)}">Evidence</span>`
    : "";
  return `<span class="entity-pivot-tentative" data-link-confidence="tentative">${link} <span class="entity-pivot-band">Possible match</span>${evidenceHTML}</span>`;
}
