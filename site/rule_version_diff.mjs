/**
 * Deterministic, source-preserving comparison of two retained rule versions.
 *
 * This is intentionally a comparison of extracted text, not an interpretation
 * of legal effect or motivation. Missing/non-text input and uncertain section
 * alignment stay unavailable rather than being presented as no change.
 */

export const RULE_VERSION_DIFF_SCHEMA = "cityscroll.rule_version_diff.v1";

const clean = (value, max = 50_000) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const textAvailable = (version) => Boolean(version?.text && version.text_status === "available");
const nonTextStatus = (status) => /scan|non.?text|image|pdf/i.test(String(status || ""));

function normalized(value) {
  return clean(value, 50_000).toLowerCase().replace(/[^a-z0-9§]+/g, " ").trim();
}

function trimBounds(text, start, end) {
  const source = String(text || "");
  while (start < end && /\s/.test(source[start])) start += 1;
  while (end > start && /\s/.test(source[end - 1])) end -= 1;
  return { start, end };
}

function sectionFromBounds(text, start, end, index) {
  const bounds = trimBounds(text, start, end);
  const value = String(text || "").slice(bounds.start, bounds.end);
  return {
    index,
    text: value,
    start: bounds.start,
    end: bounds.end,
    fingerprint: normalized(value),
    label: clean(value, 100),
  };
}

/**
 * Use publisher paragraph boundaries when retained; otherwise use sentence
 * boundaries. The fallback is deterministic for the normalized text stored by
 * the RD-M3 materializer and still gives residents meaningful regions.
 */
export function sectionizeRuleText(text) {
  const source = String(text || "");
  if (!source.trim()) return [];
  const sections = [];
  const boundaryPattern = source.includes("\n") ? /[^\n]+/g : /[^.!?]+(?:[.!?]+|$)/g;
  for (const match of source.matchAll(boundaryPattern)) {
    const section = sectionFromBounds(source, match.index, match.index + match[0].length, sections.length);
    if (section.text) sections.push(section);
  }
  return sections.length ? sections : [sectionFromBounds(source, 0, source.length, 0)];
}

