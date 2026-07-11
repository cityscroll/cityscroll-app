// Socrata → D1 ingest for the notices mirror (ported from Dev Doshi's crol-alert ingest.ts).
//
// Dataset: City Record Online, dg92-zbpx (DCAS). Socrata stays the SOURCE OF TRUTH —
// D1 is a cache the daily cron refreshes; the raw row is stored per notice so a field
// rename upstream is recoverable (re-verify with:
//   curl 'https://data.cityofnewyork.us/api/views/dg92-zbpx/columns.json').
//
// Fail-soft by design: no D1 binding → skipped; any error is the caller's to log,
// never to let block the alerts run. Cursor (max ingested start_date) lives in the
// ingest_state table; first run backfills 30 days.

const PAGE = 1000;
const MAX_PAGES = 20; // safety cap per run
const ROLLING_YEAR = 2090; // due dates >= this are rolling placeholders, not real deadlines
const AMOUNT_CAP = 1e10;   // EDA: 3 rows >= $10B are data-entry errors (max legit ≈ $6.68B)

export function pick(row, keys) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return null;
}

export function toDateISO(v) {
  if (!v) return null;
  if (v.includes("T")) return v.slice(0, 10); // ISO floating timestamp
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // MM/DD/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

export function toDateTimeISO(v) {
  if (!v) return { iso: null, year: null };
  if (v.includes("T")) {
    const iso = v.replace("T", " ").slice(0, 19);
    return { iso, year: Number(iso.slice(0, 4)) };
  }
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(.*))?/);
  if (m) {
    const date = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    return { iso: `${date} 00:00:00`, year: Number(m[3]) };
  }
  return { iso: null, year: null };
}

export function cleanAmount(v) {
  if (!v) return { amount: null, valid: 0 };
  const n = Number(String(v).replace(/[$,]/g, "").trim());
  if (!isFinite(n)) return { amount: null, valid: 0 };
  return { amount: n, valid: n > 0 && n < AMOUNT_CAP ? 1 : 0 };
}

export function docUrls(v) {
  if (!v) return [];
  return v
    .replace(/&amp;/g, "&")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("http"));
}

// Socrata field names verified against the live API metadata (2026-06, crol-alert).
// Note: event-location fields have NO event_ prefix in the source.
export function mapRow(row) {
  const description = pick(row, ["additional_description_1"]);
  const otherInfo = pick(row, ["other_info_1"]);
  const printout = pick(row, ["printout_1"]);
  const agency = pick(row, ["agency_name"]);
  const shortTitle = pick(row, ["short_title"]);
  const due = toDateTimeISO(pick(row, ["due_date"]));
  const amt = cleanAmount(pick(row, ["contract_amount"]));
  const docs = docUrls(pick(row, ["document_links"]));
  const haystack = [shortTitle, description, printout, otherInfo, agency]
    .filter(Boolean)
    .join(" ¦ ")
    .toLowerCase();

  return {
    request_id: pick(row, ["request_id"]),
    section: pick(row, ["section_name"]),
    agency,
    type_of_notice: pick(row, ["type_of_notice_description"]),
    category: pick(row, ["category_description"]),
    short_title: shortTitle,
    selection_method: pick(row, ["selection_method_description"]),
    special_case_reason: pick(row, ["special_case_reason_description"]),
    pin: pick(row, ["pin"]),
    vendor_name: pick(row, ["vendor_name"]),
    description,
    other_info: otherInfo,
    printout,
    contract_amount: amt.amount,
    contract_amount_valid: amt.valid,
    start_date: toDateISO(pick(row, ["start_date"])),
    due_date: due.iso,
    due_year: due.year,
    event_date: toDateTimeISO(pick(row, ["event_date"])).iso,
    event_building: pick(row, ["building_name"]),
    event_addr1: pick(row, ["street_address_1"]),
    event_city: pick(row, ["city"]),
    event_state: pick(row, ["state"]),
    event_zip: pick(row, ["zip_code"]),
    document_urls: JSON.stringify(docs),
    n_documents: docs.length,
    haystack,
    raw: JSON.stringify(row),
  };
}

async function stateGet(db, k) {
  const r = await db.prepare("SELECT v FROM ingest_state WHERE k = ?").bind(k).first();
  return r ? r.v : null;
}
async function stateSet(db, k, v) {
  await db.prepare("INSERT OR REPLACE INTO ingest_state (k, v) VALUES (?, ?)").bind(k, v).run();
}

export async function ingestNotices(env) {
  if (!env.DB) return { skipped: "no-d1-binding" };
  const dataset = env.SOCRATA_DATASET || "dg92-zbpx";

  let cursor = await stateGet(env.DB, "ingest_cursor");
  if (!cursor) cursor = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

  const base = `https://data.cityofnewyork.us/resource/${dataset}.json`;
  let fetched = 0;
  let upserted = 0;
  let maxStart = cursor;

  const insert = env.DB.prepare(
    `INSERT OR REPLACE INTO notices
       (request_id, section, agency, type_of_notice, category, short_title,
        selection_method, special_case_reason, pin, vendor_name, description,
        other_info, printout, contract_amount, contract_amount_valid, start_date,
        due_date, due_year, event_date, event_building, event_addr1, event_city,
        event_state, event_zip, document_urls, n_documents, haystack, raw, ingested_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const nowISO = new Date().toISOString();

  for (let page = 0; page < MAX_PAGES; page++) {
    const where = encodeURIComponent(`start_date >= '${cursor}T00:00:00'`);
    const url = `${base}?$where=${where}&$order=start_date&$limit=${PAGE}&$offset=${page * PAGE}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`SODA ${r.status}: ${await r.text()}`);
    const rows = await r.json();
    if (rows.length === 0) break;
    fetched += rows.length;

    const stmts = [];
    for (const row of rows) {
      const m = mapRow(row);
      if (!m.request_id) continue;
      if (m.start_date && m.start_date > maxStart) maxStart = m.start_date;
      stmts.push(
        insert.bind(
          m.request_id, m.section, m.agency, m.type_of_notice, m.category, m.short_title,
          m.selection_method, m.special_case_reason, m.pin, m.vendor_name, m.description,
          m.other_info, m.printout, m.contract_amount, m.contract_amount_valid, m.start_date,
          m.due_date, m.due_year, m.event_date, m.event_building, m.event_addr1, m.event_city,
          m.event_state, m.event_zip, m.document_urls, m.n_documents, m.haystack, m.raw, nowISO,
        ),
      );
    }
    if (stmts.length) {
      await env.DB.batch(stmts);
      upserted += stmts.length;
    }
    if (rows.length < PAGE) break;
  }

  await stateSet(env.DB, "ingest_cursor", maxStart);
  return { fetched, upserted, cursor: maxStart };
}
