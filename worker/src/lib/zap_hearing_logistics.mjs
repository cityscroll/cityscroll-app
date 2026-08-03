/**
 * ZAP disposition public-hearing logistics.
 *
 * Free-text lives on disposition attributes:
 *   dcp-publichearinglocation  — often "In person at <addr> or livestreamed at <url>"
 *   dcp-dateofpublichearing    — ISO datetime (time-of-day is load-bearing)
 *   dcp-votelocation           — separate vote venue when published
 *
 * Pure: no fetch, no env. Extract what is confident; otherwise keep the raw
 * publisher string so the UI never drops or invents logistics.
 */

export const ZAP_HEARING_LOGISTICS_SCHEMA_VERSION = 1;
export const ZAP_HEARING_LOGISTICS_SOURCE = "zap-api-dispositions";

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

/** @returns {string|null} YYYY-MM-DD */
export function isoDateOnly(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Preserve full ISO datetime when the publisher includes a clock time.
 * Date-only values stay YYYY-MM-DD (day precision).
 * @returns {string|null}
 */
export function isoDateTime(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  // Already date-only.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) {
    // Fall back to date prefix when parse fails.
    return isoDateOnly(s);
  }
  // Midnight UTC with no explicit non-zero time → keep date-only to avoid
  // inventing a local wall-clock from a date-only CRM field.
  if (/T00:00:00(?:\.0+)?Z$/i.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return isoDateOnly(s);
  }
  return new Date(t).toISOString();
}

/**
 * Normalize a bare host or www URL into https://…
 * Rejects javascript: and non-http schemes.
 */
