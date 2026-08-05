/** Pure detectors for copy assembled from dynamic template slots. */

export function renderedCopyDefects(text, opts = {}) {
  const copy = String(text || "");
  const defects = [];
  const repeatPattern = /\b([\p{L}\p{N}][\p{L}\p{N}'’.-]*)\s+\1\b/giu;
  for (const match of copy.matchAll(repeatPattern)) {
    defects.push({
      code: "immediate-word-repetition",
      value: match[0],
      index: match.index,
    });
  }

  for (const slot of opts.slots || []) {
    const value = clean(slot?.value);
    const suffix = clean(slot?.suffix);
    if (!value || !suffix) continue;
    const lastWord = value.split(/\s+/).at(-1);
    if (lastWord?.localeCompare(suffix, undefined, { sensitivity: "accent" }) === 0) {
      defects.push({
        code: "slot-suffix-tautology",
        slot: clean(slot?.name) || null,
        value,
        suffix,
      });
    }
  }

  return defects;
}

function clean(value) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return text || null;
}
