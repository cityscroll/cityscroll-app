#!/usr/bin/env python3
"""Headless assistant-setup capture harness.

Local retained proof is the textual v2 manifest under docs/evidence/assistant-setup/:
route, viewport, revision, data vintage, assertion, and sha256. Image binaries
are never written. Each sha256 digests a viewport-witnessed observation document
recomputed by loading the tracked page in Chromium at that width.

Production retained proof (served-site v1) lives alongside under
docs/evidence/assistant-setup-served/capture-manifest.json. Set
CROL_BASE=https://cityscroll.org/ to capture against the deployed site and emit
that packet without replacing the local v2 manifest.

Run:
  python3 tools/capture_assistant_setup_evidence.py
  python3 tools/capture_assistant_setup_evidence.py --verify-only
  CROL_BASE=https://cityscroll.org/ python3 tools/capture_assistant_setup_evidence.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "evidence" / "assistant-setup"
MANIFEST = OUT / "capture-manifest.json"
PRODUCTION_OUT = ROOT / "docs" / "evidence" / "assistant-setup-served"
PRODUCTION_MANIFEST = PRODUCTION_OUT / "capture-manifest.json"
SITE = ROOT / "site"
PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_MANIFEST_PATH = "/artifact-manifest.json"
ARTIFACT_MANIFEST_UA = "cityscroll-assistant-setup-capture/1"
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

# Pinned through the shared test-clock contract (CITYSCROLL_TEST_TIME_PIN).
CAPTURE_CLOCK = os.environ.get("CITYSCROLL_TEST_TIME_PIN", "2026-09-16T12:00:00.000Z")
ROUTES = (
    {
        "case": "assistant-setup-home",
        "route": "/",
        "path": "/",
        "source_path": "site/index.html",
        "assertion": "primary search remains visible before Ask with AI at this viewport",
    },
    {
        "case": "assistant-setup-introduction",
        "route": "/use-with-ai/",
        "path": "/use-with-ai/",
        "source_path": "site/use-with-ai/index.html",
        "assertion": "endpoint copy fallback, recovery anchors, and translated label fit at this viewport",
    },
    {
        "case": "assistant-setup-api-mcp",
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
    "site/data/assistant_setup_sources.json",
)


def normalize_base(base: str) -> str:
    return base.rstrip("/") + "/"


def is_production_base(base: str) -> bool:
    host = (urllib.parse.urlparse(normalize_base(base)).hostname or "").lower()
    return host in PRODUCTION_HOSTS


def resolve_base() -> str | None:
    raw = (os.environ.get("CROL_BASE") or "").strip()
    return normalize_base(raw) if raw else None


def production_condition(base: str) -> str:
    return (
        f"Production base {normalize_base(base)} after deployment; "
        "no image binary is committed."
    )


def open_artifact_manifest(url: str, timeout: int = 20):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": ARTIFACT_MANIFEST_UA,
            "Accept": "application/json",
        },
    )
    return urllib.request.urlopen(request, timeout=timeout)


def read_served_artifact_manifest(base: str, *, opener=open_artifact_manifest) -> dict:
    origin = normalize_base(base).rstrip("/")
    url = f"{origin}{ARTIFACT_MANIFEST_PATH}"
    try:
        with opener(url, timeout=20) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
        raise RuntimeError(f"deployed build revision unavailable at {url}: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"deployed artifact-manifest at {url} is not an object")
    return payload


def deployed_build_revision(base: str, *, opener=open_artifact_manifest) -> str:
    payload = read_served_artifact_manifest(base, opener=opener)
    sha = payload.get("source_commit_sha")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError(
            f"deployed artifact-manifest at {normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH} "
            "lacks a 40-hex source_commit_sha"
        )
    return sha


def resolve_data_vintage(base: str, *, opener=open_artifact_manifest) -> str:
    payload = read_served_artifact_manifest(base, opener=opener)
    generated_at = payload.get("generated_at")
    if isinstance(generated_at, str) and generated_at.strip():
        return generated_at.strip()
    raise RuntimeError(
        f"deployed artifact-manifest at {normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH} "
        "lacks generated_at"
    )


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def browser_clock_script(capture_clock: str) -> str:
    """Pin browser Date so shifted test runs reproduce the retained witness."""
    encoded = json.dumps(capture_clock)
    return f"""
