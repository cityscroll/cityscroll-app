// Property-route support data used by decision cards. Kept outside the app
// module so the route controller stays below its short-context size boundary.

let decisionDataPromise = null;

export function loadPropertyDecisionData(fetchImpl = fetch) {
  if (!decisionDataPromise) {
    decisionDataPromise = Promise.all([
      fetchImpl("/data/attachment_metadata_lookup.json", { cache: "no-cache" })
        .then((response) => response.ok ? response.json() : null)
        .then((payload) => payload && typeof payload.notices === "object" ? payload.notices : {})
        .catch(() => ({})),
      fetchImpl("/data/property_sources/property_disposition_history.json", { cache: "no-cache" })
        .then((response) => response.ok ? response.json() : null)
        .then((payload) => Object.fromEntries(
          (Array.isArray(payload?.notices) ? payload.notices : [])
            .filter((notice) => notice?.request_id && notice?.end_date)
            .map((notice) => [String(notice.request_id), notice.end_date]),
        ))
        .catch(() => ({})),
    ]).then(([attachmentLookup, lifecycleHistory]) => ({ attachmentLookup, lifecycleHistory }));
  }
  return decisionDataPromise;
}
