// MTA Construction & Development plan-holder listings. The current-opportunities page links one
// "Plan Holders Listing" PDF per open solicitation: a dated report of every firm that obtained the
// contract documents. This module reads the page's links and the listings' layout text exactly as
// published; it infers nothing about who will bid.
import { createHash } from "node:crypto";

export const MTA_PLAN_HOLDERS_SCHEMA = "cityscroll.mta_plan_holders.v1";
export const MTA_CURRENT_OPPORTUNITIES_URL = "https://www.mta.info/agency/construction-and-development/contracting/current-opportunities";

const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const STAGES = [
  [/^active solicitations$/i, "active"],
  [/^contracts at the pre-qualification stage$/i, "pre_qualification"],
  [/^requests for information$/i, "request_for_information"],
];

const entities = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
const plain = (html) => entities(String(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** "17-NOV-26" -> "2026-11-17"; "NOV-09-26 09:00 AM" -> "2026-11-09T09:00". */
export function listingDate(value) {
  const m = /^(\d{2})-([A-Z]{3})-(\d{2})$/.exec(String(value || "").trim());
  return m && MONTHS[m[2]] ? `20${m[3]}-${MONTHS[m[2]]}-${m[1]}` : null;
}
export function reportTimestamp(value) {
  const m = /^([A-Z]{3})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) (AM|PM)$/.exec(String(value || "").trim());
  if (!m || !MONTHS[m[1]]) return null;
  const hour = (Number(m[4]) % 12) + (m[6] === "PM" ? 12 : 0);
  return `20${m[3]}-${MONTHS[m[1]]}-${m[2]}T${String(hour).padStart(2, "0")}:${m[5]}`;
}

/**
 * Each accordion entry on the current-opportunities page: its heading section (stage), the
 * solicitation label as published, the leading solicitation number, an event number in
 * parentheses where one is given, and the plan-holder listing link or null.
 */
export function planHolderListingLinks(html) {
  const text = String(html);
  const headings = [...text.matchAll(/<h([2-4])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({ at: m.index, title: plain(m[2]) }));
  const entries = [];
  for (const m of text.matchAll(/<details[\s\S]*?<\/details>/g)) {
    const heading = headings.filter((h) => h.at < m.index).at(-1)?.title || "";
    const stage = STAGES.find(([pattern]) => pattern.test(heading))?.[1];
    if (!stage) continue;
    const label = plain(/<summary[^>]*>([\s\S]*?)<\/summary>/.exec(m[0])?.[1] || "");
    if (!label) continue;
    const links = [...m[0].matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].filter((a) => /plan\s*holders?/i.test(plain(a[2])));
    const href = links[0] ? new URL(entities(links[0][1]), MTA_CURRENT_OPPORTUNITIES_URL).href : null;
    const number = /^(?:Contract\s+)?([A-Z0-9][A-Z0-9-]*[A-Z0-9])\b/i.exec(label)?.[1] || null;
    const event = /\((\d{10})\)/.exec(label)?.[1] || null;
    entries.push({ label, solicitation_number: number, event_number: event, stage, listing_url: href });
  }
  return entries;
}

/** The page's own "Updated <date>" line, as an ISO date. */
export function pageUpdated(html) {
  const m = /Updated\s+([A-Z][a-z]{2,8})\.?\s+(\d{1,2}),\s+(\d{4})/.exec(plain(html));
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toUpperCase()];
  return month ? `${m[3]}-${month}-${m[2].padStart(2, "0")}` : null;
}

const COLUMNS = [["name", "VENDOR NAME"], ["address", "ADDRESS"], ["city", "CITY"], ["state_zip", "ST ZIP"], ["contact", "CONTACT & E-MAIL"], ["phone", "PHONE#"], ["fax", "FAX#"]];

/**
 * One listing's layout text (pdftotext -layout). Returns the report timestamp, bid number, short
 * title and opening date from the page header, and one row per firm with the fields as printed.
 * A firm's second line carries its e-mail address and, when the name or address wraps, the rest of it.
 */
export function parsePlanHolderListing(layoutText) {
  const lines = String(layoutText).replace(/\f/g, "\n").split("\n");
  const header = { report_at: null, bid_number: null, short_title: null, open_date: null, pages: 0 };
  const holders = [];
  let cols = null;
  let current = null;
  for (const line of lines) {
    const stamp = /([A-Z]{3}-\d{2}-\d{2} \d{2}:\d{2} [AP]M)\s*$/.exec(line);
    if (/NEW YORK CITY TRANSIT/.test(line) && stamp) { header.report_at ??= reportTimestamp(stamp[1]); current = null; continue; }
    if (/Page \d+ of \d+/.test(line)) { header.pages += 1; continue; }
    const bid = /BID NUMBER:\s*(\S+?)\.?\s{2,}(.*?)\s{2,}OPEN DATE:\s*(\d{2}-[A-Z]{3}-\d{2})/.exec(line) || /BID NUMBER:\s*(\S+?)\.?\s+(.*?)\s+OPEN DATE:\s*(\d{2}-[A-Z]{3}-\d{2})/.exec(line);
    if (bid) { header.bid_number ??= bid[1]; header.short_title ??= bid[2].trim(); header.open_date ??= listingDate(bid[3]); continue; }
    if (/^VENDOR NAME\s/.test(line)) { cols = COLUMNS.map(([key, label]) => [key, line.indexOf(label)]); current = null; continue; }
    if (!cols || !line.trim() || /CONTRACT DOCUMENTS HOLDERS LIST|SOLICITATION MANAGEMENT/.test(line)) continue;
    const slice = (i) => line.slice(cols[i][1], i + 1 < cols.length ? cols[i + 1][1] : undefined).trim();
    const fields = Object.fromEntries(cols.map(([key], i) => [key, slice(i)]));
    const stateZip = /([A-Z]{1,2})\s+(\d{5}(?:-\d{4})?)/.exec(line.slice(Math.max(0, cols[3][1] - 2), cols[4][1] + 6));
    const isMain = fields.name && (stateZip || fields.phone || fields.address);
    if (isMain) {
      // The zip may be printed a few columns right of its heading; the contact begins after it.
      const contactFrom = stateZip ? Math.max(cols[4][1], line.indexOf(stateZip[2], cols[3][1] - 2) + stateZip[2].length) : cols[4][1];
      const contact = line.slice(contactFrom, cols[5][1]).trim();
      current = {
        name: fields.name, address: fields.address || null, city: fields.city.replace(/,$/, "") || null,
        state: stateZip?.[1] || null, zip: stateZip?.[2] || null, contact: contact || null, email: null,
        phone: fields.phone || null, fax: fields.fax || null,
      };
      holders.push(current);
    } else if (current) {
      const email = /\S+@\S+/.exec(line)?.[0] || null;
      if (email && !current.email) current.email = email;
      if (fields.name) current.name = `${current.name} ${fields.name}`;
      if (fields.address && !/@/.test(fields.address)) current.address = current.address ? `${current.address} ${fields.address}` : fields.address;
    }
  }
  return { ...header, holders };
}

/**
 * The published artifact: every open solicitation on the page, with its listing (date, opening
 * date, holders) where one is linked and retained, or an explicit no_listing / not_retained state.
 * `listings` maps a listing URL to {bytes, text, retrieved_at, http_status}.
 */
export function buildMtaPlanHolders({ page, listings, retrievedAt }) {
  const entries = planHolderListingLinks(page.html);
  const solicitations = entries.map((entry) => {
    if (!entry.listing_url) return { ...entry, listing_state: "no_listing", listing: null };
    const got = listings.get(entry.listing_url);
    if (!got) return { ...entry, listing_state: "not_retained", listing: null };
    const parsed = parsePlanHolderListing(got.text);
    if (!parsed.report_at || !parsed.holders.length) throw new Error(`unreadable plan-holder listing ${entry.listing_url}`);
    return {
      ...entry,
      listing_state: "listed",
      listing: {
        url: entry.listing_url, retrieved_at: got.retrieved_at, bytes: got.bytes.length, sha256: sha256(got.bytes),
        listed_at: parsed.report_at, bid_number: parsed.bid_number, short_title: parsed.short_title, open_date: parsed.open_date,
        pages: parsed.pages, holders: parsed.holders,
      },
    };
  });
  return {
    schema: MTA_PLAN_HOLDERS_SCHEMA,
    source: {
      publisher: "MTA Construction & Development", page_url: MTA_CURRENT_OPPORTUNITIES_URL, page_updated: pageUpdated(page.html),
      retrieved_at: retrievedAt, page_bytes: Buffer.byteLength(page.html), page_sha256: sha256(page.html),
    },
    limits: [
      "A plan-holder listing names every firm that obtained the contract documents, which can include consultants, suppliers and document services; it is not a list of bidders.",
      "Each listing carries its own report date, which can be earlier than the page's update date.",
      "Fields are shown as printed; long firm names are cut short in the source report.",
    ],
    counts: {
      solicitations: solicitations.length,
      listed: solicitations.filter((s) => s.listing_state === "listed").length,
      no_listing: solicitations.filter((s) => s.listing_state === "no_listing").length,
      not_retained: solicitations.filter((s) => s.listing_state === "not_retained").length,
      holder_rows: solicitations.reduce((n, s) => n + (s.listing?.holders.length || 0), 0),
    },
    solicitations,
  };
}
