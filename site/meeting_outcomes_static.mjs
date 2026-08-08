import { officialSourceLink } from "./affordance_grammar.mjs";

export const MEETING_OUTCOMES_SNAPSHOT_SCHEMA = "cityscroll.meeting_outcomes_snapshot.v1";

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function esc(value) {
  return clean(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeHttps(value) {
  try {
    const url = new URL(clean(value));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function outcomeBucket(value) {
  const text = clean(value).toLowerCase();
  if (/\b(approved|adopted|confirmed|favorably|passed)\b/.test(text)) return "approved";
  if (/\bre-?refer|\breferred\b/.test(text)) return "referred";
  if (/\b(hearing held|held by|deferred|laid over|postponed|tabled)\b/.test(text)) return "held";
  return "other";
}

function compactVotes(votes) {
  const row = Array.isArray(votes) ? votes.at(-1) : null;
  if (!row) return null;
  const counts = row.counts || {};
  const result = {
    result: clean(row.result || row.action || row.vote_result) || null,
    yes: Number.isFinite(Number(counts.yes)) ? Number(counts.yes) : null,
    no: Number.isFinite(Number(counts.no)) ? Number(counts.no) : null,
    abstain: Number.isFinite(Number(counts.abstain)) ? Number(counts.abstain) : null,
  };
  return Object.values(result).some((value) => value != null && value !== "") ? result : null;
}

export function compactMeetingOutcomeRecord(record) {
  const requestId = clean(record?.request_id || record?.notice?.request_id);
  if (!requestId) return null;
  if (record?.join?.matched !== true) {
    return { request_id: requestId, snapshot_state: "absent" };
  }
  const event = record.council_event || {};
  const documents = (event.documents || []).map((doc) => ({
    name: clean(doc?.name || doc?.category || "Decision document"),
    url: safeHttps(doc?.url),
  })).filter((doc) => doc.url).slice(0, 8);
  const matters = new Map();
  for (const item of record.agenda_items || []) {
    for (const matter of item?.matters || []) {
      const id = clean(matter?.matter_id || matter?.matter_file);
      if (!id) continue;
      const key = clean(matter.matter_file || matter.matter_id);
      const prior = matters.get(key) || { actions: [], documents: [] };
      const outcome = clean(matter.outcome || matter.passed || matter.status);
      if (outcome && !prior.actions.includes(outcome)) prior.actions.push(outcome);
      const matterDocuments = (matter.documents || []).map((doc) => ({
        name: clean(doc?.name || "Matter document"),
        url: safeHttps(doc?.url),
      })).filter((doc) => doc.url);
      matters.set(key, {
        ...prior,
        matter_id: clean(matter.matter_id) || null,
        matter_file: clean(matter.matter_file) || null,
        matter_url: safeHttps(matter.matter_url),
        title: clean(matter.title || item.title) || key,
        outcome: outcome || prior.outcome || null,
        votes: compactVotes(matter.votes) || prior.votes || null,
        documents: [...prior.documents, ...matterDocuments]
          .filter((doc, index, rows) => rows.findIndex((other) => other.url === doc.url) === index)
          .slice(0, 6),
      });
    }
  }
  return {
    request_id: requestId,
    snapshot_state: "present",
    event: {
      event_id: clean(event.event_id) || null,
      name: clean(event.body_name || event.title) || "Council meeting",
      date: clean(event.event_date || event.start_time).slice(0, 10) || null,
      url: safeHttps(event.event_url),
      documents,
    },
    matters: [...matters.values()].slice(0, 40),
  };
}

export function buildMeetingOutcomesSnapshot(records, { generatedAt = new Date().toISOString() } = {}) {
  const byNotice = {};
  for (const record of records || []) {
    const compact = compactMeetingOutcomeRecord(record);
    if (compact) byNotice[compact.request_id] = compact;
  }
  const values = Object.values(byNotice);
  return {
    schema: MEETING_OUTCOMES_SNAPSHOT_SCHEMA,
    generated_at: generatedAt,
    delivery_tier: "inline-at-build",
    record_count: values.length,
    present_count: values.filter((row) => row.snapshot_state === "present").length,
    absent_count: values.filter((row) => row.snapshot_state === "absent").length,
    by_notice: byNotice,
  };
}

function documentLinks(documents) {
  return documents.map((doc) =>
    officialSourceLink({ href: doc.url, label: doc.name, className: "view meeting-source-link", escape: esc }),
  ).join("");
}

export function renderMeetingOutcomesFirstPaint(snapshotOrRecord, requestId) {
  const record = snapshotOrRecord?.schema === MEETING_OUTCOMES_SNAPSHOT_SCHEMA
    ? snapshotOrRecord.by_notice?.[clean(requestId)]
    : snapshotOrRecord;
  if (!record) return "";
  if (record.snapshot_state !== "present") {
    return `<section class="meeting-outcomes-static" data-meeting-outcomes-first-paint="1" data-meeting-outcomes-state="absent">
      <div class="chain-h">Decision documents and outcomes</div>
      <div class="note">No decision documents published for this meeting.</div>
    </section>`;
  }
  const event = record.event || {};
  const eventLink = event.url
    ? officialSourceLink({ href: event.url, label: event.name, className: "view meeting-source-link", escape: esc })
    : esc(event.name);
  const allDocuments = [
    ...(event.documents || []),
    ...(record.matters || []).flatMap((matter) => matter.documents || []),
  ].filter((doc, index, rows) => rows.findIndex((other) => other.url === doc.url) === index);
  const matters = (record.matters || []).map((matter) => {
    const label = clean(matter.outcome || matter.actions?.at(-1));
    const vote = matter.votes && [matter.votes.yes, matter.votes.no, matter.votes.abstain].some((n) => n != null)
      ? `<p class="meeting-sub">${matter.votes.yes ?? "—"} yes · ${matter.votes.no ?? "—"} no · ${matter.votes.abstain ?? "—"} abstain</p>`
      : "";
    const file = matter.matter_url
      ? officialSourceLink({ href: matter.matter_url, label: matter.matter_file || matter.matter_id, className: "meeting-file meeting-matter-link", escape: esc })
      : `<span class="meeting-file">${esc(matter.matter_file || matter.matter_id)}</span>`;
    return `<li class="meeting-matter" data-outcome-bucket="${outcomeBucket(label)}">
      <div class="meeting-matter-main"><div>${file}<p class="meeting-title">${esc(matter.title)}</p>${vote}</div>
      ${label ? `<span class="meeting-badge meeting-badge--${outcomeBucket(label)}">${esc(label)}</span>` : ""}</div>
    </li>`;
  }).join("");
  return `<section class="meeting-outcomes-static" data-meeting-outcomes-first-paint="1" data-meeting-outcomes-state="present">
    <div class="chain-h">Decision documents and outcomes</div>
    <div class="note">Matched ${eventLink}${event.date ? ` · ${esc(event.date)}` : ""}</div>
    ${allDocuments.length
      ? `<div class="meeting-event-docs"><span class="meeting-docs-lbl">Decision documents</span>${documentLinks(allDocuments)}</div>`
      : `<div class="note">No decision documents published for this meeting.</div>`}
    ${matters ? `<ol class="meeting-agenda">${matters}</ol>` : ""}
  </section>`;
}
