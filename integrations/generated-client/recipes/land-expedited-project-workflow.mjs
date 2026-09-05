import { createIntegrationClient } from "../index.mjs";

export async function runExpeditedLandProjectWorkflow(client = createIntegrationClient(), { projectId = "2024Q0356", corpus = "historical" } = {}) {
  const browseInput = { procedure: "elurp", corpus, limit: 25 };
  const browse = await client.landProjectsBrowse(browseInput);
  const selectedProjectId = projectId || browse.results?.[0]?.project_id || null;
  if (!selectedProjectId) return { recipe: "land-expedited-project-workflow", availability: browse.availability, steps: [{ capability_reference: "land.projects.browse@1", input: browseInput, output: browse }] };
  const getInput = { project_id: selectedProjectId };
  const pathInput = { project_id: selectedProjectId };
  const project = await client.landProjectGet(getInput);
  const decisionPath = await client.landDecisionPathGet(pathInput);
  return { recipe: "land-expedited-project-workflow", availability: [browse.availability, project.availability, decisionPath.availability], steps: [{ capability_reference: "land.projects.browse@1", input: browseInput, output: browse }, { capability_reference: "land.project.get@1", input: getInput, output: project }, { capability_reference: "land.decision_path.get@1", input: pathInput, output: decisionPath }] };
}
