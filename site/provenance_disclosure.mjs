import { readerLabel, readerValue } from "./reader_surface_labels.mjs";

const PROVENANCE_DISCLOSURE_NONFINITE_COPY = /^(?:nan|[+-]?infinity)(?:\s|$)/i;
const PROVENANCE_DISCLOSURE_OFFICIAL_HOSTS = new Set([
  "a856-cityrecord.nyc.gov",
  "data.cityofnewyork.us",
  "nyc.legistar.com",
  "passport.cityofnewyork.us",
  "www.checkbooknyc.com",
]);
const PROVENANCE_DISCLOSURE_SOURCE_DEFAULTS = Object.freeze({
  city_record: Object.freeze({ label: "City Record notice", href: "https://a856-cityrecord.nyc.gov/" }),
  warehouse: Object.freeze({ label: "City Record notice", href: "https://data.cityofnewyork.us/d/dg92-zbpx" }),
  socrata: Object.freeze({ label: "NYC Open Data", href: "https://data.cityofnewyork.us/" }),
  legistar: Object.freeze({ label: "NYC Council Legistar", href: "https://nyc.legistar.com/" }),
  enacted_local_law: Object.freeze({ label: "Source law", href: "https://nyc.legistar.com/" }),
  passport: Object.freeze({ label: "PASSPort Public", href: "https://passport.cityofnewyork.us/page.aspx/en/rfp/request_browse_public" }),
  checkbook: Object.freeze({ label: "Checkbook NYC", href: "https://www.checkbooknyc.com/" }),
});

export function provenanceDisclosureValue(field) {
  const raw = field && typeof field === "object" && Object.prototype.hasOwnProperty.call(field, "available")
    ? (field.available === false ? null : field.value)
    : field;
  if (Array.isArray(raw)) {
    const values = raw.map((entry) => provenanceDisclosureValue(entry)).filter((entry) => entry != null);
    return values.length ? values : null;
  }
  if (typeof raw === "number" && !Number.isFinite(raw)) return null;
  const readable = readerValue(raw);
  if (typeof readable === "string" && PROVENANCE_DISCLOSURE_NONFINITE_COPY.test(readable)) return null;
  return readable;
}

function provenanceDisclosureOfficialHref(value) {
  const raw = provenanceDisclosureValue(value);
  if (!raw) return null;
  try {
    const url = new URL(String(raw));
    return url.protocol === "https:" && PROVENANCE_DISCLOSURE_OFFICIAL_HOSTS.has(url.hostname.toLowerCase())
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Resident-facing official source label and URL; raw record keys never leave this projection. */
export function residentOfficialSource({
  sourceSystem = null,
  sourceRecordId = null,
  sourceHref = null,
  objectHref = null,
  label = null,
} = {}) {
  const system = String(provenanceDisclosureValue(sourceSystem) || "").trim().toLowerCase();
  const recordId = String(provenanceDisclosureValue(sourceRecordId) || "").trim();
  const fallback = PROVENANCE_DISCLOSURE_SOURCE_DEFAULTS[system] || null;
  let href = provenanceDisclosureOfficialHref(sourceHref) || provenanceDisclosureOfficialHref(objectHref);

  const noticeId = recordId.match(/(?:^|:)(\d{11})$/)?.[1] || null;
  if (!href && noticeId && ["city_record", "warehouse"].includes(system)) {
    href = `https://a856-cityrecord.nyc.gov/RequestDetail/${noticeId}`;
  }
  const datasetId = recordId.match(/^([a-z0-9]{4}-[a-z0-9]{4})(?::|$)/i)?.[1] || null;
  if (!href && datasetId && system === "socrata") {
    href = `https://data.cityofnewyork.us/d/${datasetId}`;
  }
  href ||= fallback?.href || null;
  if (!href) return null;
  return Object.freeze({
    href,
    label: readerLabel(provenanceDisclosureValue(label), null) || fallback?.label || "Official source",
  });
}
