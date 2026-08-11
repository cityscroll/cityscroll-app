import { officialSourceDisclosure, officialSourceLink } from "./affordance_grammar.mjs";

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

/**
 * Normalize publisher vote tallies. Live Legistar summaries use aye/nay;
 * older fixtures may use yes/no. Map both into the first-paint yes/no keys.
 * Retain a bounded by_person sample so roll-call chips paint before the live
 * enhancement fetch — never invent persons when the publisher omitted them.
 */
export function compactVotes(votes, { maxPeople = 12 } = {}) {
  const row = Array.isArray(votes) ? votes.at(-1) : (votes && typeof votes === "object" ? votes : null);
  if (!row) return null;
  const counts = row.counts || {};
  const yesRaw = counts.yes ?? counts.aye;
  const noRaw = counts.no ?? counts.nay;
  const abstainRaw = counts.abstain;
  const yes = Number.isFinite(Number(yesRaw)) ? Number(yesRaw) : null;
  const no = Number.isFinite(Number(noRaw)) ? Number(noRaw) : null;
  const abstain = Number.isFinite(Number(abstainRaw)) ? Number(abstainRaw) : null;
  const peopleIn = Array.isArray(row.by_person) ? row.by_person : [];
  const people = peopleIn
    .map((person) => {
      const personId = clean(person?.person_id || person?.PersonId || person?.VotePersonId);
      const personName = clean(person?.person_name || person?.PersonName || person?.VotePersonName);
      if (!personId || !personName) return null;
      return {
        person_id: personId,
        person_name: personName.slice(0, 80),
        vote_bucket: clean(person?.vote_bucket || person?.vote_value || person?.VoteValueName) || null,
      };
    })
    .filter(Boolean)
    .slice(0, Math.max(0, Number(maxPeople) || 0));
  const voteIdentity = clean(row.vote_identity)
    || (people.length ? "roll_call" : null);
  const result = {
    result: clean(row.result || row.action || row.vote_result) || null,
    yes,
    no,
    abstain,
    vote_identity: voteIdentity || null,
    person_count: people.length
      || (Number.isFinite(Number(row.person_count)) ? Number(row.person_count) : 0),
    by_person: people,
  };
  const hasTally = [result.result, result.yes, result.no, result.abstain]
    .some((value) => value != null && value !== "");
  if (!hasTally && !people.length) return null;
  return result;
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
  const officialItems = [
    ...allDocuments.map((doc) => ({ href: doc.url, label: doc.name })),
    ...(record.matters || []).filter((matter) => matter.matter_url).map((matter) => ({
      href: matter.matter_url,
      label: matter.matter_file || matter.matter_id || "Meeting matter",
    })),
  ];
  const matters = (record.matters || []).map((matter) => {
    const label = clean(matter.outcome || matter.actions?.at(-1));
    const votes = matter.votes || null;
    const hasTally = votes && [votes.yes, votes.no, votes.abstain].some((n) => n != null);
    const people = Array.isArray(votes?.by_person) ? votes.by_person : [];
    const rollCall = votes?.vote_identity === "roll_call" || people.length > 0;
    const tally = hasTally
      ? `<p class="meeting-sub">${votes.yes ?? "—"} yes · ${votes.no ?? "—"} no · ${votes.abstain ?? "—"} abstain</p>`
      : "";
    const names = people.slice(0, 6).map((person) => esc(person.person_name)).filter(Boolean);
    const more = Math.max(0, (Number(votes?.person_count) || people.length) - names.length);
    const rollCallChip = rollCall && names.length
      ? `<p class="meeting-sub meeting-roll-call-static" data-vote-identity="roll_call" data-official-count="${esc(String(votes?.person_count || people.length))}">Roll call: ${names.join(", ")}${more > 0 ? ` (+${more} more)` : ""}</p>`
      : "";
    const vote = `${tally}${rollCallChip}`;
    const file = `<span class="meeting-file">${esc(matter.matter_file || matter.matter_id)}</span>`;
    return `<li class="meeting-matter" data-outcome-bucket="${outcomeBucket(label)}">
      <div class="meeting-matter-main"><div>${file}<p class="meeting-title">${esc(matter.title)}</p>${vote}</div>
      ${label ? `<span class="meeting-badge meeting-badge--${outcomeBucket(label)}">${esc(label)}</span>` : ""}</div>
    </li>`;
  }).join("");
  return `<section class="meeting-outcomes-static" data-meeting-outcomes-first-paint="1" data-meeting-outcomes-state="present">
    <div class="chain-h">Decision documents and outcomes</div>
    <div class="note">Matched ${eventLink}${event.date ? ` · ${esc(event.date)}` : ""}</div>
    ${officialItems.length
      ? `<div class="meeting-event-docs"><span class="meeting-docs-lbl">Decision documents</span>${officialSourceDisclosure({ items: officialItems, label: "Open official meeting records", className: "meeting-source-disclosure", escape: esc })}</div>`
      : `<div class="note">No decision documents published for this meeting.</div>`}
    ${matters ? `<ol class="meeting-agenda">${matters}</ol>` : ""}
  </section>`;
}
