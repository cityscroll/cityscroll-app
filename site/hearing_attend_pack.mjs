function esc(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

function localParts(value) {
  const raw = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
  if (!match) return null;
  const dateOnly = !match[4];
  // Unsuffixed City Record timestamps are New York wall time; explicitly zoned
  // timestamps are instants and must be converted to that same wall-time zone.
  if (!dateOnly && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const instant = new Date(raw);
    if (Number.isNaN(instant.getTime())) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(instant).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    return {year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second, dateOnly: false};
  }
  return {year: +match[1], month: +match[2], day: +match[3], hour: +(match[4] || 0), minute: +(match[5] || 0), second: +(match[6] || 0), dateOnly};
}

function stamp(parts) {
  const pad = value => String(value).padStart(2, "0");
  return `${parts.year}${pad(parts.month)}${pad(parts.day)}T${pad(parts.hour)}${pad(parts.minute)}${pad(parts.second)}`;
}

function fold(line) {
  const encoder = new TextEncoder();
  const chunks = [];
  let chunk = "", bytes = 0, limit = 75;
  for (const character of String(line)) {
    const size = encoder.encode(character).length;
    if (chunk && bytes + size > limit) {
      chunks.push(chunk); chunk = character; bytes = size; limit = 74;
    } else { chunk += character; bytes += size; }
  }
  chunks.push(chunk);
  return chunks.join("\r\n ");
}

function httpsUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" ? url.toString() : null; }
  catch (_error) { return null; }
}

/** Importable hearing event with an explicit New York wall-time contract. */
export function hearingCalendarICS(record, options = {}) {
  const r = record || {};
  const start = localParts(r.event_date || r.deadline);
  if (!start) return null;
  const id = String(r.request_id || r.id || stamp(start)).trim();
  const title = String(r.short_title || r.title || "Public hearing").trim();
  const agency = String(r.agency_name || r.agency || "").trim();
  const venue = r.venue || {};
  const access = r.meeting_access || {};
  const location = access.in_person_location
    || [venue.building || r.building_name, venue.address || [r.street_address_1, r.street_address_2, r.city, r.state, r.zip_code].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
  const joinUrl = access.remote_join_url
    || r.remote_join_url
    || r.participation?.remote_join_url
    || r.participation?.links?.find((link) => link?.label === "Join online")?.url
    || null;
  const dialIn = access.dial_in || r.participation?.phones || [];
  const source = httpsUrl(r.official_notice_url) || httpsUrl(r.source_url) || null;
  const now = options.now ? new Date(options.now) : new Date();
  const dtstamp = (Number.isNaN(now.getTime()) ? new Date() : now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CityScroll//Hearing Attend Pack//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VTIMEZONE", "TZID:America/New_York", "X-LIC-LOCATION:America/New_York",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "TZNAME:EDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "TZNAME:EST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
    "END:VTIMEZONE", "BEGIN:VEVENT", `UID:${esc(id)}@cityscroll.org`, `DTSTAMP:${dtstamp}`,
  ];
  if (start.dateOnly) {
    const pad = value => String(value).padStart(2, "0");
    lines.push(`DTSTART;VALUE=DATE:${start.year}${pad(start.month)}${pad(start.day)}`);
    const end = new Date(Date.UTC(start.year, start.month - 1, start.day + 1));
    lines.push(`DTEND;VALUE=DATE:${end.getUTCFullYear()}${pad(end.getUTCMonth() + 1)}${pad(end.getUTCDate())}`);
  } else {
    const value = new Date(Date.UTC(start.year, start.month - 1, start.day, start.hour + 1, start.minute, start.second));
    const end = {year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate(), hour: value.getUTCHours(), minute: value.getUTCMinutes(), second: value.getUTCSeconds()};
    lines.push(`DTSTART;TZID=America/New_York:${stamp(start)}`, `DTEND;TZID=America/New_York:${stamp(end)}`);
  }
  lines.push(`SUMMARY:${esc(title)}`, ...(location ? [`LOCATION:${esc(location)}`] : []),
    ...(joinUrl ? [`URL:${esc(joinUrl)}`] : []),
    `DESCRIPTION:${esc([agency, location ? `Location: ${location}` : null, joinUrl ? `Join online: ${joinUrl}` : null, dialIn.length ? `Dial-in: ${dialIn.join(", ")}` : null, source ? `Official source: ${source}` : null].filter(Boolean).join("\n"))}`,
    "BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", "DESCRIPTION:Hearing tomorrow", "END:VALARM", "END:VEVENT", "END:VCALENDAR", "");
  return lines.map(fold).join("\r\n");
}
