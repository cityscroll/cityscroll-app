/** Fetch the shared meeting catalog through its published index and shards. */
import { loadSharedMeetingReadModelDocument } from "./shared_meeting_read_model_shards.mjs";

export function loadMeetingSnapshot(url, init = { credentials: "omit" }) {
  return loadSharedMeetingReadModelDocument(
    url,
    (u) => fetch(u, init).then((r) => (r.ok ? r.json() : null)),
  ).then((payload) => payload || Promise.reject(new Error("snapshot-unavailable")));
}

export function loadMeetingSnapshotOrNull(url, init = { cache: "force-cache", credentials: "omit" }) {
  return loadSharedMeetingReadModelDocument(
    url,
    (u) => fetch(u, init).then((r) => (r.ok ? r.json() : null)),
  ).catch(() => null);
}
