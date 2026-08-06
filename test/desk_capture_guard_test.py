#!/usr/bin/env python3
import importlib.util
import json
import struct
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("desk_capture_guard", ROOT / "tools/check_public_image_captures.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def png_with_text(text: str) -> bytes:
    payload = b"Comment\0" + text.encode("ascii")
    chunk = struct.pack(">I", len(payload)) + b"tEXt" + payload + struct.pack(">I", 0)
    iend = struct.pack(">I", 0) + b"IEND" + struct.pack(">I", 0)
    return b"\x89PNG\r\n\x1a\n" + chunk + iend


class DeskCaptureGuardTest(unittest.TestCase):
    def test_path_boundary_does_not_flag_desktop(self):
        self.assertEqual(MODULE.inspect_image(Path("unused"), "docs/screenshots/desktop.png", {}), [])

    def test_path_markers_flag_added_private_capture(self):
        findings = MODULE.inspect_image(Path("unused"), "docs/team-captures/home.png", {})
        self.assertTrue(findings)

    def test_png_url_and_nav_signature_are_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "capture.png"
            path.write_bytes(png_with_text("https://desk.cityscroll.org/ Team Projects Settings Dashboard"))
            findings = MODULE.inspect_image(path, "docs/screenshots/capture.png", {})
        self.assertIn("PNG metadata contains desk.cityscroll.org", findings)
        self.assertIn("PNG metadata matches the desk navigation signature", findings)

    def test_allowlist_requires_reason_and_suppresses_exact_path(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "allowlist.json"
            path.write_text(json.dumps({"captures": {"docs/team-captures/home.png": "Public reference capture."}}))
            allowlist = MODULE.load_allowlist(path)
        self.assertEqual(MODULE.inspect_image(Path("unused"), "docs/team-captures/home.png", allowlist), [])


if __name__ == "__main__":
    unittest.main()
