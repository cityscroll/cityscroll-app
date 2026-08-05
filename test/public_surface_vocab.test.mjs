import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("public-surface vocabulary detector rejects join mechanics", () => {
  const code = String.raw`
import importlib.util
from pathlib import Path
path = Path("test/standards/public_surface_vocab.py")
spec = importlib.util.spec_from_file_location("public_surface_vocab", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
bad = [
    "Joined 2 City Record notices for a subject",
    "franchise:solicitation:b385-sb-2025",
    "Match (exact_concession_id)",
    "Match (fuzzy_title_date)",
    "Joined {n} notices ({method})",
    "6 of 7 domains have linked objects",
]
for value in bad:
    assert any(pattern.search(value) for _, pattern in module.JOIN_MECHANICS_PATTERNS), value
good = [
    "Public hearing scheduled for August 10, 2026",
    "Solicitation B385-SB-2025",
    "Exact solicitation number",
]
for value in good:
    assert not any(pattern.search(value) for _, pattern in module.JOIN_MECHANICS_PATTERNS), value
assert module.LABEL_BADGE_KEY.search("entity_intel_lead")
assert module.CONTRASTIVE_NEGATION.search("Published records — not siloed lists")
assert not module.CONTRASTIVE_NEGATION.search("Published records organized by topic")
bad_render = [
    "method: escUiHtml(join.method || '—')",
    "subject: escUiHtml(spine.subject_ref || '—')",
]
for value in bad_render:
    assert any(pattern.search(value) for _, pattern in module.DIRECT_RENDER_PATTERNS), value
`;
  const result = spawnSync("python3", ["-c", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
