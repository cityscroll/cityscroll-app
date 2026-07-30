// Pure join helpers for NYC Open Data Current Solicitations (3khw-qi8f).
//
// Joins City Record notices to the OCP Current Solicitations Socrata view so the
// procurement lifecycle can surface package documents, due dates, and contact
// fields that live in that public set. No fetch/env — tests exercise the join
// with real field cases.

export const CURRENT_SOLICITATIONS_DATASET = "3khw-qi8f";
export const CURRENT_SOLICITATIONS_SOURCE = "ocp-current-solicitations";
export const CURRENT_SOLICITATIONS_LANDING =
  "https://data.cityofnewyork.us/d/3khw-qi8f";

// Socrata document_links may be a string, a {url} object, or comma-joined URLs
// with HTML entities. Match worker/src/ingest.mjs docUrls() behavior.
export function parseDocumentLinks(value) {
  if (!value) return [];
  let raw = value;
  if (typeof value === "object" && value !== null) {
    raw = value.url || value.href || "";
  }
  return String(raw)
    .replace(/&amp;/g, "&")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

function normKey(s) {
  return String(s || "").trim().toLowerCase();
}

function usablePin(pin) {
  const s = String(pin || "").trim();
  if (!s || s.length < 3) return false;
  if (/^(n\/?a|none|tbd|see\b|various|pending)$/i.test(s)) return false;
  return true;
}

export function normalizeSolicitationRow(row) {
  const r = row || {};
  const documents = parseDocumentLinks(r.document_links);
  return {
    request_id: r.request_id != null ? String(r.request_id) : null,
    start_date: r.start_date || null,
    agency_name: r.agency_name || null,
    type_of_notice_description: r.type_of_notice_description || null,
    short_title: r.short_title || null,
    selection_method_description: r.selection_method_description || null,
    pin: r.pin || null,
    due_date: r.due_date || null,
    contact_name: r.contact_name || null,
    contact_phone: r.contact_phone || null,
    email: r.email || null,
    address_to_request: r.address_to_request || null,
    documents,
    n_documents: documents.length,
    source: CURRENT_SOLICITATIONS_SOURCE,
    dataset_id: CURRENT_SOLICITATIONS_DATASET,
  };
}

// Join a City Record notice to candidate Current Solicitations rows.
// Priority: exact request_id → pin + agency_name → pin alone (only when unique).
//
// Returns { status, match, candidates, basis }:
//   matched   — exactly one preferred join
//   unmatched — lookup completed, nothing found
//   ambiguous — multiple pin-level candidates, no request_id hit
//   unknown   — caller could not complete the lookup (no candidates array)
export function joinSolicitationEnrichment(notice, candidates) {
  if (!Array.isArray(candidates)) {
    return { status: "unknown", match: null, candidates: null, basis: null };
  }
  const rows = candidates.map(normalizeSolicitationRow);
  const noticeId = notice && notice.request_id != null ? String(notice.request_id) : "";
  const noticePin = notice && notice.pin;
  const noticeAgency = notice && (notice.agency_name || notice.agency);

  if (noticeId) {
    const byId = rows.filter((r) => r.request_id && String(r.request_id) === noticeId);
    if (byId.length === 1) {
      return { status: "matched", match: byId[0], candidates: byId, basis: "request_id" };
    }
    if (byId.length > 1) {
      // Same request_id should be unique; treat as matched on the first stable row.
      return { status: "matched", match: byId[0], candidates: byId, basis: "request_id" };
    }
  }

  if (usablePin(noticePin)) {
    const pinKey = normKey(noticePin);
    const byPin = rows.filter((r) => r.pin && normKey(r.pin) === pinKey);
    if (byPin.length === 0) {
      return { status: "unmatched", match: null, candidates: [], basis: "pin" };
    }
    if (noticeAgency) {
      const agencyKey = normKey(noticeAgency);
      const byAgency = byPin.filter((r) => normKey(r.agency_name) === agencyKey);
      if (byAgency.length === 1) {
        return { status: "matched", match: byAgency[0], candidates: byAgency, basis: "pin+agency" };
      }
      if (byAgency.length > 1) {
        return { status: "ambiguous", match: null, candidates: byAgency, basis: "pin+agency" };
      }
    }
    if (byPin.length === 1) {
      return { status: "matched", match: byPin[0], candidates: byPin, basis: "pin" };
    }
    return { status: "ambiguous", match: null, candidates: byPin, basis: "pin" };
  }

  return { status: "unmatched", match: null, candidates: [], basis: noticeId ? "request_id" : "none" };
}

// Build the documents sub-slot status for a solicitation stage entry.
// Class (a) gap when a public source exists but no package documents joined.
export function documentsStatusFor(enrichment) {
  if (!enrichment || enrichment.status === "unknown") return "unknown";
  if (enrichment.status === "ambiguous") return "ambiguous";
  if (enrichment.status === "matched" && enrichment.match) {
    return enrichment.match.n_documents > 0 ? "matched" : "unmatched";
  }
  return "unmatched";
}

// Merge enrichment into solicitation stage detail fields (mutates detail).
export function applySolicitationDetail(detail, enrichment) {
  const d = detail || {};
  const docsStatus = documentsStatusFor(enrichment);
  d.documents_status = docsStatus;
  d.enrichment_basis = enrichment && enrichment.basis ? enrichment.basis : null;
  d.enrichment_source = CURRENT_SOLICITATIONS_SOURCE;

  if (enrichment && enrichment.status === "matched" && enrichment.match) {
    const m = enrichment.match;
    d.due_date = m.due_date || d.due_date || null;
    d.selection_method = m.selection_method_description || d.selection_method || null;
    d.contact_name = m.contact_name || d.contact_name || null;
    d.contact_phone = m.contact_phone || d.contact_phone || null;
    d.email = m.email || d.email || null;
    d.address_to_request = m.address_to_request || d.address_to_request || null;
    d.documents = m.documents || [];
    d.n_documents = m.n_documents || 0;
    d.ocp_request_id = m.request_id || null;
    d.ocp_title = m.short_title || null;
    if (m.start_date && !d.date) d.enrichment_date = m.start_date;
  } else {
    d.documents = [];
    d.n_documents = 0;
  }
  return d;
}
