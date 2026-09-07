/**
 * Compact resident projection of the accepted Council land-matter bridge.
 *
 * `warehouse/lib/council_land_bridge.mjs` measures which Council matter
 * appearances carry a retained exact land identifier and materializes the
 * accepted `about_project` / `reviews_project` edges for the ones that do.
 * That measurement is a receipt: it keeps every edge's full council depth, and
 * it is far too large, and far too build-shaped, to read on a page.
 *
 * This module turns one accepted measurement into the one compact lookup both
 * reader surfaces share — the land project detail and the published matter
 * history — so neither surface re-runs the join, re-reads the publisher
 * snapshot, or fans out per page. Identity is deduplicated: a project holds
 * matter identities, a matter holds its own appearances once, and the
 * companion list is derived at read time from the project's own membership
 * rather than repeated on every matter.
 *
 * The projection never adds a claim the measurement does not carry. It copies
 * the accepted relation triple and the negative rule verbatim, keeps the
 * recorded actions and the source event dates exactly as retained, and records
 * a retained named-vote count only when the source retained one — a matter with
 * no roll call keeps `named_votes: null`, never `0`.
 */

export const COUNCIL_LAND_MATTER_LINKS_SCHEMA = "cityscroll.council_land_matter_links.v1";

const clean = (value, max = 2000) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function matterIdentity(value) {
  const id = clean(value, 40);
  return /^\d+$/.test(id) ? id : "";
}

function projectIdentity(value) {
  const id = clean(value, 25);
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(id) ? id : "";
}

/**
 * How many named roll-call rows this appearance retained.
 *
 * `null` means the source retained no vote object for the appearance at all,
 * which is a different fact from a recorded vote with nobody in it. Neither is
 * reported as participation.
 */
function retainedNamedVotes(votes) {
  if (!votes || typeof votes !== "object") return null;
  const people = Array.isArray(votes.by_person) ? votes.by_person : null;
  return people ? people.length : null;
}

function appearanceFromEdge(edge) {
  const depth = edge?.council_depth || {};
  const event = depth.event || {};
  return {
    event_id: clean(event.event_id, 40) || null,
    event_date: clean(event.date, 20) || null,
    event_name: clean(event.name, 240) || null,
    actions: (Array.isArray(depth.actions) ? depth.actions : []).map((action) => clean(action, 240)).filter(Boolean),
    outcome: clean(depth.outcome, 240) || null,
    named_votes: retainedNamedVotes(depth.votes),
  };
}

function appearanceKey(appearance) {
  return `${appearance.event_id || ""}|${appearance.event_date || ""}`;
}

/**
 * Project one accepted measurement into the shared reader lookup.
 *
 * A `STOP` measurement, or one that materialized no edges, produces a lookup
 * with no projects and no matters. That is the honest-absent shape: the reader
 * surfaces render nothing at all rather than an empty heading.
 */
export function buildCouncilLandMatterLinks({ measurement, zapRows = [] } = {}) {
  const generatedAt = clean(measurement?.generated_at, 80);
  if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("measurement.generated_at must be an ISO timestamp");
  }
  const projectNames = new Map();
  for (const row of Array.isArray(zapRows) ? zapRows : []) {
    const id = projectIdentity(row?.project_id);
    if (id && !projectNames.has(id)) projectNames.set(id, clean(row?.project_name, 320) || null);
  }

  const edges = Array.isArray(measurement?.materialized_edges) ? measurement.materialized_edges : [];
  const projects = new Map();
  const matters = new Map();
  for (const edge of edges) {
    const projectId = projectIdentity(edge?.project_id);
    const matterId = matterIdentity(edge?.council_depth?.matter?.matter_id);
    if (!projectId || !matterId) continue;
    const appearance = appearanceFromEdge(edge);
    if (!appearance.event_id) continue;

    if (!matters.has(matterId)) {
      matters.set(matterId, {
        matter_id: matterId,
        project_id: projectId,
        matter_file: clean(edge.council_depth?.matter?.matter_file, 120) || null,
        title: clean(edge.council_depth?.matter?.title, 500) || null,
        join_method: clean(edge.provenance?.method, 80) || null,
        join_key: clean(edge.provenance?.join_key, 80) || null,
        join_value: clean(edge.provenance?.join_value, 80) || null,
        source_url: clean(edge.provenance?.source_url, 1000) || null,
        appearances: [],
      });
    }
    const matter = matters.get(matterId);
    // One matter can be heard twice. Keep both appearances, and keep each of
    // them once: the same event repeated by two notices is one appearance.
    if (!matter.appearances.some((held) => appearanceKey(held) === appearanceKey(appearance))) {
      matter.appearances.push(appearance);
    }

    if (!projects.has(projectId)) {
      projects.set(projectId, {
        project_id: projectId,
        project_name: projectNames.get(projectId) ?? null,
        matter_ids: [],
      });
    }
    const project = projects.get(projectId);
    if (!project.matter_ids.includes(matterId)) project.matter_ids.push(matterId);
  }

  for (const matter of matters.values()) {
    matter.appearances.sort((left, right) => String(left.event_date).localeCompare(String(right.event_date))
      || String(left.event_id).localeCompare(String(right.event_id)));
  }
  for (const project of projects.values()) project.matter_ids.sort();

  const rates = measurement?.join_measurement?.rates?.exact_land_identifier || {};
  return {
    schema: COUNCIL_LAND_MATTER_LINKS_SCHEMA,
    generated_at: generatedAt,
    source_vintage: measurement?.source_vintage || {},
    bridge: {
      gate: clean(measurement?.gate?.result, 20) || null,
      eligible_appearances: Number.isFinite(rates.total) ? rates.total : null,
      matched_appearances: Number.isFinite(rates.joined) ? rates.joined : null,
      matched_rate: Number.isFinite(rates.rate) ? rates.rate : null,
      linked_matters: matters.size,
      linked_projects: projects.size,
    },
    relation: {
      canonical: "about_project",
      proceeding: "reviews_project",
      compatibility: "decides_land_project",
      is_decision: false,
      negative_rule: clean(edges[0]?.negative_rule, 500)
        || "Exact matter identity supports an observed review record at most; a committee action here is never a land decision.",
    },
    projects: Object.fromEntries([...projects.entries()].sort(([left], [right]) => left.localeCompare(right))),
    matters: Object.fromEntries([...matters.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };
}
