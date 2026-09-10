const SECTION_SUCCESS = "success";

export const OWED_ATTACH_REASONS = Object.freeze({
  UNPARSEABLE_PAYLOAD: "unparseable_payload",
  SECTION_NOT_READY: "section_not_ready",
  LENS_AMBIGUOUS: "lens_ambiguous",
  NO_CURRENT_LENS_WATCH: "no_current_lens_watch",
});

function payloadRow(item) {
  try {
    const parsed = JSON.parse(item.payload_json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch { return null; }
}

function sameRenderedItem(a, b) {
  if (!a || !b) return false;
  if (a.request_id && b.request_id) return String(a.request_id) === String(b.request_id);
  if (a.procurement_id && b.procurement_id) return String(a.procurement_id) === String(b.procurement_id);
  if (a.project_id && b.project_id) return String(a.project_id) === String(b.project_id);
  if (a.alert_id && b.alert_id) return String(a.alert_id) === String(b.alert_id);
  if (a.matter_update_key && b.matter_update_key) {
    return String(a.matter_update_key) === String(b.matter_update_key);
  }
  if (a.district_item_id && b.district_item_id) {
    return String(a.district_item_id) === String(b.district_item_id);
  }
  return false;
}

export function isAwardWatchSection(section) {
  return section?.lens === "award";
}

function publicIdentityRef(value) {
  const text = value == null ? "" : String(value);
  if (!text || text.includes("@")) return null;
  return text;
}

export function emptyOwedAttachReceipt(owedCount = 0) {
  return {
    owed_count: Number(owedCount) || 0,
    attached_count: 0,
    attached_by: { watch_id: 0, lens: 0 },
    unattached_count: 0,
    unattached: [],
  };
}

function sectionCanReceiveOwed(section) {
  return Boolean(
    section
    && !section.error
    && !section.skipped
    && section.status === SECTION_SUCCESS,
  );
}

function applyOwedEntries(section, entries) {
  section.outboxItems = entries.map(({ item }) => item);
  const carried = entries.map(({ row }) => row);
  if (isAwardWatchSection(section)) {
    const current = Array.isArray(section.awardCandidates) ? section.awardCandidates : [];
    section.awardCandidates = [...current, ...carried.filter((row) => !current.some((candidate) => sameRenderedItem(candidate, row)))];
  } else {
    const current = Array.isArray(section.freshRows) ? section.freshRows : [];
    section.freshRows = [...current, ...carried.filter((row) => !current.some((candidate) => sameRenderedItem(candidate, row)))];
  }
  section.new = (isAwardWatchSection(section) ? section.awardCandidates : section.freshRows).length;
  section.noticeIds = [...new Set([
    ...(Array.isArray(section.noticeIds) ? section.noticeIds : []),
    ...carried.map((row) => row.request_id || row.procurement_id || row.district_item_id).filter(Boolean),
  ])].slice(0, 100);
  section.action = "match";
}

function unattachedReason(sections, item) {
  const watchId = item?.watch_id;
  const lens = item?.lens;
  const matching = (Array.isArray(sections) ? sections : []).filter((section) => {
    if (!section) return false;
    if (watchId && (section.watchId === watchId || section.watch_id === watchId)) return true;
    return Boolean(lens && section.lens === lens);
  });
  if (matching.some((section) => !sectionCanReceiveOwed(section))) {
    return OWED_ATTACH_REASONS.SECTION_NOT_READY;
  }
  const readyLens = matching.filter((section) => sectionCanReceiveOwed(section) && section.lens === lens);
  if (readyLens.length > 1) return OWED_ATTACH_REASONS.LENS_AMBIGUOUS;
  return OWED_ATTACH_REASONS.NO_CURRENT_LENS_WATCH;
}

/**
 * Add the durable owed set to the ordinary section renderer, never by source date.
 *
 * Join order: the recorded outbox `watch_id` first, then the unique current
 * section of the same lens when that watch identity is no longer on the
 * subscriber. A row that still cannot attach stays owed; the receipt names why.
 */
export function attachOwedRows(sections, owed) {
  const list = Array.isArray(sections) ? sections : [];
  const items = Array.isArray(owed) ? owed : [];
  const receipt = emptyOwedAttachReceipt(items.length);
  const parsed = [];
  for (const item of items) {
    const row = payloadRow(item);
    if (!row) {
      receipt.unattached.push({
        item_id: publicIdentityRef(item?.item_id),
        watch_id: publicIdentityRef(item?.watch_id),
        lens: publicIdentityRef(item?.lens),
        reason: OWED_ATTACH_REASONS.UNPARSEABLE_PAYLOAD,
      });
      continue;
    }
    parsed.push({ item, row });
  }

  const byWatch = new Map();
  const byLens = new Map();
  const presentWatchIds = new Set();
  for (const section of list) {
    const watchId = section?.watchId || section?.watch_id;
    if (watchId) presentWatchIds.add(watchId);
    if (!sectionCanReceiveOwed(section)) continue;
    if (watchId && !byWatch.has(watchId)) byWatch.set(watchId, section);
    const lens = section.lens;
    if (!lens) continue;
    if (!byLens.has(lens)) byLens.set(lens, section);
    else byLens.set(lens, "ambiguous");
  }

  const grouped = new Map();
  const add = (section, entry, via) => {
    const bucket = grouped.get(section) || [];
    bucket.push(entry);
    grouped.set(section, bucket);
    receipt.attached_count += 1;
    receipt.attached_by[via] += 1;
  };

  for (const entry of parsed) {
    const exact = entry.item.watch_id ? byWatch.get(entry.item.watch_id) : null;
    if (exact) {
      add(exact, entry, "watch_id");
      continue;
    }
    // Lens recovery is only for a recorded watch_id that is no longer on this
    // subscriber. A current watch that skipped or failed this run keeps its owed
    // rows; attaching them to a sibling of the same lens would enlarge that
    // sibling's digest.
    if (entry.item.watch_id && presentWatchIds.has(entry.item.watch_id)) {
      receipt.unattached.push({
        item_id: publicIdentityRef(entry.item.item_id),
        watch_id: publicIdentityRef(entry.item.watch_id),
        lens: publicIdentityRef(entry.item.lens),
        reason: unattachedReason(list, entry.item),
      });
      continue;
    }
    const lensSection = entry.item.lens ? byLens.get(entry.item.lens) : null;
    if (lensSection && lensSection !== "ambiguous") {
      add(lensSection, entry, "lens");
      continue;
    }
    receipt.unattached.push({
      item_id: publicIdentityRef(entry.item.item_id),
      watch_id: publicIdentityRef(entry.item.watch_id),
      lens: publicIdentityRef(entry.item.lens),
      reason: lensSection === "ambiguous"
        ? OWED_ATTACH_REASONS.LENS_AMBIGUOUS
        : unattachedReason(list, entry.item),
    });
  }

  for (const [section, entries] of grouped) applyOwedEntries(section, entries);
  receipt.unattached_count = receipt.unattached.length;
  return receipt;
}
