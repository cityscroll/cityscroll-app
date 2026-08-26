import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const HARNESS = new URL("../tools/content_parity_harness.py", import.meta.url);

function runPython(code) {
  const result = spawnSync("python3", ["-c", code], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("content parity fails with the specific removed record and control", () => {
  const output = runPython(`
import importlib.util, json
spec = importlib.util.spec_from_file_location("h", ${JSON.stringify(HARNESS.pathname)})
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
before = {"records": [{"key": "record:notice:42", "fields": {"text": "Title Amount $10"}, "text": "Title Amount $10"}], "controls": [{"key": "button:save", "signature": "button:save:Save::", "label": "Save"}]}
after = {"records": [], "controls": []}
print(json.dumps(h.compare_content(before, after, "notice", {})))
`);
  assert.equal(output.verdict, "FAIL");
  assert.deepEqual(output.missing.map((item) => item.key), ["record:notice:42", "button:save:Save::"]);
});

test("content parity allows additive records while readiness requires a real improvement", () => {
  const output = runPython(`
import importlib.util, json
spec = importlib.util.spec_from_file_location("h", ${JSON.stringify(HARNESS.pathname)})
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
before = {"records": [{"key": "record:contract:1", "fields": {"text": "Vendor $10"}, "text": "Vendor $10"}], "controls": []}
after = {"records": [{"key": "record:contract:1", "fields": {"text": "Vendor $10"}, "text": "Vendor $10"}, {"key": "record:contract:2", "fields": {"text": "New $20"}, "text": "New $20"}], "controls": []}
content = h.compare_content(before, after, "browse-contracts", {})
readiness = h.compare_readiness({"metrics": {"p75": {"content_ready_ms": 300, "component_ready_ms": 320, "first_paint_ms": 200, "first_contentful_paint_ms": 250}}}, {"metrics": {"p75": {"content_ready_ms": 220, "component_ready_ms": 240, "first_paint_ms": 200, "first_contentful_paint_ms": 250}}}, 1)
print(json.dumps({"content": content, "readiness": readiness}))
`);
  assert.equal(output.content.verdict, "PASS");
  assert.equal(output.readiness.verdict, "PASS");
});

test("intentional content loss is only accepted with an exact reasoned annotation", () => {
  const output = runPython(`
import importlib.util, json
spec = importlib.util.spec_from_file_location("h", ${JSON.stringify(HARNESS.pathname)})
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
before = {"records": [{"key": "record:notice:42", "fields": {"text": "Old"}, "text": "Old"}], "controls": []}
after = {"records": [], "controls": []}
allowed = {("notice", "record", "record:notice:42"): "Canonical replacement is rendered by the same source."}
print(json.dumps(h.compare_content(before, after, "notice", allowed)))
`);
  assert.equal(output.verdict, "PASS");
  assert.equal(output.allowed_losses[0].reason, "Canonical replacement is rendered by the same source.");
});
