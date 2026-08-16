/** Stable Card 1 assertion targets for admitted project × agency × vendor edges. */

import { versionedAssertionId } from "../provenance_graph.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function tokenHex(value) {
  return [...new TextEncoder().encode(clean(value))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function projectAgencyVendorAssertionIdentity(bundle, edge) {
  const evidence = tokenHex(bundle?.evidence_id);
  const relation = clean(edge?.type).toLowerCase();
  const target = tokenHex(edge?.to);
  if (!evidence || !/^[a-z][a-z0-9_-]{0,63}$/.test(relation) || !target) {
    throw new Error("project-agency-vendor assertion identity requires evidence, relation, and target");
  }
  const assertion_key = `project_agency_vendor:${evidence}:${relation}:${target}`;
  const assertion_id = versionedAssertionId(assertion_key, 1);
  return Object.freeze({
    assertion_key,
    assertion_id,
    assertion_href: `/assertions/${encodeURIComponent(assertion_id)}/`,
  });
}

export function projectAgencyVendorSubjectInspectorHref(subjectRef) {
  const subject = clean(subjectRef);
  return subject ? `/assertions/?subject=${encodeURIComponent(subject)}` : null;
}
