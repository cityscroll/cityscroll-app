// Public-safe entity-link confidence bands.
//
// Desk rows store a numeric matcher score on entity_link.confidence. Public
// surfaces never receive that number or the matcher method — only a coarse band
// so readers can tell strong cross-source links from tentative ones.

export const PUBLIC_LINK_CONFIDENCE_VERSION = "public_link_confidence_v1";

/** Auto-same floor from conventional matcher token-similarity (0.95). */
export const PUBLIC_LINK_CONFIDENCE_STRONG_MIN = 0.95;

export const PUBLIC_LINK_CONFIDENCE_STATUSES = Object.freeze([
  "strong",
  "tentative",
  "not_scored",
]);

export const PUBLIC_LINK_CONFIDENCE_READER_LABELS = Object.freeze({
  strong: "Strong link",
  tentative: "Tentative link",
  not_scored: "Link not scored",
});

/**
 * Map a desk numeric confidence to the public band object.
 * Never returns the raw score.
 *
 * @param {unknown} score entity_link.confidence (0–1) or null
 * @returns {{ status: "strong"|"tentative"|"not_scored", basis: "entity_link" }}
 */
export function publicEntityLinkConfidence(score) {
  if (score == null || score === "") {
    return { status: "not_scored", basis: "entity_link" };
  }
  const n = Number(score);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    return { status: "not_scored", basis: "entity_link" };
  }
  if (n >= PUBLIC_LINK_CONFIDENCE_STRONG_MIN) {
    return { status: "strong", basis: "entity_link" };
  }
  return { status: "tentative", basis: "entity_link" };
}

export function readerLabelForLinkConfidence(status) {
  const key = String(status ?? "").trim();
  return PUBLIC_LINK_CONFIDENCE_READER_LABELS[key] || PUBLIC_LINK_CONFIDENCE_READER_LABELS.not_scored;
}

function isBanded(status) {
  return status === "strong" || status === "tentative";
}

/**
 * public_entity_link_confidence_rate on resolved-entity dossiers:
 *
 *   banded_linked_records / linked_records_total
 *
 * A linked record is banded only when its public `link_confidence.status` is
 * `strong` or `tentative`. Missing `link_confidence` or `not_scored` counts as
 * unbanded. Baseline without product surfacing: 0. Target with scored auto-links: 1.0.
 *
 * @param {Array<object>} dossiers public dossier objects (or { linked_records })
 * @returns {{
 *   metric: string,
 *   version: string,
 *   eligible: number,
 *   labeled: number,
 *   rate: number,
 *   cases: Array<object>
 * }}
 */
export function measurePublicEntityLinkConfidenceRate(dossiers = []) {
  const list = Array.isArray(dossiers) ? dossiers : [];
  const cases = [];
  let eligible = 0;
  let labeled = 0;

  for (const dossier of list) {
    if (!dossier || typeof dossier !== "object") continue;
    const entityId = String(dossier.entity?.id ?? dossier.entity_id ?? "").trim() || null;
    const records = Array.isArray(dossier.linked_records) ? dossier.linked_records : [];
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      eligible += 1;
      const status = String(record.link_confidence?.status ?? "").trim();
      const ok = isBanded(status);
      if (ok) labeled += 1;
      cases.push({
        entity_id: entityId,
        source_system: String(record.source?.system ?? "").trim() || null,
        source_id: String(record.source?.id ?? "").trim() || null,
        status: status || null,
        labeled: ok,
      });
    }
  }

  const rate = eligible === 0 ? 0 : labeled / eligible;
  return {
    metric: "public_entity_link_confidence_rate",
    version: PUBLIC_LINK_CONFIDENCE_VERSION,
    eligible,
    labeled,
    rate,
    cases,
  };
}

/**
 * Summarize public bands for a set of linked records (entity-level overview).
 * @param {Array<{ link_confidence?: { status?: string } }>} records
 */
export function summarizeLinkConfidence(records = []) {
  const summary = { strong: 0, tentative: 0, not_scored: 0, total: 0 };
  for (const record of Array.isArray(records) ? records : []) {
    const status = String(record?.link_confidence?.status ?? "not_scored").trim() || "not_scored";
    if (status === "strong") summary.strong += 1;
    else if (status === "tentative") summary.tentative += 1;
    else summary.not_scored += 1;
    summary.total += 1;
  }
  return summary;
}
