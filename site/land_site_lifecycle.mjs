import { loadCommittedSiteLifecycleDocument } from "./site_lifecycle_artifacts.mjs";
import { buildSiteLifecycleContext, renderSiteLifecycleContext } from "./site_lifecycle_context.mjs";

const LAND_SITE_LIFECYCLE = loadCommittedSiteLifecycleDocument();

/** Render the resident land projection from the bundled materialization. */
export function renderLandSiteLifecycle(projectId) {
  const context = buildSiteLifecycleContext(LAND_SITE_LIFECYCLE, {
    subjectId: ["land", "project", projectId].join(":"),
    surface: "land",
  });
  return renderSiteLifecycleContext(context);
}
