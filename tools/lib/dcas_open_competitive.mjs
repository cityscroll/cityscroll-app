/**
 * Build-time acquisition of the DCAS open-competitive exam schedule page.
 *
 * The schedule table at nyc.gov is the authoritative public list of exams that
 * are open to anyone right now: it carries the exam number, the title, the
 * application window, and the link to each Notice of Examination (NOE) PDF.
 * Until this module existed the snapshot under
 * `site/data/exam_sources/dcas_open_competitive.json` was refreshed only by a
 * hand-committed review, so an amended window (a deadline extension, a
 * cancellation, or a new monthly release) reached the site only when someone
 * remembered to re-read the page.
 *
 * The functions here are pure. The caller supplies the fetched HTML, the
 * OASys active-exam rows, and the previously committed snapshot; nothing in
 * this file reads the clock, the network, or the filesystem.
 */

/** Fields describing the job itself, safe to carry across a window change. */
export const DCAS_DURABLE_DETAIL_FIELDS = Object.freeze([
  "title_code",
  "fee_waiver",
  "salary_min",
  "salary_max",
  "salary_note",
  "summary",
  "qualifications",
  "test_method",
]);

/** Fields describing one filing cycle; dropped when the window moves. */
export const DCAS_CYCLE_SCOPED_FIELDS = Object.freeze(["amendment"]);