function lcsPairs(left, right) {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i].fingerprint && left[i].fingerprint === right[j].fingerprint
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i].fingerprint && left[i].fingerprint === right[j].fingerprint) {
      pairs.push({ proposed: left[i], adopted: right[j], relation: "unchanged" });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function duplicateFingerprints(sections) {
  const counts = new Map();
  for (const section of sections) {
    if (section.fingerprint) counts.set(section.fingerprint, (counts.get(section.fingerprint) || 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([fingerprint]) => fingerprint);
}

/**
 * Align exact sections first. Unmatched runs may be paired positionally only
 * when their cardinality is equal; otherwise the document is ambiguous.
 */
export function alignRuleVersionSections(proposedText, adoptedText) {
  const proposed = sectionizeRuleText(proposedText);
  const adopted = sectionizeRuleText(adoptedText);
  if (!proposed.length || !adopted.length) {
    return {
      status: "unavailable",
      reason_code: "missing_text",
      method: "ordered-section-lcs",
      proposed_sections: proposed.length,
      adopted_sections: adopted.length,
      aligned_sections: 0,
      pairs: [],
    };
  }
  if (proposed.length > 500 || adopted.length > 500) {
    return {
      status: "unavailable",
      reason_code: "section_alignment_limit",
      method: "ordered-section-lcs",
      proposed_sections: proposed.length,
      adopted_sections: adopted.length,
      aligned_sections: 0,
      pairs: [],
    };
  }
  if (duplicateFingerprints(proposed).length || duplicateFingerprints(adopted).length) {
    return {
      status: "unavailable",
      reason_code: "ambiguous_section_alignment",
      method: "ordered-section-lcs",
      proposed_sections: proposed.length,
      adopted_sections: adopted.length,
      aligned_sections: 0,
      pairs: [],
    };
  }

  const anchors = lcsPairs(proposed, adopted);
  const pairs = [];
  let proposedCursor = 0;
  let adoptedCursor = 0;
  const addRun = (leftRun, rightRun) => {
    if (!leftRun.length && !rightRun.length) return true;
    if (leftRun.length && rightRun.length && leftRun.length !== rightRun.length) return false;
    const count = Math.max(leftRun.length, rightRun.length);
    for (let index = 0; index < count; index += 1) {
      pairs.push({
        proposed: leftRun[index] || null,
        adopted: rightRun[index] || null,
        relation: leftRun[index] && rightRun[index] ? "changed" : leftRun[index] ? "removed" : "added",
      });
    }
    return true;
  };
  for (const anchor of anchors) {
    if (!addRun(proposed.slice(proposedCursor, anchor.proposed.index), adopted.slice(adoptedCursor, anchor.adopted.index))) {
      return {
        status: "unavailable",
        reason_code: "ambiguous_section_alignment",
        method: "ordered-section-lcs",
        proposed_sections: proposed.length,
        adopted_sections: adopted.length,
        aligned_sections: 0,
        pairs: [],
      };
    }
    pairs.push(anchor);
    proposedCursor = anchor.proposed.index + 1;
    adoptedCursor = anchor.adopted.index + 1;
  }
  if (!addRun(proposed.slice(proposedCursor), adopted.slice(adoptedCursor))) {
    return {
      status: "unavailable",
      reason_code: "ambiguous_section_alignment",
      method: "ordered-section-lcs",
      proposed_sections: proposed.length,
      adopted_sections: adopted.length,
      aligned_sections: 0,
      pairs: [],
    };
  }
  return {
    status: "aligned",
    reason_code: null,
    method: "ordered-section-lcs",
    proposed_sections: proposed.length,
    adopted_sections: adopted.length,
    aligned_sections: pairs.filter((pair) => pair.proposed && pair.adopted).length,
    pairs,
  };
}

function tokens(text) {
  return [...String(text || "").matchAll(/\S+/g)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
    key: match[0].toLowerCase(),
  }));
}

function wordRegions(proposed, adopted) {
  const left = tokens(proposed?.text);
  const right = tokens(adopted?.text);
  if (!left.length && !right.length) return [];
  // Legal documents can be large. A bounded fallback retains exact section
  // spans without allowing quadratic comparison to become a build hazard.
  if (left.length > 700 || right.length > 700) {
    return [{
      kind: left.length && right.length ? "changed" : left.length ? "removed" : "added",
      proposed_span: left.length ? { start: left[0].start, end: left[left.length - 1].end, text: proposed.text } : null,
      adopted_span: right.length ? { start: right[0].start, end: right[right.length - 1].end, text: adopted.text } : null,
    }];
  }
  const table = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i].key === right[j].key
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const regions = [];
  let i = 0;
  let j = 0;
  let leftStart = null;
  let rightStart = null;
  const flush = (leftEnd, rightEnd) => {
    if (leftStart == null && rightStart == null) return;
    const leftSlice = leftStart == null ? null : left.slice(leftStart, leftEnd);
    const rightSlice = rightStart == null ? null : right.slice(rightStart, rightEnd);
    regions.push({
      kind: leftSlice?.length && rightSlice?.length ? "changed" : leftSlice?.length ? "removed" : "added",
      proposed_span: leftSlice?.length ? { start: leftSlice[0].start, end: leftSlice[leftSlice.length - 1].end, text: proposed.text.slice(leftSlice[0].start, leftSlice[leftSlice.length - 1].end) } : null,
      adopted_span: rightSlice?.length ? { start: rightSlice[0].start, end: rightSlice[rightSlice.length - 1].end, text: adopted.text.slice(rightSlice[0].start, rightSlice[rightSlice.length - 1].end) } : null,
    });
    leftStart = null;
    rightStart = null;
  };
  while (i < left.length && j < right.length) {
    if (left[i].key === right[j].key) {
      flush(i, j);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      if (leftStart == null) leftStart = i;
      i += 1;
    } else {
      if (rightStart == null) rightStart = j;
      j += 1;
    }
  }
  if (i < left.length && leftStart == null) leftStart = i;
  if (j < right.length && rightStart == null) rightStart = j;
  flush(left.length, right.length);
  return regions;
}

