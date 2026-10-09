/** Pages-edge loader for the sharded shared meeting catalog. */
import { loadSharedMeetingReadModelDocument } from "./shared_meeting_read_model_shards.mjs";

export function sharedMeetingAssetFetchJson(staticAsset, env, request) {
  return async (url) => {
    const pathname = String(url).startsWith("/") ? String(url) : `/${String(url)}`;
    const response = await staticAsset(env, request, pathname);
    if (!response.ok) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  };
}

export async function loadSharedMeetingReadModelFromAssets(staticAsset, env, request) {
  return loadSharedMeetingReadModelDocument(
    "/data/shared_meeting_read_model.json",
    sharedMeetingAssetFetchJson(staticAsset, env, request),
  );
}
