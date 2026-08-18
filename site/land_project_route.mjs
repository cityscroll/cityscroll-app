const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/;

/** Canonical, document-owned Zoning project route used by titles and Copy link. */
export function landProjectPath(projectId) {
  const id = String(projectId ?? "").trim();
  return PROJECT_ID.test(id) ? `/browse/zoning/#land/${encodeURIComponent(id)}` : null;
}

export function landProjectUrl(projectId, origin = "https://cityscroll.org") {
  const path = landProjectPath(projectId);
  return path ? new URL(path, origin).toString() : null;
}
