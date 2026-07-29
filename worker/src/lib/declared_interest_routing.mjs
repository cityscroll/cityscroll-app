const ALLOWED_DIMENSIONS = Object.freeze(["topics", "places", "actions"]);

function overlap(left = [], right = []) {
  const values = new Set(right.map((value) => String(value).toLowerCase()));
  return left.some((value) => values.has(String(value).toLowerCase()));
}

export function routeDeclaredInterest(declared, notice) {
  const matches = {};
  for (const dimension of ALLOWED_DIMENSIONS) {
    matches[dimension] = overlap(declared[dimension], notice[dimension]);
  }
  const matched = Object.values(matches).every(Boolean);
  return {
    matched,
    rule: {
      kind: "declared_interest",
      required_dimensions: ALLOWED_DIMENSIONS,
      declared: Object.fromEntries(ALLOWED_DIMENSIONS.map((dimension) => [dimension, declared[dimension] || []])),
      public_inputs: notice.public_inputs || []
    },
    reason: matched
      ? ALLOWED_DIMENSIONS.map((dimension) => `${dimension}: ${declared[dimension].join(", ")}`).join(" · ")
      : "The public notice does not match every declared topic, place, and action criterion."
  };
}

export function routeNotice(declared, notice, ignoredContext = {}) {
  // ignoredContext is accepted so tests can prove browser history, referrer, inferred location,
  // and identity hints cannot change a deterministic declared-interest result.
  void ignoredContext;
  return routeDeclaredInterest(declared, notice);
}

export function validateRoutingOntology(ontology) {
  if (ontology.profile_storage !== false) throw new TypeError("routing ontology cannot create profiles");
  if (ontology.behavioral_inputs.length) throw new TypeError("behavioral inputs are forbidden");
  if (ontology.dimensions.some((dimension) => !ALLOWED_DIMENSIONS.includes(dimension.id))) {
    throw new TypeError("routing ontology contains an undeclared dimension");
  }
  return ontology;
}