function span(version, section, localSpan) {
  if (!section || !localSpan) return null;
  const start = section.start + localSpan.start;
  const end = section.start + localSpan.end;
  return {
    field: "text",
    start,
    end,
    text: String(version.text || "").slice(start, end),
    version_id: version.id || null,
    source_id: version.source_id || null,
    source_url: version.source_url || null,
  };
}

function unavailable(reasonCode, proposed, adopted, extra = {}) {
  return {
    schema: RULE_VERSION_DIFF_SCHEMA,
    status: "unavailable",
    reason_code: reasonCode,
    pair: extra.pair || null,
    proposed_version_id: proposed?.id || null,
    adopted_version_id: adopted?.id || null,
    source_links: [proposed, adopted].filter(Boolean).map((version) => ({
      version_id: version.id || null,
      kind: version.kind,
      label: version.kind === "adopted" ? "Adopted source" : "Proposed source",
      href: version.source_url || null,
    })),
    changed_region_count: null,
    alignment: null,
    regions: [],
    ...extra,
  };
}

export function buildRuleVersionDiff(proposed, adopted, pair = null) {
  if (!proposed || !adopted) return unavailable("unpaired_versions", proposed, adopted, { pair });
  if (!textAvailable(proposed)) return unavailable(nonTextStatus(proposed.text_status) ? "non_text_proposed" : "text_unavailable_proposed", proposed, adopted, { pair });
  if (!textAvailable(adopted)) return unavailable(nonTextStatus(adopted.text_status) ? "non_text_adopted" : "text_unavailable_adopted", proposed, adopted, { pair });
  const alignment = alignRuleVersionSections(proposed.text, adopted.text);
  if (alignment.status !== "aligned") {
    return unavailable(alignment.reason_code || "ambiguous_section_alignment", proposed, adopted, {
      pair,
      alignment: { ...alignment, pairs: undefined },
    });
  }
  const regions = [];
  for (const aligned of alignment.pairs) {
    if (aligned.relation === "unchanged") continue;
    for (const region of wordRegions(aligned.proposed || { text: "" }, aligned.adopted || { text: "" })) {
      const proposedSpan = span(proposed, aligned.proposed, region.proposed_span);
      const adoptedSpan = span(adopted, aligned.adopted, region.adopted_span);
      regions.push({
        id: `change-region:${proposed.id || "proposed"}:${adopted.id || "adopted"}:${regions.length + 1}`,
        kind: region.kind,
        section_index: aligned.proposed?.index ?? aligned.adopted?.index ?? regions.length,
        section_label: aligned.proposed?.label || aligned.adopted?.label || "Changed section",
        proposed_span: proposedSpan,
        adopted_span: adoptedSpan,
        source_links: [proposedSpan, adoptedSpan].filter(Boolean).map((item) => ({
          version_id: item.version_id,
          source_id: item.source_id,
          href: item.source_url,
        })),
      });
    }
  }
  return {
    schema: RULE_VERSION_DIFF_SCHEMA,
    status: "available",
    reason_code: null,
    pair,
    proposed_version_id: proposed.id || null,
    adopted_version_id: adopted.id || null,
    source_links: [proposed, adopted].map((version) => ({
      version_id: version.id || null,
      kind: version.kind,
      label: version.kind === "adopted" ? "Adopted source" : "Proposed source",
      href: version.source_url || null,
    })),
    changed_region_count: regions.length,
    alignment: {
      status: alignment.status,
      method: alignment.method,
      proposed_sections: alignment.proposed_sections,
      adopted_sections: alignment.adopted_sections,
      aligned_sections: alignment.aligned_sections,
      deterministic: true,
    },
    regions,
  };
}

export function unavailableRuleVersionDiff(reasonCode, proposed = null, adopted = null, pair = null) {
  return unavailable(reasonCode, proposed, adopted, { pair });
}
