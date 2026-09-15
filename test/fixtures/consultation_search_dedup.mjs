import { DOT_PILOT_SEEDS } from "../../site/consultation_acquisition.mjs";
import { CONSULTATION_PILOT_SEEDS } from "../../site/consultation_publisher_adapters.mjs";

const bloomingdale = CONSULTATION_PILOT_SEEDS.find((record) => record.id === "bloomingdale-library-and-housing");
const fastBuses = DOT_PILOT_SEEDS.find((record) => record.id === "dot-fast-buses-central-brooklyn");

// Duplicate source-facing rows collapse to one identity per round. Later channel
// and source references are retained on the first-wins document; they are not
// separate identities.
export const CONSULTATION_VARIANT_FIXTURE = Object.freeze([
  { ...bloomingdale, channels: [bloomingdale.channels[0]] },
  { ...bloomingdale, channels: [{ kind: "feedback_map", url: "https://edc.nyc/project/bloomingdale-library/map", language: null }] },
  { ...bloomingdale, channels: [{ kind: "shortlink", url: "https://edc.nyc/project/bloomingdale-library/feedback", language: null }] },
  { ...bloomingdale, channels: [bloomingdale.channels[1]] },
  { ...fastBuses, channels: [fastBuses.channels[0]], sources: [fastBuses.sources[0], fastBuses.sources[1]] },
  { ...fastBuses, channels: [fastBuses.channels[1]], sources: [fastBuses.sources[0], fastBuses.sources[2]] },
]);

// Organizer-facing fields are indexed; respondent text and inferred project
// outcomes must never reach the SearchDocument.
export const CONSULTATION_RESPONDENT_TEXT_FIXTURE = Object.freeze({
  ...bloomingdale,
  purpose: "Share feedback on the library and housing proposal.",
  geography: { labels: ["Manhattan Community District 10"] },
  respondent_comments: ["Please keep the existing reading room open every evening."],
  questionnaire_answers: [{ prompt: "Do you support the proposal?", answer: "Strongly oppose demolition" }],
  public_map_comments: ["Put housing on the corner lot marked in red."],
  respondent_identity: "resident-42@example.com",
  inferred_project_outcome: "Library will be demolished and replaced by market-rate towers",
});
