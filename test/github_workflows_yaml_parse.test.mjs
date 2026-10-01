import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  checkBlockScalarIndentation,
  parseWorkflowText,
} from "../tools/check_github_workflows_yaml.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const CHECK = join(ROOT, "tools", "check_github_workflows_yaml.mjs");
const DEPLOY_WORKER = join(WORKFLOWS_DIR, "deploy-worker.yml");

function listWorkflowFiles() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => join(WORKFLOWS_DIR, name))
    .sort();
}

test("every .github/workflows file YAML-parses with vendored js-yaml", () => {
  const files = listWorkflowFiles();
  assert.ok(files.length >= 1, "expected at least one workflow file");
  for (const path of files) {
    const rel = path.slice(ROOT.length + 1);
    const text = readFileSync(path, "utf8");
    const indentErrors = checkBlockScalarIndentation(rel, text);
    assert.equal(
      indentErrors.length,
      0,
      indentErrors.join("\n") || `indent errors in ${rel}`,
    );
    const docs = parseWorkflowText(text, { filename: rel });
    assert.ok(docs.length >= 1, `${rel} must contain at least one YAML document`);
    assert.ok(docs[0] && typeof docs[0] === "object", `${rel} top document must be a mapping`);
  }

  // CLI entry must also succeed (same parser, no silent skip).
  const result = spawnSync(process.execPath, [CHECK], {
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.equal(result.status, 0, `${result.stderr || ""}${result.stdout || ""}`.trim());
  assert.match(result.stdout, /github workflows YAML check passed \(parser=vendored-js-yaml@4\.1\.1\)/);
});

test("deploy-worker.yml keeps the packed-snapshot chunk fetch inside the run block", () => {
  const text = readFileSync(DEPLOY_WORKER, "utf8");
  // Regression: column-0 "$chunk_keys" / "EOF" heredoc broke GitHub's parse
  // (run 36905784571: workflow path as name, 0 jobs). Prefer an indented
  // here-string so the run: | block scalar stays intact.
  assert.doesNotMatch(text, /^\$chunk_keys$/m);
  assert.doesNotMatch(text, /^EOF$/m);
  assert.match(text, /done <<< "\$chunk_keys"/);

  const docs = parseWorkflowText(text, { filename: "deploy-worker.yml" });
  assert.equal(docs[0].name, "Deploy worker");
  assert.ok(docs[0].jobs?.deploy);

  // The broken column-0 heredoc must fail closed (parser + indent guard).
  const broken = text.replace(
    '              done <<< "$chunk_keys"\n',
    '              done <<EOF\n$chunk_keys\nEOF\n',
  );
  assert.ok(
    checkBlockScalarIndentation("deploy-worker.yml", broken).length >= 1,
    "column-0 heredoc residue must trip the indent guard",
  );
  assert.throws(
    () => parseWorkflowText(broken, { filename: "deploy-worker.yml" }),
    /YAMLException|bad indentation|block mapping|implicit key|can not read/i,
  );
});
