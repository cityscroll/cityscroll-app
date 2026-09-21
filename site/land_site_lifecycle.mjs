import siteLifecycleShard from "./data/site_lifecycle/0000.json" with { type: "json" };
import siteLifecycleReverse from "./data/site_lifecycle/reverse.json" with { type: "json" };

import { buildSiteLifecycleContext, renderSiteLifecycleContext } from "./site_lifecycle_context.mjs";

const LAND_SITE_LIFECYCLE = {
  schema: "cityscroll.site_lifecycle.v1",
  parcels: Object.fromEntries((siteLifecycleShard.rows || []).map((row) => [row.parcel_id, row])),
  members: siteLifecycleReverse.members || {},
};

/** Render the resident land projection from the bundled materialization. */
export function renderLandSiteLifecycle(projectId) {
  const context = buildSiteLifecycleContext(LAND_SITE_LIFECYCLE, {
    subjectId: ["land", "project", projectId].join(":"),
    surface: "land",
  });
  return renderSiteLifecycleContext(context);
}
