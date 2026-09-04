/**
 * SEQRA-06: the vintage-resolution primitive every spatial join in this card
 * is built on (card acceptance A1, A2, A5).
 *
 * A spatial layer -- PLUTO, zoning, a receptor layer, an environmental-site
 * registry, a disadvantaged-community layer, a flood layer -- is really a
 * time series of publisher releases pretending to be a single current map.
 * `resolveLayerVintage` treats it that way: each release is a half-open
 * window [effective_start, effective_end) of wall-clock time during which
 * that release was the one in force, and resolving a cutoff means finding
 * the window that contains it -- never "the latest release available when
 * this function happened to run."
 *
 * That framing is what makes A2 (no backward leakage) a property of the
 * function rather than a promise about caller discipline: resolving cutoff C
 * against a vintage list depends only on which window contains C. Appending
 * a release published after C to the same list cannot change the answer,
 * because that release's window starts after C and so never contains it.
 * The determinism test in this module's test suite proves exactly that: the
 * same cutoff resolves identically whether the vintage list passed in stops
 * at C or continues past it -- "computed for a historical cutoff is
 * identical whether it is computed today or at that cutoff" (A2).
 *
 * When no window covers the cutoff, resolution is refused: this module
 * throws SeqraLayerVintageError rather than falling back to the nearest or
 * current release, and every catcher converts that refusal into an explicit
 * coverage-gap record instead of silently completing the join (A5). This is
 * the negative rule made mechanical: there is no code path in this module
 * that can complete a join with a vintage whose effective window does not
 * contain the cutoff.
 */

export const SEQRA_SPATIAL_COVERAGE_GAP_SCHEMA = "cityscroll.seqra_spatial_coverage_gap.v1";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class SeqraLayerVintageError extends Error {
  constructor(message, coverageGap) {
    super(message);
    this.name = "SeqraLayerVintageError";
    this.coverageGap = coverageGap;
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  return value;
}

function requireDateOnly(value, field) {
  requireNonEmptyString(value, field);
  if (!DATE_ONLY.test(value)) {
    throw new Error(`${field} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Validate one layer-vintage descriptor's shape without resolving anything.
 * `effective_end === null` means "still the current release as of the last
 * time this series was refreshed" -- it is a fact about that release's known
 * lifespan, not a promise that it covers every future cutoff; a cutoff after
 * the series was last refreshed still resolves against whatever `null`-ended
 * window is open, because that is genuinely the newest information this
 * series has, not a stand-in for "current data" pulled outside the series.
 */
function assertVintageShape(entry, index) {
  const label = `vintages[${index}]`;
  if (!entry || typeof entry !== "object") throw new Error(`${label} must be an object`);
  requireNonEmptyString(entry.vintage, `${label}.vintage`);
  requireDateOnly(entry.effective_start, `${label}.effective_start`);
  if (entry.effective_end != null) requireDateOnly(entry.effective_end, `${label}.effective_end`);
  if (entry.effective_end != null && entry.effective_end <= entry.effective_start) {
    throw new Error(`${label}: effective_end must be after effective_start`);
  }
}

/**
 * Detect overlapping windows within one layer's vintage series. Two releases
 * of the same layer are never simultaneously in force; an overlap means the
 * series itself is malformed and must be reported as a data-integrity
 * problem rather than resolved past.
 */
export function findOverlappingVintages(vintages = []) {
  const sorted = [...vintages].sort((a, b) => a.effective_start.localeCompare(b.effective_start));
  const overlaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.effective_end == null || prev.effective_end > cur.effective_start) {
      overlaps.push([prev.vintage, cur.vintage]);
    }
  }
  return overlaps;
}

function inWindow(entry, cutoff) {
  if (cutoff < entry.effective_start) return false;
  if (entry.effective_end != null && cutoff >= entry.effective_end) return false;
  return true;
}

/**
 * Build the explicit coverage-gap record for a refused join (A5). Mirrors
 * warehouse/lib/seqra_document_coverage_gaps.mjs's convention: an absence of
 * layer coverage is reported as a stated limitation, never left implicit.
 */
export function buildSpatialCoverageGap({ layerType, bbl, cutoff, reason, candidateVintageCount = 0 }) {
  return Object.freeze({
    schema: SEQRA_SPATIAL_COVERAGE_GAP_SCHEMA,
    layer_type: layerType,
    bbl,
    cutoff,
    gap_detected: true,
    reason,
    candidate_vintage_count: candidateVintageCount,
    statement:
      `No ${layerType} layer vintage covers ${cutoff} for BBL ${bbl}. This is reported as a coverage gap; ` +
      "the join is refused rather than completed with the current or nearest available vintage.",
  });
}

/**
 * Resolve the layer vintage in force at `cutoff` for one `vintages` series.
 * Throws SeqraLayerVintageError (never returns a best-effort fallback) when:
 *   - the series has no window covering `cutoff`, or
 *   - the series itself has overlapping windows (ambiguous coverage).
 *
 * @param {{ layerType: string, bbl: string, cutoff: string, vintages: Array<{vintage:string, effective_start:string, effective_end:string|null, [k:string]: unknown}> }} args
 */
export function resolveLayerVintage({ layerType, bbl, cutoff, vintages }) {
  requireNonEmptyString(layerType, "layerType");
  requireNonEmptyString(bbl, "bbl");
  requireDateOnly(cutoff, "cutoff");
  if (!Array.isArray(vintages)) throw new Error("vintages must be an array");
  vintages.forEach(assertVintageShape);

  const overlaps = findOverlappingVintages(vintages);
  if (overlaps.length > 0) {
    throw new SeqraLayerVintageError(
      `${layerType} vintage series has overlapping windows: ${overlaps.map(([a, b]) => `${a}/${b}`).join(", ")}`,
      buildSpatialCoverageGap({
        layerType,
        bbl,
        cutoff,
        reason: "overlapping_vintage_windows",
        candidateVintageCount: vintages.length,
      }),
    );
  }

  const match = vintages.find((entry) => inWindow(entry, cutoff));
  if (!match) {
    throw new SeqraLayerVintageError(
      `no ${layerType} vintage covers cutoff ${cutoff} for BBL ${bbl}`,
      buildSpatialCoverageGap({
        layerType,
        bbl,
        cutoff,
        reason: "no_vintage_covers_cutoff",
        candidateVintageCount: vintages.length,
      }),
    );
  }
  return match;
}

export { requireDateOnly, requireNonEmptyString };
