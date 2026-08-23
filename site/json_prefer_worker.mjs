/** Prefer a Worker JSON snapshot, then a same-origin committed file. */
export async function loadJsonPreferWorker(workerPath, localPath, ok) {
  if (typeof workerFetch === "function") {
    try {
      const live = await workerFetch(workerPath, {}, 8000);
      if (live && live.ok) {
        const doc = await live.json();
        if (!ok || ok(doc)) return doc;
      }
    } catch {
      // Worker miss falls through to the committed snapshot.
    }
  }
  const res = await fetch(localPath, { cache: "force-cache", credentials: "omit" });
  if (!res || !res.ok) throw new Error("snapshot-unavailable");
  return res.json();
}
