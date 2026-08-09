/** Safe typed entity mentions for Browse/list cards. */
export function listEntityMentionHTML(options) {
  const { kind, value, label = value, escape, scope, surface, className = "", relation = "", confidence = "strong" } = options;
  const text = String(label ?? "").trim();
  const esc = typeof escape === "function" ? escape : (input) => String(input ?? "");
  if (!text) return "";
  const pivots = globalThis.CrolEntityPivots;
  if (!pivots?.entityChipHTML || !pivots.entityRouteRef) return esc(text);
  let ref = "";
  if (kind === "agency") {
    const identity = pivots.resolveAgencyIdentity?.(value);
    if (!identity?.matched || !identity.canonical_id) return esc(text);
    ref = `agency:id:${identity.canonical_id}`;
  } else if (kind === "vendor") {
    ref = pivots.entityRouteRef("vendor", value);
  } else if (kind === "project" && /^\w[\w-]{2,24}$/.test(String(value || "").trim())) {
    ref = `project:${String(value).trim()}`;
  } else if (kind === "parcel" && /^\d{10}$/.test(String(value || "").trim())) {
    ref = `bbl:${String(value).trim()}`;
  }
  if (!ref) return esc(text);
  return pivots.entityChipHTML({ ref, label: text, link_confidence: confidence, ...(relation ? { relation } : {}) }, { scope, surface, className });
}
