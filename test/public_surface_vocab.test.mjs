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

test("public-surface vocabulary detector rejects architecture jargon and mechanics narration", () => {
  const code = String.raw`
import importlib.util
from pathlib import Path
path = Path("test/standards/public_surface_vocab.py")
spec = importlib.util.spec_from_file_location("public_surface_vocab", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
bad = [
    "Map facet",
    "Keep the active scope",
    "Personal enhancement island",
    "Open this document route",
    "These links work without JavaScript",
    "This no-JS view keeps the scope object",
    "The server-rendered static-first page is ready",
]
for value in bad:
    assert any(pattern.search(value) for _, pattern in module.PUBLIC_COPY_PATTERNS), value
good = [
    "Map view",
    "Keep your active filters",
    "See these records on a map",
    "Staten Island",
    "Open the official document",
]
for value in good:
    assert not any(pattern.search(value) for _, pattern in module.PUBLIC_COPY_PATTERNS), value
`;
  const result = spawnSync("python3", ["-c", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("public-surface vocabulary detector rejects constellation receipts and internal nouns", () => {
  const code = String.raw`
import importlib.util
from pathlib import Path
path = Path("test/standards/public_surface_vocab.py")
spec = importlib.util.spec_from_file_location("public_surface_vocab", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
bad = [
    "Coverage: 231 of 231 in the 231-project current snapshot. Snapshot 2026-08-02",
    "Coverage: {linked} of {eligible} in the {scope}-project current snapshot",
    "Snapshot " + "$" + "{built_at}",
    "Data snapshot 2026-08-02T10:22:34.003Z",
    "View all as scope",
    "Click to pivot to this entity ref",
]
for value in bad:
    assert any(pattern.search(value) for _, pattern in module.INTERNAL_RECEIPT_PATTERNS + module.PUBLIC_COPY_PATTERNS), value
good = [
    "See all connected records",
    "Filter by this project",
    "Queens — Block 1820, Lot 1 (BBL 4018200001)",
]
for value in good:
    assert not any(pattern.search(value) for _, pattern in module.INTERNAL_RECEIPT_PATTERNS + module.PUBLIC_COPY_PATTERNS), value
`;
  const result = spawnSync("python3", ["-c", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("public-surface vocabulary detector rejects the retired watch curriculum", () => {
  const code = String.raw`
import importlib.util
from pathlib import Path
path = Path("test/standards/public_surface_vocab.py")
spec = importlib.util.spec_from_file_location("public_surface_vocab", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
bad = [
    "We'll email a link to confirm.",
    "Email and privacy",
    "Confirm first",
    "This is called double opt-in.",
    "All your watches",
    "Save a set of filters once.",
    "Monitor packs",
    "District digests",
    "One digest",
    "Saved filters",
    "What this watch follows",
    "The preview and each email use these same terms.",
    "Choose a topic or place",
    "Preview your filters first.",
]
for value in bad:
    assert any(pattern.search(value) for _, pattern in module.DIDACTIC_COPY_PATTERNS), value
good = [
    "Manage your watches",
    "Watch sets",
    "Pick a topic or place to see matches.",
    "Each email includes a link to stop a watch.",
]
for value in good:
    assert not any(pattern.search(value) for _, pattern in module.DIDACTIC_COPY_PATTERNS), value
`;
  const result = spawnSync("python3", ["-c", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("public-surface vocabulary detector rejects vendor-footprint implementation language", () => {
  const code = String.raw`
import importlib.util
from pathlib import Path
path = Path("test/standards/public_surface_vocab.py")
spec = importlib.util.spec_from_file_location("public_surface_vocab", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
bad = [
    "No strongly linked records in this build.",
    "coverage not measured for this section",
    "showing strong links only",
    "View this vendor as a awards scope",
    "Connection strength: strong",
]
for value in bad:
    assert any(pattern.search(value) for _, pattern in module.VENDOR_FOOTPRINT_JARGON_PATTERNS), value
good = [
    "2 links we’ve confirmed",
    "12 records mention this name",
    "We haven’t measured how complete this section is yet",
    "See CAMBA's awards (12)",
]
for value in good:
    assert not any(pattern.search(value) for _, pattern in module.VENDOR_FOOTPRINT_JARGON_PATTERNS), value
`;
  const result = spawnSync("python3", ["-c", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
