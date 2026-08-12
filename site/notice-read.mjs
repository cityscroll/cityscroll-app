export const watchLabelForNotice = row => {
  const agency = String(row?.agency_name || "").trim() || null;
  return {
    label_key: agency ? "scope" : "next_action_watch",
    label_vars: agency ? { agency, lens: "Rules" } : null,
  };
};

const enrichHearing = rows => {
  const row = rows[0];
  if (!row || row.section_name !== "Agency Rules" || !row.event_date) return Promise.resolve(rows);
  row.watch_label = watchLabelForNotice(row);
  globalThis.__noticeWatchId = row.request_id;
  globalThis.__noticeWatchLabel = row.watch_label;
  if (globalThis.CrolActions && !globalThis.__noticeActionPatch) {
    const compile = globalThis.CrolActions.compileActionRail;
    globalThis.CrolActions.compileActionRail = (matter, options) => {
      const actions = compile(matter, options);
      if (String(matter?.request_id) === String(globalThis.__noticeWatchId)) {
        const watch = actions.find(action => action.type === "watch");
        if (watch) Object.assign(watch, globalThis.__noticeWatchLabel);
        const guide = actions.find(action => action.guide)?.guide;
        if (guide?.venue_mode && !guide.venue_address && !guide.venue_building) {
          guide.venue_address = globalThis.t(guide.venue_mode === "virtual" ? "venue_virtual" : guide.venue_mode === "hybrid" ? "venue_hybrid" : "venue_in_person");
        }
      }
      return actions;
    };
    globalThis.__noticeActionPatch = true;
  }
  return workerFetch(`/hearings?id=${encodeURIComponent(row.request_id)}`, {}, 12000)
    .then(response => response.ok ? response.json() : null)
    .then(payload => {
      const hearing = (payload?.hearings || []).find(item => String(item.request_id) === String(row.request_id));
      if (hearing) Object.assign(row, {
        venue: hearing.venue || row.venue,
        participation: hearing.participation || row.participation,
        meeting_access: hearing.meeting_access || row.meeting_access,
        hearing,
      });
      return rows;
    })
    .catch(() => rows);
};

export const read = id => {
  const fallback = () => soda({"$where":`request_id='${String(id).replace(/'/g,"''")}'`,"$limit":"1"},5e3);
  return workerFetch("/notice?id="+encodeURIComponent(id),null,5e3)
    .then(r => r.json()).then(x => x.row ? enrichHearing([x.row]) : fallback().then(enrichHearing))
    .catch(() => fallback().then(enrichHearing));
};
