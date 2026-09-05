function displayNameFor(dossier, entityRef) {
  const root = dossier?.root || {};
  if (root.display_name || root.canonical_name) return root.display_name || root.canonical_name;
  const ref = String(entityRef || "");
  if (ref.startsWith("vendor:stem:")) {
    try { return decodeURIComponent(ref.slice("vendor:stem:".length)) || ref; } catch { return ref; }
  }
  return ref;
}

export function graphLinkRows(doc) {
  const objectBySubject = new Map();
  const graphLinkByKey = new Map();
  for (const dossier of Object.values(doc?.by_ref || {})) {
    for (const block of Object.values(dossier?.domains || {})) {
      for (const object of block?.objects || []) {
        if (object?.subject_ref && !objectBySubject.has(object.subject_ref)) {
          objectBySubject.set(object.subject_ref, object);
        }
      }
    }
    for (const link of dossier?.links || []) {
      if (link?.type !== "decides_land_project" || !String(link?.to || "").startsWith("project:")) continue;
      graphLinkByKey.set([link.type, link.from, link.to].join("|"), link);
    }
  }
  return [...graphLinkByKey.values()].map((link) => {
    const object = objectBySubject.get(link.from) || {};
    const rootRef = object.root_ref;
    const agencyName = rootRef ? displayNameFor(doc.by_ref?.[rootRef], rootRef) : null;
    return {
      to_ref: link.to,
      from_ref: link.from,
      link_type: link.type,
      payload: {
        ...link,
        label: object.label || link.from,
        agency_name: agencyName,
        when: object.when || link.provenance?.observed_at || null,
      },
    };
  });
}

