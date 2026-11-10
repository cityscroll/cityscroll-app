// Shared phase-state rule for every lens that uses the material-passes rail.
// order: phase ids in process order; current: current phase id; material: ids that carry real events.
// rule 'material-passes' = the rule shared by matter, vendor, procurement, meeting and rules spines.
// rule 'strict' = paper-trail rule: only phases before the current one are passed, and a
// current phase without material is not shown as current.
export const RULES = Object.freeze(['material-passes', 'strict']);

export function phaseStates({ order, current, material = [], rule = 'material-passes' }) {
  if (!Array.isArray(order) || !order.length) throw new TypeError('order must be a non-empty list of phase ids');
  if (new Set(order).size !== order.length) throw new TypeError('phase ids must be unique');
  if (!RULES.includes(rule)) throw new TypeError('unknown rule: ' + rule);
  const cur = order.indexOf(current);
  if (cur < 0) throw new RangeError('current phase is not in order: ' + current);
  const has = new Set(material);
  return order.map((id, idx) => {
    let state;
    if (rule === 'strict') {
      if (has.has(id)) state = id === current ? 'current' : idx < cur ? 'passed' : 'future';
      else state = idx < cur ? 'passed' : 'future';
    } else if (id === current) state = 'current';
    else if (idx < cur || has.has(id)) state = 'passed';
    else state = 'future';
    return { id, state };
  });
}
