/**
 * Retained measurements that pin repository bytes. A retained measurement
 * under docs/evidence declares `measurement_provenance.inputs`: the paths and
 * digests it describes. Changing a pinned path makes that measurement stop
 * describing the tree, so the connected-history cycle holds such a change and
 * a builder names what its regeneration invalidates.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function walkJson(root, directory, found = []) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return found;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walkJson(root, path, found);
    else if (entry.isFile() && entry.name.endsWith(".json")) found.push(path);
  }
  return found;
}

/**
 * Retained measurements under docs/evidence that pin a path's bytes. Changing
 * a pinned path makes that measurement stop describing the served tree.
 */
export function retainedEvidencePins(root, evidenceRoot = "docs/evidence") {
  const pins = [];
  for (const path of walkJson(root, evidenceRoot).sort()) {
    const absolute = join(root, path);
    const text = existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
    if (!text || !text.includes("\"measurement_provenance\"")) continue;
    let provenance;
    try {
      provenance = JSON.parse(text).measurement_provenance;
    } catch {
      continue;
    }
    const inputs = (provenance?.inputs || []).map((input) => input?.path).filter(Boolean);
    if (inputs.length) pins.push({ path, measured_revision: provenance.revision || null, inputs });
  }
  return pins;
}

export function evidenceInvalidatedBy(pins, changedPaths) {
  const changed = new Set(changedPaths);
  return pins
    .map((pin) => ({ ...pin, inputs_changed: pin.inputs.filter((input) => changed.has(input)) }))
    .filter((pin) => pin.inputs_changed.length)
    .map(({ path, measured_revision, inputs_changed }) => ({ path, measured_revision, inputs_changed }));
}
