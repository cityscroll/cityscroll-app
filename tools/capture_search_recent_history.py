#!/usr/bin/env python3
"""Capture before/after evidence for browser-local recent searches on /search/.

Three reader states at both reader sizes, against the same fixture responses:

  empty                 the bare Search document with nothing remembered
  populated             back on /search/ after searching `rats` and then `CB3`
  storage-unavailable   a results page whose browser refuses local storage

"before" is the served Search document at the base revision, where the feature
does not exist; "after" is this working tree. The pair proves what the change
adds (a compact recent list under the search action), and that everything above
it — the search action itself — and every state where history cannot exist are
unchanged.

Deterministic: the search API is stubbed from the same fixtures the browser gate
uses, third-party chrome is blocked, and animations are disabled.
"""

from __future__ import annotations

import argparse
from io import BytesIO
import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile

from playwright.sync_api import Browser, Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "screenshots" / "search-recent-history"
BASE_REV = "origin/main"
VIEWPORTS = ((1440, 1000), (390, 844))
BLOCK_STORAGE = (
    "Object.defineProperty(window, 'localStorage', "
    "{ configurable: true, get() { throw new Error('SecurityError'); } });"
)


def load_browser_gate():
    """Reuse the browser gate's fixtures so evidence and gate cannot disagree."""
    path = ROOT / "test" / "functional" / "42_search_recent_history.py"
    source = path.read_text(encoding="utf-8").replace("\nmain()\n", "\n")
    spec = importlib.util.spec_from_loader("search_recent_history_gate", loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__dict__["__file__"] = str(path)
    exec(compile(source, str(path), "exec"), module.__dict__)  # noqa: S102
    return module


def load_static_server():
    path = ROOT / "test" / "performance" / "verify.py"
    spec = importlib.util.spec_from_file_location("performance_verify", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load the static-server helper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.StaticServer


def build_public_site(source_dir: Path, site_dir: Path) -> Path:
    """Serve what Pages serves: the site tree plus its client capability modules."""
    subprocess.check_call(
        ["node", "tools/build_public_site.mjs",
         "--source-dir", str(source_dir), "--site-dir", str(site_dir)],
        cwd=ROOT,
    )
    return site_dir


def base_site(destination: Path, revision: str) -> Path:
    """Materialize the served surface at the base revision and build it the same way."""
    source = destination / "source"
    archive = subprocess.check_output(["git", "archive", revision, "site", "capabilities"], cwd=ROOT)
    with tarfile.open(fileobj=BytesIO(archive)) as bundle:
        bundle.extractall(source, filter="data")
    return build_public_site(source, destination / "built")


def revision_of(revision: str) -> str:
    return subprocess.check_output(["git", "rev-parse", revision], cwd=ROOT, text=True).strip()


def settle(page: Page, base_url: str, path: str, gate) -> None:
    page.goto(f"{base_url.rstrip('/')}{path}", wait_until="domcontentloaded", timeout=30000)
    if "q=" in path:
        page.wait_for_selector('[data-search-coverage][aria-busy="false"]', timeout=30000)
    page.wait_for_timeout(600)


def shoot(page: Page, output: Path) -> None:
    page.screenshot(path=output, animations="disabled", full_page=True)


def capture_state(browser: Browser, base_url: str, gate, out: Path, state: str, side: str) -> None:
    for width, height in VIEWPORTS:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        gate.install_search_api(page)
        page.route(gate.INTAKE, gate.accepting_intake())
        if state == "storage-unavailable":
            page.add_init_script(BLOCK_STORAGE)
            settle(page, base_url, "/search/?q=rats", gate)
        elif state == "populated":
            settle(page, base_url, "/search/?q=rats", gate)
            settle(page, base_url, "/search/?q=CB3", gate)
            settle(page, base_url, "/search/", gate)
        else:
            settle(page, base_url, "/search/", gate)
        shoot(page, out / f"{side}-{state}-{width}.png")
        context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--base-rev", default=BASE_REV)
    args = parser.parse_args()

    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    gate = load_browser_gate()
    StaticServer = load_static_server()
    base_rev = args.base_rev
    try:
        base_revision = revision_of(base_rev)
    except subprocess.CalledProcessError:
        base_rev = "HEAD"
        base_revision = revision_of(base_rev)

    states = ("empty", "populated", "storage-unavailable")
    with tempfile.TemporaryDirectory(prefix="search-recent-history-capture-") as tmp:
        sides = (
            ("before", base_site(Path(tmp) / "base", base_rev)),
            ("after", build_public_site(ROOT, Path(tmp) / "after")),
        )
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for side, site in sides:
                with StaticServer(site) as base_url:
                    for state in states:
                        capture_state(browser, base_url, gate, out, state, side)
            browser.close()

    receipt = {
        "schema": "cityscroll.capture_receipt.v1",
        "surface": "browser-local recent searches on the canonical Search document",
        "route": "/search/",
        "base_revision": base_revision,
        # The "before" side is a named revision; the "after" side is this change's
        # working tree, which cannot name its own commit without changing it. The
        # baseline is what a reviewer needs to reproduce the comparison.
        "after_side": "working tree of this change",
        "captured_at_head": revision_of("HEAD"),
        "viewports": [width for width, _height in VIEWPORTS],
        "fixture": "test/functional/42_search_recent_history.py",
        "states": {
            "empty": (
                "The bare Search document with nothing remembered. Before and after are the "
                "same page: an empty history is quiet and adds no heading, control, or space."
            ),
            "populated": (
                "Back on /search/ after searching rats and then CB3. After adds one compact "
                "list under the unchanged search action, newest first, each entry a link to "
                "its canonical Search URL with its own remove control."
            ),
            "storage-unavailable": (
                "A rats results page whose browser refuses local storage. Before and after "
                "are the same page: no history renders and the results, coverage receipt and "
                "search action are untouched."
            ),
        },
    }
    (out / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"Captured recent-search evidence under {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