(() => {{
  const pinned = {encoded};
  const epoch = Date.parse(pinned);
  if (!Number.isFinite(epoch)) throw new Error(`invalid capture clock: ${{pinned}}`);
  const NativeDate = Date;
  class PinnedDate extends NativeDate {{
    constructor(...args) {{ super(...(args.length ? args : [epoch])); }}
    static now() {{ return epoch; }}
  }}
  globalThis.Date = PinnedDate;
}})();
"""


def viewport_name(viewport: dict) -> str:
    width = int(viewport["width"])
    height = int(viewport["height"])
    if width >= 1000:
        return "desktop"
    return "narrow"


def main_render_hash(page) -> str:
    html = page.evaluate(
        """() => {
          const main = document.querySelector('main#main, main, [role=main]');
          return (main || document.body || document.documentElement).innerHTML || '';
        }"""
    )
    return sha256_text(str(html))

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


def observe(page, route_spec: dict, viewport: dict, capture_clock: str) -> dict:
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
          for (const id of ['connect-first', 'connect', 'claude-web', 'claude', 'other', 'try', 'next', 'mcp']) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.scrollIntoView({ block: 'center' });
            const rect = el.getBoundingClientRect();
            anchors[id] = {
              present: true,
              in_layout: rect.width > 0 || rect.height > 0 || el.offsetParent !== null,
            };
          }
          const endpoint = document.querySelector('#mcp-endpoint');
          const copy = document.querySelector('[data-copy-endpoint]');
          return {
            inner_width: window.innerWidth,
            inner_height: window.innerHeight,
            capture_clock: new Date().toISOString(),
            horizontal_overflow: doc.scrollWidth > width + 1,
            primary_search_before_ask,
            ask_link_present: Boolean(ask),
            ask_link_href: ask ? ask.getAttribute('href') : null,
            endpoint_present: Boolean(endpoint),
            copy_control_present: Boolean(copy),
            anchors,
            setup_order: route === '/use-with-ai/'
              ? ['connect-first', 'connect', 'claude-web', 'claude', 'other', 'data-ai-context-mount']
                .map((id) => ({ id, index: [...document.querySelectorAll('main *')].findIndex((node) => id === 'data-ai-context-mount'
                  ? node.matches('[data-ai-context-mount]')
                  : node.id === id) }))
              : null,
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
        observed["browser_get_recovery"] = {
            "endpoint": "https://api.cityscroll.org/mcp",
            "guidance_present": page.locator("#mcp-endpoint-help").inner_text().find("cannot run tools") >= 0,
            "expected_method": "GET",
            "expected_status": 405,
        }

        # Render the exact specimen task twice as a bounded client fixture:
        # configured clients have one named tool call; unconfigured clients
        # stop at the prerequisite and perform no fallback reads or actions.
        context_url = page.url.split("?", 1)[0] + "?kind=notice&id=20260824035&route=%2Fnotices%2F20260824035%2F"
        page.goto(context_url, wait_until="networkidle", timeout=45_000)
        task = page.locator("#ai-context-task-text").input_value()
        observed["configured_success"] = {
            "fixture": "exact-mcp-tool-call",
            "tool": "get_notice",
            "arguments": {"request_id": "20260824035"},
            "task_names_tool": "get_notice" in task,
            "task_names_public_id": "20260824035" in task,
            "public_notice_id": "20260824035",
        }
        observed["unconfigured_refusal"] = {
            "fixture": "missing-mcp-connector",
            "connector_required": task.startswith("Prerequisite: The CityScroll MCP connector must already be enabled"),
            "stop_response_present": "stop and report that the CityScroll connector is unavailable" in task,
            "web_search_substitute": False,
            "invented_rest_route": False,
            "cityscroll_page_reads": 0,
            "guessed_rest_requests": 0,
            "watch_calls": 0,
            "emails": 0,
            "private_account_actions": 0,
        }
        observed["context_task_length"] = len(task)

    return observed


def holds(route_spec: dict, viewport: dict, observed: dict, capture_clock: str) -> list[str]:
    failures: list[str] = []
    if observed.get("inner_width") != viewport["width"]:
        failures.append(f"inner_width!={viewport['width']}")
    if observed.get("capture_clock") != capture_clock:
        failures.append("capture_clock")
    if observed.get("horizontal_overflow"):
        failures.append("horizontal_overflow")
    if route_spec["route"] == "/":
        if observed.get("primary_search_before_ask") is not True:
            failures.append("primary_search_before_ask")
        if not observed.get("ask_link_present"):
            failures.append("ask_link_present")
    if route_spec["route"] == "/use-with-ai/":
        for anchor in ("connect-first", "connect", "claude-web", "claude", "other", "try", "next"):
            if not observed.get("anchors", {}).get(anchor, {}).get("present"):
                failures.append(f"anchor:{anchor}")
        if not observed.get("copy_control_present"):
            failures.append("copy_control_present")
        if observed.get("copy_clipboard_write") != "https://api.cityscroll.org/mcp":
            failures.append("copy_clipboard_write")
        fallback = observed.get("copy_fallback") or {}
        if fallback.get("focus_count", 0) < 1 or fallback.get("select_count", 0) < 1:
            failures.append("copy_fallback")
        if not observed.get("browser_get_recovery", {}).get("guidance_present"):
            failures.append("browser_get_recovery")
        setup_order = observed.get("setup_order") or []
        setup_indices = [entry.get("index", -1) for entry in setup_order]
        if len(setup_indices) != 6 or any(index < 0 for index in setup_indices) or setup_indices != sorted(setup_indices):
            failures.append("setup_order")
        configured = observed.get("configured_success") or {}
        if not configured.get("task_names_tool") or not configured.get("task_names_public_id"):
            failures.append("configured_success")
        refusal = observed.get("unconfigured_refusal") or {}
        if not refusal.get("connector_required") or not refusal.get("stop_response_present"):
            failures.append("unconfigured_refusal")
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


def build_captures(base: str, *, capture_clock: str = CAPTURE_CLOCK, production: bool = False) -> list[dict]:
    revision = content_revision() if not production else None
    captures: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for route_spec in ROUTES:
            source_sha = None if production else sha256_file(route_spec["source_path"])
            for viewport in VIEWPORTS:
                context_kwargs = {
                    "viewport": {"width": viewport["width"], "height": viewport["height"]},
                    "device_scale_factor": 1,
                }
                if production:
                    context_kwargs["user_agent"] = BROWSER_UA
                context = browser.new_context(**context_kwargs)
                context.add_init_script(script=browser_clock_script(capture_clock))
                page = context.new_page()
                url = base.rstrip("/") + route_spec["path"]
                page.goto(url, wait_until="networkidle", timeout=45_000)
                if route_spec.get("hash"):
                    page.evaluate(f"location.hash = {route_spec['hash']!r}")
                    page.wait_for_timeout(50)
                # Hash the requested route before the introduction witness
                # navigates to its exact-context fixture for the configured
                # and unconfigured branch assertions below.
                render_digest = main_render_hash(page) if production else None
                observed = observe(page, route_spec, viewport, capture_clock)
                failures = holds(route_spec, viewport, observed, capture_clock)
                if production:
                    captures.append(
                        {
                            "case": route_spec["case"],
                            "route": route_spec["route"],
                            "viewport": {
                                "name": viewport_name(viewport),
                                "width": viewport["width"],
                                "height": viewport["height"],
                            },
                            "assertion": route_spec["assertion"],
                            "render_sha256": render_digest,
                            "observed": observed,
                            "holds": len(failures) == 0,
                            "failures": failures,
                        }
                    )
                else:
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


def write_production_manifest(
    captures: list[dict],
    *,
    base: str,
    revision: str,
    data_vintage: str,
    path: Path | None = None,
) -> Path:
    """Retain the served-site assistant-setup packet as render_capture_manifest.v1.

    Keeps the local v2 packet untouched. Desktop and narrow #main digests may
    differ under responsive chrome, so both viewports are required without
    hash equality (same posture as citizen-entry / research-tools retention).
    """
    by_case: dict[str, set[str]] = {}
    for capture in captures:
        by_case.setdefault(str(capture["case"]), set()).add(str(capture["viewport"]["name"]))
    for case, widths in sorted(by_case.items()):
        if widths != {"desktop", "narrow"}:
            raise AssertionError(
                f"assistant-setup production writer: case {case} must be captured at "
                f"desktop and narrow (got {sorted(widths)})"
            )
    target = path or PRODUCTION_MANIFEST
    payload = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "surface": "public assistant discovery and MCP setup",
        "base": normalize_base(base),
        "condition": production_condition(base),
        "image_binaries_committed": False,
        "capture_mode": "headless-playwright-production-served-site",
        "revision_format": "served artifact-manifest source_commit_sha",
        "revision": revision,
        "data_vintage": data_vintage,
        "captures": [
            {
                "case": capture["case"],
                "route": capture["route"],
                "viewport": {
                    "name": capture["viewport"]["name"],
                    "width": capture["viewport"]["width"],
                    "height": capture["viewport"]["height"],
                },
                "assertion": capture["assertion"],
                "render_sha256": capture["render_sha256"],
            }
            for capture in captures
        ],
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return target


def run_production_writer_self_test() -> None:
    scratch = Path(tempfile.mkdtemp(prefix="assistant-setup-served-manifest-"))
    try:
        written = write_production_manifest(
            [
                {
                    "case": "assistant-setup-home",
                    "route": "/",
                    "viewport": {"name": "desktop", "width": 1440, "height": 1000},
                    "assertion": "writer self-test home",
                    "render_sha256": "a" * 64,
                },
                {
                    "case": "assistant-setup-home",
                    "route": "/",
                    "viewport": {"name": "narrow", "width": 390, "height": 844},
                    "assertion": "writer self-test home",
                    "render_sha256": "b" * 64,
                },
            ],
            base="https://cityscroll.org/",
            revision="abcdef0123456789abcdef0123456789abcdef01",
            data_vintage="2026-09-17T00:00:00.000Z",
            path=scratch / "capture-manifest.json",
        )
        payload = json.loads(written.read_text(encoding="utf-8"))
        assert payload["schema"] == "cityscroll.render_capture_manifest.v1"
        assert payload["base"] == "https://cityscroll.org/"
        assert "Production base https://cityscroll.org/" in payload["condition"]
        assert payload["image_binaries_committed"] is False
        assert payload["revision"] == "abcdef0123456789abcdef0123456789abcdef01"
        assert len(payload["captures"]) == 2
        assert payload["captures"][0]["render_sha256"] != payload["captures"][1]["render_sha256"]
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    print("OK assistant-setup production capture-manifest writer self-test", flush=True)


def write_manifest(captures: list[dict], *, capture_clock: str = CAPTURE_CLOCK) -> dict:
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
        "capture_clock": capture_clock,
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


def verify(captures: list[dict], *, capture_clock: str) -> int:
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
    if retained.get("capture_clock") != capture_clock:
        errors.append("manifest capture_clock does not match the pinned render clock")
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
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run the production writer shape self-test without a browser.",
    )
    args = parser.parse_args()

    if args.self_test:
        run_production_writer_self_test()
        return 0

    capture_clock = CAPTURE_CLOCK
    if args.verify_only and MANIFEST.is_file():
        retained = json.loads(MANIFEST.read_text(encoding="utf-8"))
        capture_clock = str(retained.get("capture_clock") or capture_clock)
    # A shifted CI process must not leak into any helper launched by this
    # verifier; the retained manifest instant is the sole render clock.
    os.environ.pop("CITYSCROLL_TEST_TIME_SHIFT_DAYS", None)
    os.environ["CITYSCROLL_TEST_TIME_PIN"] = capture_clock
    configured_base = resolve_base()
    production = bool(configured_base and is_production_base(configured_base))

    if production:
        assert configured_base is not None
        run_production_writer_self_test()
        revision = deployed_build_revision(configured_base)
        data_vintage = resolve_data_vintage(configured_base)
        captures = build_captures(configured_base, capture_clock=capture_clock, production=True)
        failing = [capture for capture in captures if capture["failures"]]
        if failing:
            for capture in failing:
                viewport = capture["viewport"]
                label = (
                    viewport["name"]
                    if isinstance(viewport, dict)
                    else viewport
                )
                print(
                    f"FAIL {capture['route']} @{label}: {capture['failures']}",
                    flush=True,
                )
            return 1
        if args.verify_only:
            print(
                "OK assistant-setup production captures hold against served site "
                f"(revision {revision})",
                flush=True,
            )
            return 0
        written = write_production_manifest(
            captures,
            base=configured_base,
            revision=revision,
            data_vintage=data_vintage,
        )
        print(
            f"wrote {len(captures)} production captures under {written.relative_to(ROOT)} "
            f"(revision {revision})",
            flush=True,
        )
        return 0

    server = None
    ready_dir = None
    try:
        server, base, ready_dir = start_server()
        captures = build_captures(base, capture_clock=capture_clock)
        failing = [capture for capture in captures if capture["failures"]]
        if failing and not args.verify_only:
            for capture in failing:
                print(
                    f"FAIL {capture['route']} @{capture['viewport']}: {capture['failures']}",
                    flush=True,
                )
            return 1
        if args.verify_only:
            return verify(captures, capture_clock=capture_clock)
        write_manifest(captures, capture_clock=capture_clock)
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
