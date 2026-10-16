export function createLandOutcomeRuntime({
  cache = new Map(),
  ttlMs = 300000,
  now,
  normalizeRecord = (record) => record,
  translate = (key) => key,
  formatDate = (value) => value,
  escapeHTML = (value) => String(value),
  fetchResponse,
  connectionTools = async () => null,
} = {}) {
  function get(projectId) {
    const hit = cache.get(projectId);
    if (!hit || hit.p) return hit || null;
    return now() - hit.at < ttlMs ? hit : { ...hit, expired: true };
  }

  function evidenceState(payload, nowMs = now()) {
    const observedAt = payload?.record?.generated_at || null;
    const stamp = Date.parse(observedAt || "");
    return {
      observedAt,
      stale: payload?.stale === true || !Number.isFinite(stamp) || nowMs - stamp > 24 * 60 * 60 * 1000,
    };
  }

  function freshnessHTML(payload, { failed = false } = {}) {
    const state = evidenceState(payload);
    if (!failed && !state.stale) return "";
    const stamp = state.observedAt
      ? translate("land_outcome_checked_at", { date: formatDate(state.observedAt) })
      : translate("land_outcome_check_unknown");
    return `<p class="land-outcome-freshness" role="status">${escapeHTML(translate(failed ? "land_outcome_update_failed" : "land_outcome_stale"))} ${escapeHTML(stamp)} ${escapeHTML(translate("land_outcome_stage_caution"))}</p>`;
  }

  function recordForDisplay(payload, failed = false) {
    const state = evidenceState(payload);
    return normalizeRecord({ ...payload.record, evidence_stale: failed || state.stale });
  }

  function seed(snapshot) {
    const byProject = snapshot?.outcomes?.by_project || {};
    const generatedAt = snapshot?.generated_at || null;
    for (const [id, record] of Object.entries(byProject)) {
      if (!record || record.snapshot_state === "unavailable") continue;
      const previous = cache.get(id);
      if (previous?.p || previous?.data?.record && (!previous.staticSnapshot
        || Date.parse(previous.data.record.generated_at) >= Date.parse(record.generated_at))) continue;
      cache.set(id, {
        data: { ok: true, cached: true, static_snapshot: true, generated_at: generatedAt, record },
        at: now(),
        generatedAt,
        staticSnapshot: true,
      });
    }
  }

  function fetch(projectId, { allowStatic = true } = {}) {
    const id = String(projectId || "").trim();
    if (!id) return Promise.resolve(null);
    const existing = get(id);
    if (existing?.p) return existing.p;
    if (existing?.data && !existing.expired && (allowStatic || !existing.staticSnapshot)) {
      return Promise.resolve(existing.data);
    }
    const p = (async () => {
      try {
        const tools = await connectionTools();
        const accepts = tools ? async (response) => {
          if (!response?.ok) return false;
          const payload = await response.json();
          return payload?.ok !== false && payload?.record?.project_id === id;
        } : null;
        const response = await fetchResponse(id, accepts);
        if (!response?.ok) return null;
        const payload = await response.json();
        return tools ? tools.normalizeProjectConnectionsPayload(payload, id) : payload;
      } catch (_error) {
        return null;
      }
    })();
    cache.set(id, { ...existing, p });
    return p.then((data) => {
      if (data && data.ok !== false && data.record) {
        const old = existing?.data?.record;
        if (old && (Date.parse(old.generated_at) > Date.parse(data.record.generated_at)
          || !Number.isFinite(Date.parse(data.record.generated_at))
          || old.spine?.events?.length && !data.record.spine?.events?.length)) {
          cache.set(id, existing);
          return { ...existing.data, stale: true };
        }
        cache.set(id, { data, at: now() });
      } else if (existing?.data) cache.set(id, existing);
      else cache.delete(id);
      return data;
    }).catch(() => {
      if (existing?.data) cache.set(id, existing);
      else cache.delete(id);
      return null;
    });
  }

  return { cache, ttlMs, get, seed, fetch, evidenceState, freshnessHTML, recordForDisplay };
}
