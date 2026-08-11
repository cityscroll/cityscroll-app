// Person-name keys for official identity binding.
//
// Used to join free-text lobby targets and campaign-finance recipient labels
// onto the Council Members person hub (uvw5-9znb / Legistar PersonId). Exact
// unique key hits only — never invents a person from a weak name match.

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** Fold accents and case for conservative exact keys. */
export function foldPersonText(value) {
  return clean(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toUpperCase();
}

/**
 * Stable match keys for one person display name.
 * Emits the full folded name, first+last (dropping middle initials), and
 * CFB-style "Last, First" reorderings when a comma is present.
 *
 * @param {string|null|undefined} name
 * @returns {string[]}
 */
export function personNameKeys(name) {
  const raw = clean(name);
  if (!raw) return [];
  const keys = new Set();

  const pushFromFolded = (folded) => {
    let s = folded.replace(/[^A-Z0-9 ]/g, " ");
    s = s.replace(/\b(JR|SR|II|III|IV|ESQ)\b/g, " ");
    s = s.replace(/\s+/g, " ").trim();
    if (s.length < 4) return;
    keys.add(s);
    const toks = s.split(" ").filter(Boolean);
    if (toks.length >= 2) {
      keys.add(`${toks[0]} ${toks[toks.length - 1]}`);
      const noMid = toks.filter((t) => t.length > 1).join(" ");
      if (noMid.length >= 4) keys.add(noMid);
    }
  };

  pushFromFolded(foldPersonText(raw));

  if (raw.includes(",")) {
    const [lastPart, firstPart] = raw.split(",", 2).map((part) => clean(part));
    if (lastPart && firstPart) {
      pushFromFolded(foldPersonText(`${firstPart} ${lastPart}`));
    }
  }

  return [...keys];
}

/**
 * Index person_id → name keys and reverse name-key → person_id set.
 * @param {Array<{ person_id?: string, person_name?: string, name?: string }>} people
 */
export function buildPersonNameIndex(people = []) {
  const byId = new Map();
  const byKey = new Map();
  for (const row of Array.isArray(people) ? people : []) {
    const id = clean(row?.person_id ?? row?.council_member_id).replace(/^official:/, "");
    const name = clean(row?.person_name ?? row?.name);
    if (!id || !/^\d+$/.test(id) || !name) continue;
    if (!byId.has(id)) byId.set(id, { person_id: id, names: new Set(), keys: new Set() });
    const bag = byId.get(id);
    bag.names.add(name);
    for (const key of personNameKeys(name)) {
      bag.keys.add(key);
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(id);
    }
  }
  return { byId, byKey };
}

/**
 * Resolve a free-text person label to exactly one person_id, or null.
 * Ambiguous multi-id keys stay unresolved (precision over recall).
 *
 * @param {string} name
 * @param {{ byKey: Map<string, Set<string>> }} index
 * @returns {{ person_id: string, match_key: string, method: string }|null}
 */
export function resolvePersonName(name, index) {
  if (!index?.byKey) return null;
  for (const key of personNameKeys(name)) {
    const ids = index.byKey.get(key);
    if (!ids || ids.size === 0) continue;
    if (ids.size === 1) {
      return {
        person_id: [...ids][0],
        match_key: key,
        method: "exact_unique_person_name_key",
      };
    }
  }
  return null;
}