export function normalizeHttpUrl(raw) {
  let s = clean(raw);
  if (!s) return null;
  s = s.replace(/[),.;\]}>'"]+$/g, "");
  if (/^javascript:/i.test(s) || /^data:/i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) {
    // Bare host / www.youtube.com/@channel
    if (/^(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?$/i.test(s)) {
      s = `https://${s}`;
    } else return null;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function isLivestreamUrl(url) {
  return /\b(?:youtube\.com|youtu\.be|vimeo\.com|facebook\.com\/.*live|twitch\.tv)\b/i.test(
    String(url || ""),
  );
}

/**
 * Parse free-text hearing location into venue + livestream when confident.
 * Never invents a street address or URL — unparsed fragments stay on `raw`.
 *
 * @param {string|null|undefined} rawLocation
 * @returns {{
 *   raw: string|null,
 *   venue_address: string|null,
 *   livestream_url: string|null,
 *   attendance_modes: string[],
 *   parse_status: "parsed"|"partial"|"raw_only"|"empty",
 *   provenance: object,
 * }}
 */
export function parseHearingLocationText(rawLocation) {
  const raw = clean(rawLocation);
  const provenance = {
    field: "dcp-publichearinglocation",
    source: ZAP_HEARING_LOGISTICS_SOURCE,
    derived: [],
  };
  if (!raw) {
    return {
      raw: null,
      venue_address: null,
      livestream_url: null,
      attendance_modes: [],
      parse_status: "empty",
      provenance,
    };
  }

  let venueAddress = null;
  let livestreamUrl = null;
  const modes = new Set();

  // Livestream / watch URL — full http(s) or bare www./host forms.
  const urlPatterns = [
    /(?:livestreamed|live[- ]?streamed|streamed|watch(?:\s+live)?|youtube|live)\s+(?:at|via|on|:)\s*((?:https?:\/\/)?(?:www\.)?[^\s,;]+)/i,
    /((?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be|vimeo\.com)\/[^\s,;]+)/i,
  ];
  for (const re of urlPatterns) {
    const m = re.exec(raw);
    if (!m) continue;
    const url = normalizeHttpUrl(m[1]);
    if (url) {
      livestreamUrl = url;
      modes.add("livestream");
      provenance.derived.push({
        field: "livestream_url",
        method: "regex_location_text",
        excerpt: m[0].slice(0, 120),
      });
      break;
    }
  }

  // In-person address patterns (order matters — more specific first).
  const inPersonPatterns = [
    // "In person at 120-55 Queens Blvd or livestreamed…"
    /in[- ]person\s+at\s+(.+?)(?:\s+or\s+(?:livestreamed|live[- ]?streamed|streamed|watch)|$)/i,
    // "67-29 108TH STREET, FOREST HILLS" (plain address, no "in person")
    null,
  ];
  for (const re of inPersonPatterns) {
    if (!re) continue;
    const m = re.exec(raw);
    if (!m) continue;
    const addr = clean(m[1]);
    if (addr && addr.length >= 5 && !/^https?:/i.test(addr)) {
      venueAddress = addr.replace(/\s+or\s*$/i, "").trim();
      modes.add("in_person");
      provenance.derived.push({
        field: "venue_address",
        method: "regex_in_person_at",
        excerpt: m[0].slice(0, 120),
      });
      break;
    }
  }

  // Plain street-like text with no livestream clause → treat whole string as venue
  // when it looks like an address (digit + street word) and is not pure URL.
  if (!venueAddress && !livestreamUrl) {
    if (
      /\d/.test(raw)
      && /\b(?:street|st|avenue|ave|blvd|boulevard|road|rd|place|pl|broadway|drive|dr|lane|ln|court|ct|plaza|parkway|pkwy)\b/i.test(
        raw,
      )
      && !/^https?:/i.test(raw)
      && !/\byoutube\b/i.test(raw)
    ) {
      venueAddress = raw;
      modes.add("in_person");
      provenance.derived.push({
        field: "venue_address",
        method: "address_shaped_raw",
        excerpt: raw.slice(0, 120),
      });
    }
  } else if (!venueAddress && livestreamUrl) {
    // Remainder after stripping livestream clause may still hold an address.
    const stripped = raw
      .replace(/(?:or\s+)?(?:livestreamed|live[- ]?streamed|streamed|watch(?:\s+live)?).+$/i, "")
      .replace(/^in[- ]person\s+at\s+/i, "")
      .trim()
      .replace(/\s+or\s*$/i, "")
      .trim();
    if (
      stripped
      && stripped.length >= 5
      && /\d/.test(stripped)
      && !/^https?:/i.test(stripped)
      && stripped.toLowerCase() !== raw.toLowerCase()
    ) {
      venueAddress = stripped;
      modes.add("in_person");
      provenance.derived.push({
        field: "venue_address",
        method: "remainder_after_livestream",
        excerpt: stripped.slice(0, 120),
      });
    }
  }

  if (/\bin[- ]person\b/i.test(raw) && !modes.has("in_person") && !venueAddress) {
    modes.add("in_person");
  }
  if (/\b(?:livestream|live[- ]?stream|youtube|watch live)\b/i.test(raw) && !modes.has("livestream")) {
    modes.add("livestream");
  }

  let parseStatus = "raw_only";
  if (venueAddress || livestreamUrl) {
    parseStatus = venueAddress && (livestreamUrl || modes.size <= 1) ? "parsed" : "partial";
    // Hybrid with both fields → parsed.
    if (venueAddress && livestreamUrl) parseStatus = "parsed";
    else if (venueAddress || livestreamUrl) parseStatus = "partial";
  }

  return {
    raw,
    venue_address: venueAddress,
    livestream_url: livestreamUrl,
    attendance_modes: [...modes],
    parse_status: parseStatus,
    provenance,
  };
}

/**
 * Map disposition `representing` to ULURP phase id (same labels as land spine).
 */
export function representingToPhaseId(representing) {
  const r = String(representing || "").toLowerCase();
  if (/community board/.test(r)) return "community_board";
  if (/borough president|borough board/.test(r)) return "borough_president";
  if (/city planning|commission/.test(r)) return "cpc";
  if (/city council|council/.test(r)) return "city_council";
  if (/mayor|appeals/.test(r)) return "mayoral_appeals";
  return null;
}

/**
 * Build one logistics object from a disposition row (after parseZapApiProject fields).
 *
 * @param {object} disposition
 * @param {object} [opts]
 * @param {string|null} [opts.project_id]
 * @param {string|null} [opts.portal_url]
 * @param {string|null} [opts.borough]
 */
export function hearingLogisticsFromDisposition(disposition, opts = {}) {
  const d = disposition || {};
  const locationRaw = clean(d.hearing_location) || clean(d.public_hearing_location);
  const parsed = parseHearingLocationText(locationRaw);
  const hearingAt = isoDateTime(d.hearing_at || d.hearing_datetime || d.hearing_date);
  const hearingDate = isoDateOnly(hearingAt || d.hearing_date);
  if (!hearingDate && !locationRaw) return null;

  const phaseId = representingToPhaseId(d.representing);
  const modes = new Set(parsed.attendance_modes);
  if (parsed.venue_address) modes.add("in_person");
  if (parsed.livestream_url) modes.add("livestream");

  const mapsUrl = parsed.venue_address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${parsed.venue_address}, New York, NY`,
    )}`
    : null;

  return {
    schema_version: ZAP_HEARING_LOGISTICS_SCHEMA_VERSION,
    source: ZAP_HEARING_LOGISTICS_SOURCE,
    project_id: clean(opts.project_id) || null,
    portal_url: clean(opts.portal_url) || null,
    borough: clean(opts.borough) || null,
    disposition_id: d.id || null,
    disposition_name: clean(d.name) || null,
    representing: clean(d.representing) || null,
    phase_id: phaseId,
    hearing_date: hearingDate,
    hearing_at: hearingAt,
    hearing_location_raw: locationRaw,
    venue_address: parsed.venue_address,
    livestream_url: parsed.livestream_url,
    vote_location: clean(d.vote_location) || null,
    attendance_modes: [...modes],
    maps_url: mapsUrl,
    parse_status: parsed.parse_status,
    provenance: {
      ...parsed.provenance,
      hearing_at: {
        field: "dcp-dateofpublichearing",
        source: ZAP_HEARING_LOGISTICS_SOURCE,
        value: hearingAt,
      },
      representing: {
        field: "dcp-representing",
        source: ZAP_HEARING_LOGISTICS_SOURCE,
        value: clean(d.representing),
      },
    },
  };
}

/**
 * Collapse disposition logistics that share the same body + datetime + location
 * (ZM/ZR duplicates for one hearing).
 */
export function dedupeHearingLogistics(rows) {
  const seen = new Map();
  for (const row of rows || []) {
    if (!row) continue;
    const key = [
      row.representing || "",
      row.hearing_at || row.hearing_date || "",
      row.hearing_location_raw || "",
      row.venue_address || "",
      row.livestream_url || "",
    ]
      .join("|")
      .toLowerCase();
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()].sort((a, b) =>
    String(a.hearing_at || a.hearing_date || "").localeCompare(
      String(b.hearing_at || b.hearing_date || ""),
    )
  );
}

/**
 * Extract logistics array from a parseZapApiProject record.
 */
export function extractZapHearingLogistics(record, opts = {}) {
  const projectId = clean(record?.project_id) || clean(opts.project_id) || null;
  const portalUrl = clean(record?.portal_url) || clean(opts.portal_url) || null;
  const borough = clean(opts.borough) || clean(record?.open_data?.borough) || null;
  const rows = (record?.dispositions || [])
    .map((d) => hearingLogisticsFromDisposition(d, {
      project_id: projectId,
      portal_url: portalUrl,
      borough,
    }))
    .filter(Boolean);
  return dedupeHearingLogistics(rows);
}

/**
 * Filter logistics for an upcoming-hearings view.
 *
 * @param {object[]} rows
 * @param {object} [filter]
 * @param {string} [filter.today] YYYY-MM-DD
 * @param {string} [filter.borough]
 * @param {string} [filter.mode] in_person | livestream
 * @param {boolean} [filter.upcoming_only=true]
 */
export function filterHearingLogistics(rows, filter = {}) {
  const today = isoDateOnly(filter.today) || new Date().toISOString().slice(0, 10);
  const borough = clean(filter.borough);
  const mode = clean(filter.mode);
  const upcomingOnly = filter.upcoming_only !== false;
  return (rows || []).filter((row) => {
    if (!row) return false;
    const day = isoDateOnly(row.hearing_date || row.hearing_at);
    if (upcomingOnly) {
      if (!day || day < today) return false;
    }
    if (borough) {
      const b = String(row.borough || "").toLowerCase();
      if (b !== borough.toLowerCase()) return false;
    }
    if (mode === "in_person") {
      if (!(row.attendance_modes || []).includes("in_person") && !row.venue_address) return false;
    } else if (mode === "livestream") {
      if (!(row.attendance_modes || []).includes("livestream") && !row.livestream_url) return false;
    }
    return true;
  });
}

/**
 * Shape a logistics row into the hearing object zoningHandoff / landActionMatter expect.
 */
export function logisticsToActionHearing(row) {
  if (!row) return null;
  const venue = row.venue_address
    ? { address: row.venue_address, building: null, mode: row.attendance_modes?.includes("livestream") && row.venue_address ? "hybrid" : "in-person" }
    : row.livestream_url
      ? { address: null, building: null, mode: "virtual" }
      : null;
  return {
    request_id: null,
    event_date: row.hearing_at || row.hearing_date || null,
    agency: row.representing || null,
    title: row.representing
      ? `${row.representing} public hearing`
      : "Public hearing",
    notice_text: row.hearing_location_raw || "",
    venue,
    participation: row.livestream_url
      ? { links: [{ url: row.livestream_url, kind: "livestream" }] }
      : null,
    participation_url: row.livestream_url || null,
    street_address_1: row.venue_address || null,
    source_url: row.portal_url || null,
    body_kind: row.phase_id || null,
    maps_url: row.maps_url || null,
    livestream_url: row.livestream_url || null,
    hearing_location_raw: row.hearing_location_raw || null,
    parse_status: row.parse_status || null,
    provenance: row.provenance || null,
    source: "zap_disposition",
  };
}
