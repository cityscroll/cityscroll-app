/**
 * Land detail assistant handoff living outside site/app/land.mjs so the Land
 * application module keeps headroom under the working-bar gate.
 */

import {
  buildLandProjectAiContextHandoff,
  renderMoreToolsRegion,
} from "./ai_context_handoff.mjs";

/** One More tools control for an exact ZAP project id, or "" when unsupported. */
export function renderLandProjectAiContextTools(projectId, { translate = (value) => value } = {}) {
  const handoff = buildLandProjectAiContextHandoff({ project_id: projectId });
  if (handoff.status !== "ok") return "";
  return renderMoreToolsRegion({ handoff, translate });
}

/**
 * Mount (or refresh) the Land assistant control beside the official action rail.
 * Called from feed-actions paintLandActionRail so land.mjs stays byte-neutral.
 */
export function mountLandAiContextToolsBeside(railHost, projectRow, { translate = (value) => value } = {}) {
  if (!railHost || typeof railHost.insertAdjacentElement !== "function") return null;
  let tools = railHost.nextElementSibling;
  if (!tools || tools.getAttribute("data-land-ai-context-tools") !== "1") {
    tools = document.createElement("div");
    tools.setAttribute("data-land-ai-context-tools", "1");
    railHost.insertAdjacentElement("afterend", tools);
  }
  tools.innerHTML = renderLandProjectAiContextTools(projectRow?.project_id, { translate });
  return tools;
}
