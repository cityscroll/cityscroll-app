"""Product regression: an early #langSelect pick must survive boot.mjs finishing.

`i18n.js` restores the saved language and flips `html[lang]` while parsing `<head>`, but on
index.html's hash-route topic SPA the `#langSelect` change handler used to bind only once
`app/boot.mjs` -- the last module `app/main.mjs` imports -- finished running. A selection made
in the gap between the control existing and that import completing hit no listener, and boot
then reset the control back to the saved language, silently dropping the resident's pick
(observed resetting to `es`). `test/functional/12_language.py` (PR #2431) fixed the flaky
*check* that this race exposed by waiting for the application's `data-app-ready` boot barrier
before driving the switcher after a reload; it left the product race itself in place. This test
targets the product behavior directly, using the same slow-boot technique that PR's own
validation used: an artificial delay before `import("./boot.mjs")` widens the gap so an
early selection deterministically lands inside it instead of depending on runner speed.

Serves a scratch clone of the already-built `_site` artifact (never the tracked `site/`
source) with that delay injected into the clone's own `app/main.mjs`, so no tracked file is
touched and the clone is removed when the test exits.
"""

from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from ci_waits import wait_for_app_ready, wait_for_locator  # noqa: E402

SOURCE_SITE = pathlib.Path(os.environ.get("CROL_PAGES_SITE_DIR", str(ROOT / "_site")))
BOOT_DELAY_MS = 1500
IMPORT_MARKER = 'await import("./boot.mjs");'
DELAYED_IMPORT = (
    "await new Promise(function(resolve){ setTimeout(resolve, "
    + str(BOOT_DELAY_MS)
    + "); });\n"
    + IMPORT_MARKER
)


def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def build_slow_boot_clone(destination: pathlib.Path) -> None:
    """Clone the built site and delay its boot.mjs import, editing only the clone."""
    if not (SOURCE_SITE / "index.html").is_file():
        raise AssertionError(
            f"built site missing at {SOURCE_SITE}; run tools/prepare_functional_site.sh"
        )
    clone = destination / "site"
    shutil.copytree(SOURCE_SITE, clone)
    main_mjs = clone / "app" / "main.mjs"
    original = main_mjs.read_text(encoding="utf-8")
    occurrences = original.count(IMPORT_MARKER)
    if occurrences != 1:
        raise AssertionError(
            f"expected exactly one {IMPORT_MARKER!r} in {main_mjs}, found {occurrences}"
        )
    main_mjs.write_text(original.replace(IMPORT_MARKER, DELAYED_IMPORT), encoding="utf-8")
    return clone


def serve(directory: pathlib.Path, ready_file: pathlib.Path) -> subprocess.Popen:
    process = subprocess.Popen(
        [
            sys.executable,
            "tools/local_site_server.py",
            "--directory",
            str(directory),
            "--port",
            "0",
            "--ready-file",
            str(ready_file),
        ],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if ready_file.is_file() and ready_file.stat().st_size:
            return process
        if process.poll() is not None:
            error = process.stderr.read() if process.stderr else ""
            raise AssertionError(f"local site server exited early: {error}")
        time.sleep(0.1)
    process.terminate()
    raise AssertionError("timed out waiting for the local site server")


def stop(process: subprocess.Popen) -> None:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="crol-slow-boot-") as scratch:
        scratch_path = pathlib.Path(scratch)
        clone = build_slow_boot_clone(scratch_path)
        step("OK", "slow-boot clone built", f"boot.mjs import delayed {BOOT_DELAY_MS}ms")
        ready_file = scratch_path / "ready"
        server = serve(clone, ready_file)
        try:
            base = ready_file.read_text(encoding="utf-8").strip().rstrip("/") + "/"
            # `index.html`/`/` forward registered lens hashes like `#money` through a
            # legacy-URL migration before the topic SPA ever loads (site/legacy_hash_forward.mjs,
            # site/route_migration.mjs LEGACY_LENS_ROUTES) -- that redirect would land on a
            # static browse document instead of the boot.mjs-driven application this test
            # targets. `app/index.html` is the same document published at the canonical SPA
            # directory (tools/build_public_site.mjs) and bypasses that forward.
            spa_entry = base + "app/index.html"

            with sync_playwright() as pw:
                browser = pw.chromium.launch()
                page = browser.new_context().new_page()
                page.goto(spa_entry + "#money", timeout=30000, wait_until="commit")
                wait_for_locator(page.locator("#langSelect"), label="language selector")

                # Confirm the artificial delay actually widened the gap this test targets --
                # otherwise a passing assertion below would prove nothing about the race.
                app_ready = page.evaluate("document.body?.dataset.appReady")
                assert app_ready != "true", (
                    "boot.mjs already completed by the time #langSelect existed; the "
                    f"{BOOT_DELAY_MS}ms delay before its import did not take effect"
                )
                step("OK", "select exists before boot completes", "data-app-ready not yet set")

                assert page.locator("#langSelect").input_value() == "en", (
                    "English should be selected by default before any pick"
                )
                page.select_option("#langSelect", "fr")
                step("OK", "early selection made", "fr, before boot.mjs bound any listener")

                wait_for_app_ready(page)
                step("OK", "boot completed")

                selected = page.locator("#langSelect").input_value()
                doc_lang = page.evaluate("document.documentElement.lang")
                assert selected == "fr", (
                    f"the pre-boot selection must stick: expected 'fr', control now shows {selected!r} "
                    "(boot.mjs reset it to the restored/default language)"
                )
                assert doc_lang == "fr", (
                    f"document language must follow the pre-boot selection: expected 'fr', got {doc_lang!r}"
                )
                step("OK", "early selection survived boot", f"lang={doc_lang}")
                browser.close()
        finally:
            stop(server)

    step("OK", "58_language_switcher_early_selection", "complete")


if __name__ == "__main__":
    main()
