#!/usr/bin/env python3
"""Headless assistant-setup capture harness.

Retained proof is the textual manifest under docs/evidence/assistant-setup/:
route, viewport, revision, data vintage, assertion, and sha256. Image binaries
are never written. Each sha256 digests a viewport-witnessed observation document
recomputed by loading the tracked page in Chromium at that width.

Run:
  python3 tools/capture_assistant_setup_evidence.py
  python3 tools/capture_assistant_setup_evidence.py --verify-only
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "evidence" / "assistant-setup"
MANIFEST = OUT / "capture-manifest.json"
SITE = ROOT / "site"

# Pinned through the shared test-clock contract (CITYSCROLL_TEST_TIME_PIN).
CAPTURE_CLOCK = os.environ.get("CITYSCROLL_TEST_TIME_PIN", "2026-09-16T12:00:00.000Z")

ROUTES = (
    {
        "route": "/",
        "path": "/",
        "source_path": "site/index.html",
        "assertion": "primary search remains visible before Ask with AI at this viewport",
    },
    {
        "route": "/use-with-ai/",
        "path": "/use-with-ai/",
        "source_path": "site/use-with-ai/index.html",
        "assertion": "endpoint copy fallback, recovery anchors, and translated label fit at this viewport",
    },
    {
        "route": "/api.html#mcp",
        "path": "/api.html",
        "hash": "#mcp",
        "source_path": "site/api.html",
        "assertion": "stable MCP heading and setup link remain reachable at this viewport",
    },
)

VIEWPORTS = (
    {"viewport": "1440x1000", "width": 1440, "height": 1000},
    {"viewport": "390x844", "width": 390, "height": 844},
)

SOURCE_PATHS = (
    "site/index.html",
    "site/use-with-ai/index.html",
    "site/api.html",
    "site/ai_discovery.mjs",
)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(relative: str) -> str:
    return hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()


def content_revision() -> str:
    """Self-maintaining revision tied to the tracked setup sources."""
    lines = [f"{path}:{sha256_file(path)}" for path in SOURCE_PATHS]
    return sha256_text("\n".join(lines) + "\n")


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def witness_digest(witness: dict) -> str:
    return sha256_text(canonical_json(witness))


def start_server() -> tuple[subprocess.Popen, str, Path]:
    ready_dir = Path(tempfile.mkdtemp(prefix="assistant-setup-capture-"))
    ready = ready_dir / "ready.txt"
    server = subprocess.Popen(
        [
            "python3",
            str(ROOT / "tools" / "local_site_server.py"),
            "--directory",
            str(SITE),
            "--port",
            "0",
            "--ready-file",
            str(ready),
        ],
        cwd=str(ROOT),
    )
    for _ in range(200):
        if ready.exists() and ready.read_text(encoding="utf-8").strip():
            return server, ready.read_text(encoding="utf-8").strip(), ready_dir
        time.sleep(0.05)
    server.terminate()
    shutil.rmtree(ready_dir, ignore_errors=True)
    raise RuntimeError("local site server did not become ready")


def observe(page, route_spec: dict, viewport: dict) -> dict:
    width = viewport["width"]
    height = viewport["height"]
    observed: dict = page.evaluate(
        """({ width, height, route }) => {
          const doc = document.documentElement;
          const ask = [...document.querySelectorAll('a[href*="use-with-ai"]')]
            .find((node) => /ask with ai|preguntar con ia/i.test(node.textContent || '') || node.getAttribute('aria-current') === 'page');
          let primary_search_before_ask = null;
          if (route === '/') {
            const html = document.documentElement.outerHTML;
            const searchPos = html.indexOf('home-topic-form');
            const askPos = html.indexOf('Ask with AI');
            primary_search_before_ask = searchPos >= 0 && askPos >= 0 && searchPos < askPos;
          }
          const anchors = {};
          for (const id of ['connect', 'claude', 'other', 'try', 'next', 'mcp']) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.scrollIntoView({ block: 'center' });
            const rect = el.getBoundingClientRect();
            anchors[id] = {
              present: true,
              top: Math.round(rect.top),
              width: Math.round(rect.width),
              in_layout: rect.width > 0 || rect.height > 0 || el.offsetParent !== null,
            };
          }
          const endpoint = document.querySelector('#mcp-endpoint');
          const copy = document.querySelector('[data-copy-endpoint]');
          return {
            inner_width: window.innerWidth,
            inner_height: window.innerHeight,
            horizontal_overflow: doc.scrollWidth > width + 1,
            primary_search_before_ask,
            ask_link_present: Boolean(ask),
            ask_link_href: ask ? ask.getAttribute('href') : null,
            endpoint_present: Boolean(endpoint),
            copy_control_present: Boolean(copy),
            anchors,
            endpoint_client_width: endpoint ? Math.round(endpoint.getBoundingClientRect().width) : null,
          };
        }""",
        {"width": width, "height": height, "route": route_spec["route"]},
    )

    # Translated-label layout: substitute a longer supported-language label and
    # require it to remain visible without introducing page overflow.
    translated = page.evaluate(
        """() => {
          const targets = [...document.querySelectorAll('a[href*="use-with-ai"], a.ask-with-ai-link')];
          let replaced = 0;
          for (const node of targets) {
            if (/Ask with AI|Preguntar con IA/i.test(node.textContent || '') || node.getAttribute('aria-current') === 'page') {
              node.textContent = 'Preguntar con IA';
              replaced += 1;
            }
          }
          const label = [...document.querySelectorAll('a[href*="use-with-ai"], a.ask-with-ai-link')]
            .some((node) => (node.textContent || '').includes('Preguntar con IA'));
          const doc = document.documentElement;
          return {
            replaced,
            translated_label_visible: label,
            translated_horizontal_overflow: doc.scrollWidth > window.innerWidth + 1,
          };
        }"""
    )
    observed["translated"] = translated

    if route_spec["route"] == "/use-with-ai/":
        # Exercise clipboard success, then the focus+select fallback.
        copied = {"value": None}
        page.evaluate(
            """() => {
              window.__assistantCopyWrites = [];
              Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: {
                  writeText: async (text) => { window.__assistantCopyWrites.push(text); },
                },
              });
            }"""
        )
        page.click("[data-copy-endpoint]")
        page.wait_for_timeout(50)
        writes = page.evaluate("() => window.__assistantCopyWrites || []")
        observed["copy_clipboard_write"] = writes[0] if writes else None

        page.evaluate(
            """() => {
              window.__assistantSelectCount = 0;
              window.__assistantFocusCount = 0;
              const input = document.querySelector('#mcp-endpoint');
              const focus = input.focus.bind(input);
              const select = input.select.bind(input);
              input.focus = (...args) => { window.__assistantFocusCount += 1; return focus(...args); };
              input.select = (...args) => { window.__assistantSelectCount += 1; return select(...args); };
              Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                get() { return undefined; },
              });
            }"""
        )
        page.click("[data-copy-endpoint]")
        page.wait_for_timeout(50)
        fallback = page.evaluate(
            """() => ({
              focus_count: window.__assistantFocusCount || 0,
              select_count: window.__assistantSelectCount || 0,
              active_is_endpoint: document.activeElement && document.activeElement.id === 'mcp-endpoint',
            })"""
        )
        observed["copy_fallback"] = fallback

    return observed


def holds(route_spec: dict, viewport: dict, observed: dict) -> list[str]:
    failures: list[str] = []
    if observed.get("inner_width") != viewport["width"]:
        failures.append(f"inner_width!={viewport['width']}")
    if observed.get("horizontal_overflow"):
        failures.append("horizontal_overflow")
    if route_spec["route"] == "/":
        if observed.get("primary_search_before_ask") is not True:
            failures.append("primary_search_before_ask")
        if not observed.get("ask_link_present"):
            failures.append("ask_link_present")
    if route_spec["route"] == "/use-with-ai/":
        for anchor in ("connect", "claude", "other", "try", "next"):
            if not observed.get("anchors", {}).get(anchor, {}).get("present"):
                failures.append(f"anchor:{anchor}")
        if not observed.get("copy_control_present"):
            failures.append("copy_control_present")
        if observed.get("copy_clipboard_write") != "https://api.cityscroll.org/mcp":
            failures.append("copy_clipboard_write")
        fallback = observed.get("copy_fallback") or {}
        if fallback.get("focus_count", 0) < 1 or fallback.get("select_count", 0) < 1:
            failures.append("copy_fallback")
    if route_spec["route"] == "/api.html#mcp":
        if not observed.get("anchors", {}).get("mcp", {}).get("present"):
            failures.append("anchor:mcp")
        if not observed.get("ask_link_present"):
            failures.append("ask_link_present")
    translated = observed.get("translated") or {}
    if not translated.get("translated_label_visible"):
        failures.append("translated_label_visible")
    if translated.get("translated_horizontal_overflow"):
        failures.append("translated_horizontal_overflow")
    return failures


def build_captures(base: str) -> list[dict]:
    revision = content_revision()
    captures: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for route_spec in ROUTES:
            source_sha = sha256_file(route_spec["source_path"])
            for viewport in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": viewport["width"], "height": viewport["height"]},
                    device_scale_factor=1,
                )
                page = context.new_page()
                url = base.rstrip("/") + route_spec["path"]
                page.goto(url, wait_until="networkidle", timeout=45_000)
                if route_spec.get("hash"):
                    page.evaluate(f"location.hash = {route_spec['hash']!r}")
                    page.wait_for_timeout(50)
                observed = observe(page, route_spec, viewport)
                failures = holds(route_spec, viewport, observed)
                witness = {
                    "route": route_spec["route"],
                    "viewport": viewport["viewport"],
                    "viewport_width": viewport["width"],
                    "viewport_height": viewport["height"],
                    "source_path": route_spec["source_path"],
                    "source_sha256": source_sha,
                    "observed": observed,
                }
                digest = witness_digest(witness)
                captures.append(
                    {
                        "route": route_spec["route"],
                        "viewport": viewport["viewport"],
                        "viewport_width": viewport["width"],
                        "viewport_height": viewport["height"],
                        "revision": revision,
                        "data_vintage": "tracked site HTML at content revision",
                        "assertion": route_spec["assertion"],
                        "sha256": digest,
                        "source_path": route_spec["source_path"],
                        "source_sha256": source_sha,
                        "observed": observed,
                        "holds": len(failures) == 0,
                        "failures": failures,
                    }
                )
                page.close()
                context.close()
        browser.close()
    return captures


def write_manifest(captures: list[dict]) -> dict:
    revision = content_revision()
    manifest = {
        "schema": "cityscroll.assistant_setup_capture_manifest.v2",
        "surface": "public assistant discovery and MCP setup",
        "condition": "Chromium viewport witnesses over tracked HTML; no image binary is committed.",
        "image_binaries_committed": False,
        "capture_mode": "headless-playwright-loopback-static-render",
        "revision": revision,
        "revision_format": "sha256 of path:source-digest lines for setup sources",
        "data_vintage": "tracked site HTML at content revision",
        "capture_clock": CAPTURE_CLOCK,
        "capture_policy": "Textual viewport witnesses only; no image binaries are committed.",
        "runner": "python3 tools/capture_assistant_setup_evidence.py",
        "unit_gate": "node --test test/capability_discovery.test.mjs test/mcp_connection_introduction.test.mjs",
        "source_paths": list(SOURCE_PATHS),
        "captures": [
            {
                "route": capture["route"],
                "viewport": capture["viewport"],
                "viewport_width": capture["viewport_width"],
                "viewport_height": capture["viewport_height"],
                "revision": capture["revision"],
                "data_vintage": capture["data_vintage"],
                "assertion": capture["assertion"],
                "sha256": capture["sha256"],
                "source_path": capture["source_path"],
                "source_sha256": capture["source_sha256"],
                "observed": capture["observed"],
            }
            for capture in captures
        ],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def verify(captures: list[dict]) -> int:
    if not MANIFEST.is_file():
        print("FAIL missing retained manifest", flush=True)
        return 1
    retained = json.loads(MANIFEST.read_text(encoding="utf-8"))
    expected_revision = content_revision()
    errors: list[str] = []
    if retained.get("revision") != expected_revision:
        errors.append("manifest revision does not match tracked setup sources")
    if retained.get("schema") != "cityscroll.assistant_setup_capture_manifest.v2":
        errors.append("unexpected schema")
    if retained.get("image_binaries_committed") is not False:
        errors.append("image_binaries_committed")
    if len(retained.get("captures") or []) != 6:
        errors.append("expected six captures")

    by_key = {
        (capture["route"], capture["viewport"]): capture
        for capture in retained.get("captures") or []
    }
    for capture in captures:
        key = (capture["route"], capture["viewport"])
        retained_capture = by_key.get(key)
        if retained_capture is None:
            errors.append(f"missing retained capture {key}")
            continue
        if retained_capture.get("sha256") != capture["sha256"]:
            errors.append(f"sha256 drift {key}")
        if retained_capture.get("revision") != expected_revision:
            errors.append(f"capture revision drift {key}")
        if retained_capture.get("source_sha256") != capture["source_sha256"]:
            errors.append(f"source_sha256 drift {key}")
        if capture["failures"]:
            errors.append(f"observation failures {key}: {capture['failures']}")

    # Desktop and mobile witnesses for the same route must differ.
    for route in {capture["route"] for capture in captures}:
        digests = {
            capture["sha256"]
            for capture in captures
            if capture["route"] == route
        }
        if len(digests) < 2:
            errors.append(f"viewport hashes did not diverge for {route}")

    if errors:
        for error in errors:
            print(f"FAIL {error}", flush=True)
        return 1
    print("OK assistant-setup capture manifest verifies at both viewports", flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    os.environ.setdefault("CITYSCROLL_TEST_TIME_PIN", CAPTURE_CLOCK)
    server = None
    ready_dir = None
    try:
        server, base, ready_dir = start_server()
        captures = build_captures(base)
        failing = [capture for capture in captures if capture["failures"]]
        if failing and not args.verify_only:
            for capture in failing:
                print(
                    f"FAIL {capture['route']} @{capture['viewport']}: {capture['failures']}",
                    flush=True,
                )
            return 1
        if args.verify_only:
            return verify(captures)
        write_manifest(captures)
        print(f"wrote {len(captures)} captures under {OUT.relative_to(ROOT)}", flush=True)
        return 0 if not failing else 1
    finally:
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
        if ready_dir is not None:
            shutil.rmtree(ready_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
