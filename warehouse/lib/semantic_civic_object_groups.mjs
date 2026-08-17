export const SEMANTIC_CIVIC_OBJECT_FAMILIES = Object.freeze([
  "contracts",
  "people-organizations",
  "land",
  "rules",
  "meetings",
  "exams",
]);

const CIVIC_OBJECT_FAMILIES = new Set(SEMANTIC_CIVIC_OBJECT_FAMILIES);

export function semanticSourceRecordId(sourceFamily, sourceNativeId) {
  return `${sourceFamily}:${encodeURIComponent(sourceNativeId)}`;
}

export function buildSemanticCivicObjectIndex(selectionManifest = {}) {
  const groups = selectionManifest.civic_object_groups;
  if (!Array.isArray(groups) || !groups.length) {
    throw new Error("semantic source manifest requires civic object groups");
  }

  const index = new Map();
  for (const group of groups) {
    const family = String(group?.id || "").trim();
    const sourceFamily = String(group?.source_family || "").trim();
    if (!CIVIC_OBJECT_FAMILIES.has(family) || !sourceFamily) {
      throw new Error("semantic civic object group is incomplete");
    }

    let nativeIds;
    if (group.selection_list) {
      const selection = selectionManifest[group.selection_list];
      if (!Array.isArray(selection)
          || !Number.isInteger(group.offset)
          || group.offset < 0
          || !Number.isInteger(group.count)
          || group.count < 1) {
        throw new Error(`semantic civic object range is invalid for ${family}`);
      }
      nativeIds = selection.slice(group.offset, group.offset + group.count);
      if (nativeIds.length !== group.count
          || nativeIds[0] !== group.first_source_native_id
          || nativeIds.at(-1) !== group.last_source_native_id) {
        throw new Error(`semantic civic object range boundary changed for ${family}`);
      }
    } else {
      nativeIds = group.source_native_ids;
    }
    if (!Array.isArray(nativeIds) || !nativeIds.length) {
      throw new Error(`semantic civic object group has no sources for ${family}`);
    }

    for (const nativeIdValue of nativeIds) {
      const nativeId = String(nativeIdValue || "").trim();
      if (!nativeId) throw new Error(`semantic civic object group has an empty source for ${family}`);
      const sourceRecordId = semanticSourceRecordId(sourceFamily, nativeId);
      if (index.has(sourceRecordId)) {
        throw new Error(`semantic source has multiple civic object groups: ${sourceRecordId}`);
      }
      index.set(sourceRecordId, family);
    }
  }
  return index;
}
