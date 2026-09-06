/**
 * Operator-facing HTML for the matter observation journal.
 *
 * This is not a resident control. It renders retained last-good state, coarse
 * versus native identity, and repair receipts so an operator can inspect
 * whether a refresh shrunk history. Copy stays source-honest.
 */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function granularityLabel(value) {
  if (value === "native") return "Native publisher observation";
  if (value === "coarse") return "Coarse bootstrap appearance";
  return "Identity granularity not stated";
}

function voteLabel(status) {
  if (status === "bound") return "Votes are bound to this event item.";
  if (status === "incomplete") {
    return "Vote evidence is present without a native event-item binding, so it is labelled incomplete and is not attached to another item.";
  }
  return "No vote evidence is retained on this observation.";
}

function appearanceList(appearances) {
  return appearances.map((appearance) => {
    const notices = (appearance.notice_references || [])
      .map((id) => `<li><a class="inline-link" href="/notices/${escapeHtml(id)}/">${escapeHtml(id)}</a></li>`)
      .join("");
    const noticesBlock = notices
      ? `<ul class="notice-list">${notices}</ul>`
      : "<p>No City Record notice reference is retained on this observation.</p>";
    const native = appearance.native_event_item_id
      ? `<p>Native event item ${escapeHtml(appearance.native_event_item_id)}.</p>`
      : "<p>No native event-item identifier is available. This is not a native publisher history.</p>";
    const superseded = appearance.superseded_by
      ? `<p>A later native observation ${escapeHtml(appearance.superseded_by)} matched this hearing. The hearing was not duplicated.</p>`
      : "";
    return `<article class="appearance" data-hearing="${escapeHtml(appearance.public_hearing_key)}" data-granularity="${escapeHtml(appearance.identity_granularity)}" data-event="${escapeHtml(appearance.event_id)}">
      <h3>${escapeHtml(appearance.event_time || "Event date not retained")} · event ${escapeHtml(appearance.event_id)}</h3>
      <p class="kicker">${escapeHtml(granularityLabel(appearance.identity_granularity))}</p>
      <p>${escapeHtml(appearance.action_name || "No official action string is retained.")}</p>
      <p>${escapeHtml(appearance.title || "")}</p>
      ${native}
      ${superseded}
      <p>${escapeHtml(voteLabel(appearance.vote_binding_status))}</p>
      <p>Observed ${escapeHtml(appearance.observed_at || "unknown")}. Acquired ${escapeHtml(appearance.acquired_at || "unknown")}.</p>
      <p>Source receipt ${escapeHtml(appearance.source_record_ref)}.</p>
      <p>Semantic revision ${escapeHtml(appearance.semantic_revision)}.</p>
      <h4>Notice references</h4>
      ${noticesBlock}
    </article>`;
  }).join("");
}

export function renderMatterObservationOperatorHtml(view, options = {}) {
  const title = options.title || "Matter observation journal";
  const route = options.route || "/operator/matter-observations/";
  const summary = view?.summary || { matter_count: 0, appearance_count: 0, observation_count: 0 };
  const generation = view?.generation;
  const repairs = Array.isArray(view?.repairs) ? view.repairs : [];
  const matters = Array.isArray(view?.matters) ? view.matters : [];
  const focus = options.matterId
    ? matters.filter((matter) => matter.matter_id === String(options.matterId))
    : matters.slice(0, 3);
  const repairBlock = repairs.length
    ? `<section class="repair" data-repair-count="${repairs.length}">
        <h2>Refresh repair</h2>
        <p>A later refresh did not replace retained history. Previous observations remain.</p>
        ${repairs.map((repair) => `<p data-repair-signature="${escapeHtml(repair.signature)}">${escapeHtml(repair.kind)} recorded ${escapeHtml(repair.last_seen_at)}. Seen ${escapeHtml(repair.occurrence_count)} time(s).</p>`).join("")}
      </section>`
    : `<section class="repair" data-repair-count="0">
        <h2>Refresh repair</h2>
        <p>No repair observation is outstanding. Last-good history is the current generation.</p>
      </section>`;

  const matterBlock = focus.map((matter) => `
    <section class="matter" data-matter="${escapeHtml(matter.matter_id)}" data-canonical="${escapeHtml(matter.canonical_ref)}">
      <h2>Matter ${escapeHtml(matter.matter_id)}</h2>
      <p>Publisher identity ${escapeHtml(matter.canonical_ref)}.</p>
      ${appearanceList(matter.appearances || [])}
    </section>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; max-width: 100%; }
  body { padding: 16px; font: 18px/1.5 system-ui, sans-serif; color: #1b2430; background: #f4f1ea; }
  main { max-width: 960px; margin: 0 auto; overflow-wrap: anywhere; word-break: break-word; }
  h1 { font-size: 1.6rem; margin: 0 0 8px; }
  h2 { font-size: 1.25rem; margin: 24px 0 8px; }
  h3 { font-size: 1.05rem; margin: 16px 0 8px; }
  h4 { font-size: 1rem; margin: 12px 0 6px; }
  .skip { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .skip:focus { width: auto; height: auto; clip: auto; inset: 16px auto auto 16px; background: #fff; padding: 8px 12px; z-index: 2; }
  .summary, .repair, .matter, .appearance { background: #fff; border: 1px solid #d7d0c4; border-radius: 10px; padding: 16px; margin: 0 0 16px; }
  .kicker { font-size: 0.9rem; letter-spacing: 0.02em; color: #5b5044; text-transform: uppercase; }
  .inline-link { color: #144a8c; }
  .node-action { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 10px 14px; border: 1px solid #144a8c; border-radius: 8px; color: #144a8c; text-decoration: none; }
  .node-action:focus-visible, .inline-link:focus-visible, summary:focus-visible, .skip:focus-visible {
    outline: 3px solid #b8471f; outline-offset: 2px;
  }
  details { margin: 16px 0; }
  summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
  .notice-list { margin: 0; padding-left: 1.2em; }
  @media (max-width: 420px) {
    body { padding: 12px; }
    h1 { font-size: 1.35rem; }
  }
</style>
</head>
<body>
<a class="skip" href="#journal">Skip to journal</a>
<main id="journal" data-route="${escapeHtml(route)}" data-matters="${escapeHtml(summary.matter_count)}" data-appearances="${escapeHtml(summary.appearance_count)}">
  <h1>${escapeHtml(title)}</h1>
  <p class="summary">
    Last-good journal holds ${escapeHtml(summary.matter_count)} matters,
    ${escapeHtml(summary.appearance_count)} hearings, and
    ${escapeHtml(summary.observation_count)} observations.
    ${generation ? `Current generation ${escapeHtml(generation.generation_id)} acquired ${escapeHtml(generation.acquired_at)}.` : "No current generation is recorded."}
    A later empty or failed refresh cannot delete these rows.
  </p>
  ${repairBlock}
  ${matterBlock || "<p>No matter observations are in this specimen.</p>"}
  <details>
    <summary>Source and acquisition details</summary>
    <p>Raw payloads remain in the immutable source-record table. This page is an indexed projection: identities, revisions, hashes, and notice references. It does not contact a publisher.</p>
    <p>Coarse bootstrap appearances stay labelled coarse after a native match. The native row keeps the same hearing identity rather than opening a second hearing.</p>
  </details>
  <p><a class="node-action" href="#journal">Return to journal summary</a></p>
</main>
</body>
</html>`;
}
