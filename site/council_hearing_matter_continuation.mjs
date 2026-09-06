import { resolveMatterDestination } from "./legislative_matter_availability.mjs";

export const COUNCIL_HEARING_MATTER_CONTINUATION_SCHEMA = "cityscroll.council_hearing_matter_continuation.v1";
export const STRICT_COUNCIL_MEETING_JOIN_METHOD = "exact_date_body_tokens";

function text(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeHttps(value) {
  try {
    const url = new URL(text(value, 2_000));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function strictJoin(outcome) {
  if (outcome?.snapshot_state !== "present") return false;
  const join = outcome.join || outcome.strict_join;
  // The compact snapshot's `present` state is produced only from a matched
  // record. If a newer artifact carries the join envelope, verify it too.
  return !join || (join.matched === true && join.method === STRICT_COUNCIL_MEETING_JOIN_METHOD);
}

function outcomeFor(record, override) {
  return override || record?.meeting_outcome || record?.council_outcome || null;
}

function exactMatters(outcome) {
  const seen = new Set();
  const matters = [];
  for (const raw of Array.isArray(outcome?.matters) ? outcome.matters : []) {
    const matterId = text(raw?.matter_id, 120);
    // matter_file and title are display evidence only. They never create an
    // identity or fill a missing matter id.
    if (!matterId || !/^[A-Za-z0-9._-]+$/.test(matterId) || seen.has(matterId)) continue;
    seen.add(matterId);
    const matterUrl = safeHttps(raw?.matter_url);
    // One availability rule for every surface: a published local history, this
    // matter's own official address, or an honest absence. Never a local route
    // the published lookup does not carry, and never a substitute destination.
    const destination = resolveMatterDestination({ matter_id: matterId, matter_url: matterUrl });
    matters.push(Object.freeze({
      subject_ref: `matter:${matterId}`,
      matter_id: matterId,
      matter_file: text(raw?.matter_file, 120) || null,
      title: text(raw?.title, 1_000) || null,
      matter_url: matterUrl,
      canonical_href: destination.availability === "local_history" ? destination.href : null,
      destination,
      outcome: text(raw?.outcome, 240) || null,
    }));
  }
  return Object.freeze(matters);
}

/**
 * Project only an exact City Record → Council outcome join. This is a
 * source-preserving read projection: it never compares titles, substitutes a
 * committee, or chooses a matter from an ambiguous set.
 */
export function projectCouncilHearingMatterContinuation(record = {}, override = null) {
  const outcome = outcomeFor(record, override);
  const base = {
    schema: COUNCIL_HEARING_MATTER_CONTINUATION_SCHEMA,
    meeting_id: text(record?.meeting_id, 2_000) || null,
    request_id: text(record?.request_id, 120) || null,
    matters: Object.freeze([]),
    state: "unavailable",
    strict_join: false,
  };
  if (record?.source_system !== "city_record" || !outcome) return Object.freeze(base);
  if (!strictJoin(outcome)) {
    return Object.freeze({
      ...base,
      state: outcome.snapshot_state === "absent" ? "unmatched" : "unknown",
    });
  }
  const matters = exactMatters(outcome);
  return Object.freeze({
    ...base,
    matters,
    state: matters.length === 1 ? "single" : matters.length > 1 ? "multiple" : "no_matter",
    strict_join: true,
    join_method: STRICT_COUNCIL_MEETING_JOIN_METHOD,
  });
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

/**
 * The matter's own file number, as a plain native anchor to wherever that
 * matter is actually readable. The destination comes from the one availability
 * rule, so this identity can never advertise a local page the published lookup
 * does not carry.
 */
function matterLink(matter) {
  const label = matter.matter_file || matter.matter_id;
  const { availability, href, external } = matter.destination;
  if (!href) return `<span class="meeting-matter-link" data-matter-id="${esc(matter.matter_id)}">${esc(label)}</span>`;
  const local = availability === "local_history";
  return `<a class="meeting-matter-link${local ? " ui-constellation-link" : ""}" href="${esc(href)}"${external ? ' rel="noopener noreferrer"' : ""} data-matter-id="${esc(matter.matter_id)}" data-matter-availability="${esc(availability)}">${esc(label)}</a>`;
}

/**
 * The navigation control. Its label names what the reader will see -- a
 * retained history or the publisher's own record -- and never suggests that
 * anything was saved, subscribed, submitted, or credited to them. A matter with
 * no reachable destination states that instead of offering a dead control.
 */
function continuationControl(matter, { candidate = false } = {}) {
  const { availability, href, label, external, note } = matter.destination;
  if (!href) {
    return `<p class="node-muted meeting-matter-unavailable" data-matter-availability="${esc(availability)}" data-subject-ref="${esc(matter.subject_ref)}">${esc(note)}</p>`;
  }
  return `<a class="node-action civic-object-action${candidate ? " meeting-matter-choice" : " primary"}" href="${esc(href)}"${external ? ' rel="noopener noreferrer"' : ""} data-action-path-continuation="subject" data-subject-ref="${esc(matter.subject_ref)}" data-matter-availability="${esc(availability)}">${esc(label)}</a>`;
}

/** Render the exact matter set for either the static meeting document or a card. */
export function renderCouncilHearingMatterContinuation(record = {}, override = null, { sectionClass = "node-section civic-object-section meeting-section" } = {}) {
  const projection = projectCouncilHearingMatterContinuation(record, override);
  if (projection.state === "unavailable") return "";
  if (projection.state === "unmatched") {
    return `<section class="${sectionClass} meeting-matter-continuation" data-council-matter-continuation="1" data-continuation-state="unmatched"><h2>What this hearing concerns</h2><p class="node-muted">No exact Council hearing match is available for this notice, so no underlying matter is shown.</p></section>`;
  }
  if (projection.state === "no_matter") {
    return `<section class="${sectionClass} meeting-matter-continuation" data-council-matter-continuation="1" data-continuation-state="no_matter"><h2>What this hearing concerns</h2><p class="node-muted">This matched Council hearing has no underlying matter in the retained agenda data.</p></section>`;
  }
  const multiple = projection.state === "multiple";
  const rows = projection.matters.map((matter) => `<li class="meeting-matter" data-matter-id="${esc(matter.matter_id)}"><div><strong>${matterLink(matter)}</strong>${matter.title ? `<p class="meeting-matter-title">${esc(matter.title)}</p>` : ""}</div>${continuationControl(matter, { candidate: multiple })}</li>`).join("");
  return `<section class="${sectionClass} meeting-matter-continuation" data-council-matter-continuation="1" data-continuation-state="${multiple ? "multiple" : "single"}"><h2>What this hearing concerns</h2>${multiple ? "<p>Choose a matter to open.</p>" : "<p>This hearing has an exact Council matter join.</p>"}<ol class="meeting-matter-list">${rows}</ol></section>`;
}
