export function displayNameFor(dossier, entityRef) {
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
  const graphLinks = [];
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
      graphLinks.push(link);
    }
  }
  return graphLinks.map((link) => {
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

function inventoryToken(value, max = 120) {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean || clean.length > max || !/^[a-z0-9][a-z0-9._:-]*$/.test(clean)) return null;
  return clean;
}

function ontologyInventory(doc) {
  const entityTypes = new Set();
  const edgeTypes = new Set();
  for (const row of Object.values(doc?.by_ref || {})) {
    const entityType = inventoryToken(row?.root?.kind);
    if (entityType) entityTypes.add(entityType);
    for (const link of row?.links || []) {
      const edgeType = inventoryToken(link?.type || link?.link_type);
      if (edgeType) edgeTypes.add(edgeType);
    }
    for (const domain of Object.values(row?.domains || {})) {
      for (const object of domain?.objects || []) {
        const edgeType = inventoryToken(object?.link_type);
        if (edgeType) edgeTypes.add(edgeType);
      }
    }
  }
  return {
    as_of: doc?.generated_at || null,
    entity_types: [...entityTypes].sort(),
    edge_types: [...edgeTypes].sort(),
  };
}

function projectConnectionCoverage(doc) {
  const graphLinkByKey = new Map();
  for (const dossier of Object.values(doc?.by_ref || {})) {
    for (const link of dossier?.links || []) {
      if (link?.type !== "decides_land_project" || !String(link?.to || "").startsWith("project:")) continue;
      graphLinkByKey.set([link.type, link.from, link.to].join("|"), link);
    }
  }
  const graphProjectCount = new Set([...graphLinkByKey.values()].map((link) => link.to)).size;
  return {
    meetings: {
      eligible: null,
      linked: graphProjectCount,
      rate: null,
      scope: "bounded_entity_materialization",
      vintage: doc?.generated_at || null,
      gap: "eligible_denominator_not_measured",
    },
    notices: {
      eligible: null,
      linked: null,
      rate: null,
      scope: "this_project",
      vintage: doc?.generated_at || null,
      gap: "eligible_denominator_not_measured",
    },
  };
}

export function entityIntelligenceSummary(doc) {
  return {
    schema_version: doc.schema_version,
    phase: doc.phase,
    title: doc.title,
    version: doc.version,
    generated_at: doc.generated_at,
    domains: doc.domains,
    demo_refs: doc.demo_refs,
    verified_demo: doc.verified_demo,
    entity_index: doc.entity_index || [],
    provenance: doc.provenance,
    vendor_footprint: doc.vendor_footprint || null,
    selection: doc.selection,
    ontology_inventory: ontologyInventory(doc),
    project_connection_coverage: projectConnectionCoverage(doc),
  };
}
