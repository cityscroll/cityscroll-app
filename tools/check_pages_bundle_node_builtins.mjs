import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const IMPORT_SPECIFIER = /(?:import\s+(?:[^"'()]+?\s+from\s+)?|export\s+[^"'()]+?\s+from\s+|import\s*\()(["'])([^"']+)\1/g;

function resolveLocal(specifier, from) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.json`, `${base}/index.mjs`, `${base}/index.js`];
  return candidates.find((candidate) => existsSync(candidate));
}

export async function findPagesBundleNodeBuiltins({ entry = resolve(ROOT, "site/_worker.js") } = {}) {
  const pending = [resolve(entry)];
  const visited = new Set();
  const violations = [];
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    if (extname(file) === ".json") continue;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[2];
      if (NODE_BUILTINS.has(specifier) || specifier.startsWith("node:")) {
        violations.push({ file, specifier });
      } else {
        const local = resolveLocal(specifier, file);
        if (local) pending.push(local);
      }
    }
  }
  return { entry: resolve(entry), files: [...visited].sort(), violations };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await findPagesBundleNodeBuiltins({ entry: process.argv[2] ? resolve(process.argv[2]) : undefined });
  if (result.violations.length) {
    for (const violation of result.violations) console.error(`${violation.file}: ${violation.specifier}`);
    process.exitCode = 1;
  } else {
    console.log(`Pages bundle graph is Node-runtime safe (${result.files.length} modules checked)`);
  }
}