const MONTH_DAY_YEAR = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&ndash;/gi, "-")
    .replace(/&mdash;/gi, "-")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cellText(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** `9/2/2026` → `2026-09-02`; anything else → null. */
export function dcasCalendarDate(value) {
  const match = MONTH_DAY_YEAR.exec(String(value ?? "").trim());
  if (!match) return null;
  const [, month, day, year] = match;
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return Number.isFinite(Date.parse(`${iso}T00:00:00Z`)) ? iso : null;
}

/**
 * Split an application-period cell into a start/end pair and a status.
 * DCAS writes cancellations and postponements as prose in the same column.
 */
export function parseApplicationPeriod(value) {
  const raw = decodeEntities(value || "").replace(/\s+/g, " ").trim();
  const lower = raw.toLowerCase();
  const status = lower.includes("cancel")
    ? "canceled"
    : lower.includes("postpon")
      ? "postponed"
      : "scheduled";
  const parts = raw.split(/\s*[-‐-―−]\s*/).map((part) => part.trim());
  const start = dcasCalendarDate(parts[0]);
  const end = dcasCalendarDate(parts[1]);
  return { application_start: start, application_end: end, schedule_status: status, period_text: raw };
}

function absoluteNoticeUrl(href, pageUrl) {
  if (!href) return null;
  try {
    return new URL(decodeEntities(href), pageUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Parse the single schedule table on the DCAS open-competitive page.
 * Returns one row per exam in publisher order; throws when the page no longer
 * carries a recognisable table so a layout change fails loudly instead of
 * silently emptying the snapshot.
 */
export function parseDcasOpenCompetitivePage(html, { pageUrl } = {}) {
  const tables = String(html || "").match(/<table[\s\S]*?<\/table>/gi) || [];
  const rows = [];
  for (const table of tables) {
    for (const rowHtml of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = rowHtml.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
      if (cells.length < 3) continue;
      const title = cellText(cells[0]);
      const examCell = cellText(cells[1]);
      const examNumber = (examCell.match(/\b\d{4}\b/) || [])[0] || null;
      if (!examNumber || !title) continue;
      const href = (cells[1].match(/href\s*=\s*"([^"]+)"/i)
        || cells[1].match(/href\s*=\s*'([^']+)'/i)
        || [])[1] || null;
      rows.push({
        exam_number: examNumber,
        title,
        notice_url: absoluteNoticeUrl(href, pageUrl),
        ...parseApplicationPeriod(cellText(cells[2])),
      });
    }
  }
  if (!rows.length) {
    throw new Error("DCAS open-competitive page carried no recognisable exam rows");
  }
  return rows;
}

/** Index OASys `GetActiveExams` rows by exam number for cross-checking. */
export function indexOasysActiveExams(rows) {
  const index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const examNumber = String(row?.examNumber ?? "").trim();
    if (!/^\d{4}$/.test(examNumber)) continue;
    index.set(examNumber, {
      exam_number: examNumber,
      title: String(row.title || "").trim() || null,
      filing_start: String(row.filingStart || "").slice(0, 10) || null,
      filing_end: String(row.filingEnd || "").slice(0, 10) || null,
      fee: Number.isFinite(Number(row.filingFee)) ? Number(row.filingFee) : null,
      promotional: row.isPromotional === true,
      oasys_exam_id: Number.isFinite(Number(row.examId)) ? Number(row.examId) : null,
    });
  }
  return index;
}

function priorByExamNumber(prior) {
  const index = new Map();
  for (const record of prior?.records || []) {
    const examNumber = String(record?.exam_number ?? "").trim();
    if (examNumber) index.set(examNumber, record);
  }
  return index;
}

/**
 * Build the refreshed open-competitive snapshot.
 *
 * Live page values win for anything the publisher restates each release
 * (title, window, NOE link, status). Reviewed prose from the previous snapshot
 * is carried forward only while it still describes the same exam, and
 * window-scoped notes are dropped as soon as the window moves — a refreshed
 * snapshot never repeats last month's amendment note about a new deadline.
 */
export function buildOpenCompetitiveSnapshot({
  pageRows,
  oasysIndex = new Map(),
  noticeDetail = new Map(),
  prior = null,
  verifiedAt,
  pageUrl,
  fetchedAt,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(verifiedAt || ""))) {
    throw new Error("open-competitive snapshot needs an ISO verified_at date");
  }
  const priorIndex = priorByExamNumber(prior);
  const carried = [];
  const records = (pageRows || []).map((row) => {
    const previous = priorIndex.get(row.exam_number) || null;
    const oasys = oasysIndex.get(row.exam_number) || null;
    const record = {
      exam_number: row.exam_number,
      title: row.title,
      application_start: row.application_start,
      application_end: row.application_end,
      eligibility: "open_competitive",
      notice_url: row.notice_url,
    };
    if (row.schedule_status !== "scheduled") record.application_notes = row.period_text;
    if (oasys && oasys.fee != null) record.fee = oasys.fee;
    else if (previous && previous.fee != null) record.fee = previous.fee;
    const sameCycle = Boolean(
      previous
      && previous.application_start === record.application_start
      && previous.application_end === record.application_end,
    );
    if (previous) {
      const fields = [];
      for (const field of DCAS_DURABLE_DETAIL_FIELDS) {
        const value = previous[field];
        if (value == null || value === "") continue;
        if (record[field] != null && record[field] !== "") continue;
        record[field] = value;
        fields.push(field);
      }
      if (sameCycle) {
        for (const field of DCAS_CYCLE_SCOPED_FIELDS) {
          const value = previous[field];
          if (value == null || value === "") continue;
          record[field] = value;
          fields.push(field);
        }
      }
      if (fields.length) carried.push({ exam_number: row.exam_number, fields: fields.sort(), same_cycle: sameCycle });
    }
    // Amounts the notice itself states, used only where reviewed prose left a hole.
    const notice = noticeDetail.get(row.exam_number) || null;
    if (notice) {
      for (const field of ["fee", "salary_min", "salary_max", "salary_note", "test_method"]) {
        const value = notice[field];
        if (value == null || value === "") continue;
        if (record[field] != null && record[field] !== "") continue;
        record[field] = value;
      }
    }
    return record;
  });
  const observed = (pageRows || []).map((row) => {
    const oasys = oasysIndex.get(row.exam_number) || null;
    const previous = priorIndex.get(row.exam_number) || null;
    return {
      exam_number: row.exam_number,
      title: row.title,
      present_on_page: true,
      live_application_start: row.application_start,
      live_application_end: row.application_end,
      schedule_status: row.schedule_status,
      noe_path_present: Boolean(row.notice_url),
      notice_url: row.notice_url,
      oasys_present: Boolean(oasys),
      oasys_filing_start: oasys?.filing_start ?? null,
      oasys_filing_end: oasys?.filing_end ?? null,
      oasys_agrees: oasys
        ? oasys.filing_start === row.application_start && oasys.filing_end === row.application_end
        : null,
      previous_application_start: previous?.application_start ?? null,
      previous_application_end: previous?.application_end ?? null,
      changed_since_previous: previous
        ? previous.application_start !== row.application_start
          || previous.application_end !== row.application_end
        : null,
    };
  });
  // Every Notice of Examination states an application fee, but not every one
  // states a yearly salary: some print an hourly rate instead, and a few state
  // no salary at all. Those exams stay on the page with the amounts the notice
  // does give, and say plainly why no annual minimum appears beside them.
  const unstated = [];
  for (const record of records) {
    if (!record.notice_url) continue;
    if (record.salary_min != null && record.salary_min !== "") continue;
    const notice = noticeDetail.get(record.exam_number) || null;
    record.salary_publication = notice?.salary_rate_stated
      ? "The notice states a rate for this title rather than a yearly minimum salary."
      : "The notice does not state a minimum annual salary for this title.";
    unstated.push({
      exam_number: record.exam_number,
      title: record.title,
      notice_url: record.notice_url,
      fee: record.fee ?? null,
      reason: record.salary_publication,
    });
  }
  const published = records;
  const liveNumbers = new Set(published.map((record) => record.exam_number));
  const snapshot = {
    source: {
      ...(prior?.source || {}),
      id: "dcas-open-competitive",
      name: prior?.source?.name || "DCAS Open Competitive Exams for Anyone",
      url: pageUrl,
      verified_at: verifiedAt,
      fetched_at: fetchedAt || verifiedAt,
      refresh_cadence: prior?.source?.refresh_cadence
        || "Check daily while an application window is open; DCAS publishes a monthly schedule and may amend individual NOEs between releases.",
      stale_after_days: prior?.source?.stale_after_days ?? 35,
      method: "The published schedule table is read directly and cross-checked against the OASys active-exam listing. Reviewed Notice of Examination prose from the previous snapshot is carried forward only while the exam and its filing window are unchanged.",
    },
    records: published,
  };
  return {
    snapshot,
    observed,
    carried,
    dropped_exam_numbers: [...priorIndex.keys()].filter((examNumber) => !liveNumbers.has(examNumber)).sort(),
    unstated_annual_salary: unstated,
    added_exam_numbers: published
      .map((record) => record.exam_number)
      .filter((examNumber) => !priorIndex.has(examNumber))
      .sort(),
  };
}
