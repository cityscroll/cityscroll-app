#!/usr/bin/env python3
"""Capture and verify durable six-lens Browse interaction-grammar evidence."""

from __future__ import annotations

import argparse
import json
import pathlib
import struct
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright


ROOT = pathlib.Path(__file__).resolve().parents[1]
ASSETS = ROOT / "test" / "functional" / "assets"
OUT = ROOT / "docs" / "screenshots" / "browse-interaction-grammar"
RECEIPT = OUT / "capture-receipt.json"
VIEWPORTS = ((390, 844), (1440, 1000))
SCHEMA = "cityscroll.browse-interaction-grammar-capture.v1"
sys.path.insert(0, str(ASSETS))

from browse_interaction_grammar import LENSES, assert_lens_grammar, open_lens  # noqa: E402


def wait_for_ready(path: pathlib.Path, process: subprocess.Popen[str]) -> str:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if path.exists() and path.read_text(encoding="utf-8").strip():
            return path.read_text(encoding="utf-8").strip()
        if process.poll() is not None:
            output = process.stdout.read() if process.stdout else ""
            raise RuntimeError(f"local site server exited early: {output}")
        time.sleep(0.05)
    raise TimeoutError("local site server did not publish a ready URL")


def png_size(path: pathlib.Path) -> tuple[int, int]:
    header = path.read_bytes()[:24]
    if len(header) != 24 or not header.startswith(b"\x89PNG\r\n\x1a\n"):
        raise AssertionError(f"not a readable PNG: {path.relative_to(ROOT)}")
    return struct.unpack(">II", header[16:24])


def expected_capture_keys() -> set[tuple[str, int, int]]:
    return {
        (lens.slug, width, height)
        for lens in LENSES
        for width, height in VIEWPORTS
    }


def verify_receipt() -> None:
    assert RECEIPT.is_file(), f"missing screenshot receipt: {RECEIPT.relative_to(ROOT)}"
    payload = json.loads(RECEIPT.read_text(encoding="utf-8"))
    assert payload.get("schema") == SCHEMA, "unexpected screenshot receipt schema"
    captures = payload.get("captures")
    assert isinstance(captures, list), "screenshot receipt captures must be a list"
    actual = {
        (row.get("lens"), row.get("viewport", {}).get("width"), row.get("viewport", {}).get("height"))
        for row in captures
    }
    assert actual == expected_capture_keys(), (
        f"screenshot matrix drifted: expected {sorted(expected_capture_keys())}, got {sorted(actual)}"
    )
    for row in captures:
        relative = row.get("file")
        assert isinstance(relative, str) and relative.startswith("docs/screenshots/browse-interaction-grammar/"), (
            f"capture path is not repository-relative: {relative!r}"
        )
        path = ROOT / relative
        assert path.is_file(), f"missing screenshot: {relative}"
        size = png_size(path)
        expected_size = (row.get("pixel_size", {}).get("width"), row.get("pixel_size", {}).get("height"))
        assert size == expected_size, f"{relative}: PNG size {size} differs from receipt {expected_size}"
    print(f"Browse interaction screenshot receipt OK: {len(captures)} captures")


def capture() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    captures: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="crol-browse-interaction-") as temp:
        ready = pathlib.Path(temp) / "ready.txt"
        process = subprocess.Popen(
            [
                "python3",
                str(ROOT / "tools" / "local_site_server.py"),
                "--directory",
                str(ROOT / "site"),
                "--port",
                "0",
                "--ready-file",
                str(ready),
            ],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            base = wait_for_ready(ready, process)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                for lens in LENSES:
                    for width, height in VIEWPORTS:
                        context = browser.new_context(
                            viewport={"width": width, "height": height},
                            device_scale_factor=1,
                            permissions=["clipboard-read", "clipboard-write"],
                        )
                        page = context.new_page()
                        open_lens(page, base, lens)
                        semantic = assert_lens_grammar(page, lens, verify_clipboard=False)
                        target = page.locator(lens.capture_selector).first
                        target.scroll_into_view_if_needed()
                        page.wait_for_timeout(100)
                        filename = f"{lens.slug}-{width}.png"
                        path = OUT / filename
                        target.screenshot(path=str(path), animations="disabled")
                        pixel_width, pixel_height = png_size(path)
                        captures.append({
                            **semantic,
                            "viewport": {"width": width, "height": height},
                            "pixel_size": {"width": pixel_width, "height": pixel_height},
                            "file": str(path.relative_to(ROOT)),
                            "phase": "hydrated",
                            "selector": lens.capture_selector,
                        })
                        print(f"captured {filename}", flush=True)
                        context.close()
                browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)

    payload = {
        "schema": SCHEMA,
        "source": "Hermetic local browser fixtures",
        "assertions": [
            "canonical internal title with leading diamond",
            "always-visible Copy link matching the title target",
            "visible arrow on off-site handoffs",
            "context-qualified action rails",
            "WCAG AA text contrast for card buttons",
        ],
        "captures": captures,
    }
    RECEIPT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    verify_receipt()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="verify the committed screenshot matrix and receipt without opening a browser",
    )
    args = parser.parse_args()
    if args.verify_only:
        verify_receipt()
    else:
        capture()


if __name__ == "__main__":
    main()
