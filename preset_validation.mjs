// Pure selection helpers shared by the live-data preset generator and its unit tests.

export function firstNonEmptyVariant(variants, counts) {
  for (const variant of variants || []) {
    const count = Number(counts?.[variant.id] ?? variant.count ?? 0);
    if (count > 0) return { ...variant, count };
  }
  return null;
}

export function fruitfulSuggestionIndices(candidates, minResults = 1) {
  const byLens = {};
  for (const candidate of candidates || []) {
    if (Number(candidate.count) < minResults) continue;
    if (!byLens[candidate.lens]) byLens[candidate.lens] = [];
    byLens[candidate.lens].push(candidate.idx);
  }
  for (const lens of Object.keys(byLens)) {
    byLens[lens] = [...new Set(byLens[lens])].sort((a, b) => a - b);
  }
  return byLens;
}

export function deadSelectedSuggestions(byLens, candidates, minResults = 1) {
  const counts = new Map(
    (candidates || []).map((candidate) => [
      `${candidate.lens}:${candidate.idx}`,
      Number(candidate.count) || 0,
    ]),
  );
  const dead = [];
  for (const [lens, indices] of Object.entries(byLens || {})) {
    for (const idx of indices || []) {
      if ((counts.get(`${lens}:${idx}`) || 0) < minResults) dead.push({ lens, idx });
    }
  }
  return dead;
}
