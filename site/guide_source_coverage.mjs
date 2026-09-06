/**
 * The one table on the guide's sources-and-coverage page that is derived rather
 * than written.
 *
 * `site/data/source_contracts.json` is the registry of every civic-data source the
 * product reads, and it is the authority on what those sources are. A reference
 * page that retyped any of it would be a second list to keep true, and the second
 * list is always the one that goes stale, so this derives the reader-facing summary
 * from the registry itself and the page drops it in with a `::: source-coverage`
 * line. Change the registry and the page follows on the next build.
 *
 * What it deliberately does not do is republish the registry. A reader gets the
 * shape — how many sources there are and how often each kind changes — and a link
 * to the ledger for the rest. Per-source freshness, health and coverage stay with
 * `site/data/source_contracts.json`, its generated ledger, and the public
 * source-health projection.
 *
 * This is a pure function of the registry object: the caller reads the file. It
 * holds no clock, so an unchanged registry renders unchanged bytes.
 */

/**
 * Reader-facing gloss for each refresh mode the registry declares, in the order a
 * reader meets them. A mode with no gloss here fails the build rather than
 * reaching a page as a bare word out of a machine-readable file.
 */
const REFRESH_MODES = Object.freeze([
  Object.freeze({
    id: "continuous",
    label: "As things happen",
    meaning: "The publisher updates this as records are filed, so what you see follows the city closely.",
  }),
  Object.freeze({
    id: "periodic",
    label: "On the publisher's schedule",
    meaning: "The publisher releases on a cycle — daily, monthly, yearly. Between releases, the newest thing the city did may not be here yet.",
  }),
  Object.freeze({
    id: "manual-conditional",
    label: "Checked by a person",
    meaning: "There is no machine feed, so a person re-checks the publisher's page. These carry the date they were checked.",
  }),
  Object.freeze({
    id: "historical",
    label: "A closed set",
    meaning: "The publisher has stopped adding to this. It is complete for the period it covers and will not grow.",
  }),
  Object.freeze({
    id: "pointer",
    label: "A pointer to another source",
    meaning: "This names where the records live rather than carrying them, so the official page is the thing to read.",
  }),
]);

export class GuideSourceCoverageError extends Error {}

/**
 * Summarize the source registry for readers.
 *
 * @param {object} registry parsed `site/data/source_contracts.json`
 * @returns {{caption: string, columns: string[], rows: string[][]}} a table spec
 */
export function guideSourceCoverageTable(registry) {
  const contracts = registry?.contracts;
  if (!Array.isArray(contracts) || !contracts.length) {
    throw new GuideSourceCoverageError("source_contracts.json carries no contracts to summarize");
  }

  // Sources the registry marks backstage stay out: a reader cannot reach what they
  // feed, and listing them would overstate what this page is describing.
  const published = contracts.filter((contract) => contract?.health_policy?.public_visibility === "public");
  const counts = new Map();
  for (const contract of published) {
    const mode = contract?.freshness_contract?.mode;
    if (!REFRESH_MODES.some((known) => known.id === mode)) {
      throw new GuideSourceCoverageError(
        `source ${contract?.id} refreshes as ${JSON.stringify(mode)}, which this page has no plain-language meaning for`,
      );
    }
    counts.set(mode, (counts.get(mode) || 0) + 1);
  }

  const rows = REFRESH_MODES
    .filter((mode) => counts.get(mode.id))
    .map((mode) => [mode.label, mode.meaning, String(counts.get(mode.id))]);

  return {
    caption: `The ${published.length} public sources behind these records, by how often each one changes`,
    columns: ["How it refreshes", "What that means for what you read", "Sources"],
    rows,
  };
}

/** The name a guide article writes after `::: ` to place the table above. */
export const GUIDE_SOURCE_COVERAGE_INCLUDE = "source-coverage";
