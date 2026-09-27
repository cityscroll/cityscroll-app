import { emptyFunnel } from "./digest_funnel.mjs";
import { deriveWatchId, subscriptionKey } from "./subscriptions.mjs";

const COUNCIL_DISTRICTS = Object.freeze(Array.from({ length: 51 }, (_, index) => String(index + 1)));

function firstText(...values) {
  for (const value of values) {
    const text = value == null ? "" : String(value).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Recover the filter encoded by a legacy district watch identity.
 *
 * District filters have a closed 1..51 namespace. Re-deriving those opaque
 * identities is stronger evidence than the current publisher window: it proves
 * which saved district owned the row even after that row ages out of the window.
 */
export async function districtFilterByWatchId(email, watchIds) {
  const wanted = new Set((Array.isArray(watchIds) ? watchIds : []).filter(Boolean).map(String));
  const filters = new Map();
  if (!firstText(email) || !wanted.size) return filters;
  for (const councilDistrict of COUNCIL_DISTRICTS) {
    const key = await subscriptionKey({
      email,
      lens: "district",
      filter: { councilDistrict },
    });
    const watchId = await deriveWatchId(key);
    if (wanted.has(watchId)) filters.set(watchId, { councilDistrict });
  }
  return filters;
}

/**
 * Build render-only sections for owed district rows whose original watch was
 * removed or replaced. These sections do not become subscriptions or advance a
 * current watch watermark; they only discharge the recorded delivery obligation.
 */
export async function historicalDistrictOwedSections(owed, subscriptions) {
  const items = Array.isArray(owed) ? owed : [];
  const watches = Array.isArray(subscriptions) ? subscriptions : [];
  const email = firstText(...watches.map((watch) => watch?.email));
  const activeWatchIds = new Set(watches.map((watch) => watch?.watch_id).filter(Boolean));
  const historicalWatchIds = [...new Set(items
    .filter((item) => item?.lens === "district" && item?.watch_id && !activeWatchIds.has(item.watch_id))
    .map((item) => item.watch_id))];
  const filters = await districtFilterByWatchId(email, historicalWatchIds);
  const lang = firstText(...watches.map((watch) => watch?.lang)) || "en";

  return [...filters.entries()].map(([watchId, filter]) => {
    const matching = items.filter((item) => item?.watch_id === watchId);
    const since = matching.map((item) => item?.first_owed_at).filter(Boolean).sort()[0] || null;
    const label = `Previously followed: City Council District ${filter.councilDistrict}`;
    return {
      sub: null,
      subKey: null,
      lens: "district",
      freq: "daily",
      queryLabel: label,
      label,
      filter,
      lang,
      email: email || null,
      new: 0,
      found: 0,
      forecasts: 0,
      noticeIds: [],
      action: "none",
      status: "success",
      watchId,
      kind: "district",
      freshRows: [],
      sourceRows: [],
      since,
      historicalOwed: true,
      funnel: emptyFunnel(),
    };
  });
}
