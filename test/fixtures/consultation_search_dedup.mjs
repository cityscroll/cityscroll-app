import { CONSULTATION_PILOT_SEEDS } from "../../site/consultation_publisher_adapters.mjs";

const round = CONSULTATION_PILOT_SEEDS.find((record) => record.id === "bloomingdale-library-and-housing");

// One retained round can have several source-facing rows: map, shortlink, and
// translated response channels remain evidence on the round, not identities.
export const CONSULTATION_VARIANT_FIXTURE = Object.freeze([
  { ...round, channels: [round.channels[0]] },
  { ...round, channels: [{ kind: "feedback_map", url: "https://edc.nyc/project/bloomingdale-library/map", language: null }] },
  { ...round, channels: [{ kind: "shortlink", url: "https://edc.nyc/project/bloomingdale-library/feedback", language: null }] },
  { ...round, channels: [round.channels[1]] },
]);
