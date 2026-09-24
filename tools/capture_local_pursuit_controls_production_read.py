#!/usr/bin/env python3
"""Production read-back for local Passed/Pursuing controls (A5).

Hits the live served origin with headless Chromium. Records observed values
from real canonical procurement routes with fresh and prepopulated browser
storage. Image binaries stay under the task scratch directory; only textual
receipts are committed.

The capture refuses to run until the served artifact-manifest revision
contains the delivery commit for alias c041aaf5e0e7c as a git ancestor.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "docs/evidence/local-pursuit-controls"
MANIFEST = OUT_DIR / "capture-manifest.json"
PRODUCTION = OUT_DIR / "production-read.json"
READBACK = OUT_DIR / "read-back.json"
SCRATCH = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "local-pursuit-controls-production"

PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_MANIFEST_PATH = "/artifact-manifest.json"
ARTIFACT_UA = "cityscroll-local-pursuit-controls-capture/1"
DEFAULT_BASE = "https://cityscroll.org/"
PUBLIC_ALIAS = "c041aaf5e0e7c"
SCHEMA = "cityscroll.local_pursuit_controls_production_read.v1"
PRODUCER_PATH = "docs/evidence/local-pursuit-controls/read-back.json"
STORAGE_KEY = "crol_procurement_pursuit_state_v1"
# Delivery merge for the Passed/Pursuing controls on production detail pages.
REQUIRED_ANCESTOR = "24ba5fde4fbf6552299dd297f6c5b6c36e59f0e3"

ROUTE_A = "/procurements/procurement%3Acontract_reporter_number%3A2138505"
ROUTE_B = "/procurements/procurement%3Asolicitation%3AS48020"
MATTER_A = "procurement:contract_reporter_number:2138505"
MATTER_B = "procurement:solicitation:S48020"
NOTICE_ROUTE = "/notices/20260707026/"
NOTICE_MATTER = "20260707026"

VIEWPORTS = (
    ("desktop", 1440, 900),
    ("mobile", 390, 844),
)


def normalize_base(base: str) -> str:
    return base.rstrip("/") + "/"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def resolve_base() -> str:
    raw = (os.environ.get("CROL_BASE") or DEFAULT_BASE).strip()
    base = normalize_base(raw)
    host = (urllib.parse.urlparse(base).hostname or "").lower()
    if host not in PRODUCTION_HOSTS:
        raise RuntimeError(f"production read-back requires a cityscroll.org base, got {base}")
    return base


def read_artifact_manifest(base: str) -> dict:
    url = f"{normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH}"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": ARTIFACT_UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
        raise RuntimeError(f"deployed build revision unavailable at {url}: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"artifact-manifest at {url} is not an object")
    return payload


def deployed_revision(manifest: dict) -> str:
    sha = manifest.get("source_commit_sha")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("artifact-manifest lacks a 40-hex source_commit_sha")
    return sha


def revision_contains_required_ancestor(rev: str) -> bool:
    """True when served revision is the delivery commit or a descendant of it."""
    if rev == REQUIRED_ANCESTOR:
        return True
    result = subprocess.run(
        ["git", "-C", str(ROOT), "merge-base", "--is-ancestor", REQUIRED_ANCESTOR, rev],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_ws(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip())


def wait_for_controls(page, timeout: int = 30000) -> None:
    page.locator("[data-pursuit-controls]").wait_for(state="attached", timeout=timeout)
    page.wait_for_function(
        """() => {
          const host = document.querySelector('[data-pursuit-controls]');
          return Boolean(host && host.getAttribute('data-pursuit-controls-ready') === '1');
        }""",
        timeout=timeout,
    )


def read_control_state(page) -> dict:
    return page.evaluate(
        """() => {
          const host = document.querySelector('[data-pursuit-controls]');
          if (!host) return null;
          const decision = (name) => {
            const button = host.querySelector(`[data-pursuit-decision="${name}"]`);
            return button ? button.getAttribute('aria-pressed') : null;
          };
          const error = host.querySelector('[data-pursuit-error]');
          const status = host.querySelector('[data-pursuit-status]');
          const current = host.querySelector('[data-pursuit-current]');
          const clear = host.querySelector('[data-pursuit-clear]');
          const retry = host.querySelector('[data-pursuit-retry]');
          const actions = host.querySelector('.pursuit-controls-actions');
          const style = actions ? getComputedStyle(actions) : null;
          const active = document.activeElement;
          return {
            matter_ref: host.getAttribute('data-pursuit-matter-ref'),
            ready: host.getAttribute('data-pursuit-controls-ready') === '1',
            passed_pressed: decision('passed'),
            pursuing_pressed: decision('pursuing'),
            current_text: (current && current.textContent || '').replace(/\\s+/g, ' ').trim(),
            status_text: (status && status.textContent || '').replace(/\\s+/g, ' ').trim(),
            error_visible: Boolean(error && !error.hidden),
            error_text: (error && error.textContent || '').replace(/\\s+/g, ' ').trim(),
            clear_hidden: Boolean(clear && clear.hidden),
            retry_present: Boolean(retry),
            actions_flex_direction: style ? style.flexDirection : null,
            focused_decision: active && active.getAttribute
              ? active.getAttribute('data-pursuit-decision')
              : null,
            focused_tag: active ? active.tagName : null,
          };
        }"""
    )


def read_storage_decisions(page) -> dict:
    return page.evaluate(
        """(storageKey) => {
          try {
            const raw = window.localStorage.getItem(storageKey);
            if (!raw) return { record_count: 0, by_matter: {} };
            const parsed = JSON.parse(raw);
            const records = Array.isArray(parsed && parsed.records) ? parsed.records : [];
            const by_matter = {};
            for (const row of records) {
              if (row && row.matter_ref) by_matter[row.matter_ref] = row.decision || null;
            }
            return { record_count: records.length, by_matter };
          } catch (error) {
            return { record_count: 0, by_matter: {}, error: String(error) };
          }
        }""",
        STORAGE_KEY,
    )


def seed_storage(page, decisions: dict[str, str]) -> None:
    page.evaluate(
        """({ storageKey, decisions }) => {
          const now = new Date().toISOString();
          const records = Object.entries(decisions).map(([matter_ref, decision]) => ({
            matter_ref,
            decision,
            reason_code: null,
            note: null,
            recorded_at: now,
            provenance: 'user-supplied',
          }));
          const envelope = {
            schema: 'cityscroll.procurement_pursuit_state.v1',
            records,
          };
          window.localStorage.setItem(storageKey, JSON.stringify(envelope));
        }""",
        {"storageKey": STORAGE_KEY, "decisions": decisions},
    )


def page_list_membership(page) -> list[str]:
    """Stable membership tokens from list-like regions on the current page."""
    return page.evaluate(
        """() => {
          const tokens = [];
          const push = (value) => {
            const text = String(value || '').trim();
            if (text) tokens.push(text);
          };
          for (const node of document.querySelectorAll('[data-procurement-id]')) {
            push(node.getAttribute('data-procurement-id'));
          }
          for (const node of document.querySelectorAll('[data-pivot-target-id]')) {
            push('pivot:' + (node.getAttribute('data-pivot-target-id') || ''));
          }
          for (const node of document.querySelectorAll('[data-entity-ref]')) {
            push('entity:' + (node.getAttribute('data-entity-ref') || ''));
          }
          for (const node of document.querySelectorAll('a[href*="/procurements/"]')) {
            push('href:' + (node.getAttribute('href') || ''));
          }
          return tokens;
        }"""
    )


def click_decision(page, decision: str) -> None:
    page.locator(f'[data-pursuit-decision="{decision}"]').click()
    page.wait_for_timeout(200)


def click_clear(page) -> None:
    page.locator("[data-pursuit-clear]").click()
    page.wait_for_timeout(200)


def focus_decision_via_keyboard(page, decision: str) -> dict:
    # Start from the heading, then Tab until the target decision receives focus.
    page.locator("#pursuit-controls-heading").focus()
    for _ in range(12):
        page.keyboard.press("Tab")
        state = read_control_state(page)
        if state and state.get("focused_decision") == decision:
            return state
    raise AssertionError(f"keyboard focus never reached decision={decision}")


def capture_journey(page, base: str, width: int, height: int, rev: str) -> dict:
    page.set_viewport_size({"width": width, "height": height})
    name = "mobile" if width < 800 else "desktop"

    # Fresh storage: opposite states on the two native canonical routes.
    # Clear on the production origin — about:blank storage does not carry over.
    page.goto(f"{base.rstrip('/')}/", wait_until="domcontentloaded", timeout=60000)
    page.evaluate("() => window.localStorage.clear()")

    page.goto(f"{base.rstrip('/')}{ROUTE_A}", wait_until="domcontentloaded", timeout=60000)
    wait_for_controls(page)
    before_membership = page_list_membership(page)
    state_a_empty = read_control_state(page)
    if not state_a_empty or state_a_empty.get("matter_ref") != MATTER_A:
        raise AssertionError(f"{name}: route A missing controls for {MATTER_A}: {state_a_empty!r}")
    if state_a_empty.get("passed_pressed") == "true" or state_a_empty.get("pursuing_pressed") == "true":
        raise AssertionError(f"{name}: fresh storage was not empty on route A")

    keyboard_state = focus_decision_via_keyboard(page, "passed")
    page.keyboard.press("Enter")
    page.wait_for_timeout(250)
    state_a_saved = read_control_state(page)
    storage_after_a = read_storage_decisions(page)
    after_membership_a = page_list_membership(page)
    if after_membership_a != before_membership:
        raise AssertionError(f"{name}: list membership changed after saving on route A")

    page.goto(f"{base.rstrip('/')}{ROUTE_B}", wait_until="domcontentloaded", timeout=60000)
    wait_for_controls(page)
    before_membership_b = page_list_membership(page)
    click_decision(page, "pursuing")
    state_b_saved = read_control_state(page)
    storage_both = read_storage_decisions(page)
    after_membership_b = page_list_membership(page)
    if after_membership_b != before_membership_b:
        raise AssertionError(f"{name}: list membership changed after saving on route B")

    # Reload each canonical route and recover independently.
    page.goto(f"{base.rstrip('/')}{ROUTE_A}", wait_until="domcontentloaded", timeout=60000)
    wait_for_controls(page)
    reload_a = read_control_state(page)
    page.goto(f"{base.rstrip('/')}{ROUTE_B}", wait_until="domcontentloaded", timeout=60000)
    wait_for_controls(page)
    reload_b = read_control_state(page)

    # Clear on B, reload, confirm cleared while A remains.
    click_clear(page)
    cleared_b = read_control_state(page)
    storage_after_clear = read_storage_decisions(page)
    page.goto(f"{base.rstrip('/')}{ROUTE_B}", wait_until="domcontentloaded", timeout=60000)
    wait_for_controls(page)
    reload_cleared_b = read_control_state(page)
    page.goto(f"{base.rstrip('/')}{ROUTE_A}", wait_until="domcontentloaded", timeout=60000)
    wait_for_controls(page)
    reload_a_after_clear = read_control_state(page)

    # Prepopulated storage: seed opposite states on the production origin, then recover.
    page.goto(f"{base.rstrip('/')}/", wait_until="domcontentloaded", timeout=60000)
    page.evaluate("() => window.localStorage.clear()")
    seed_storage(page, {MATTER_A: "pursuing", MATTER_B: "passed"})
    page.goto(f"{base.rstrip('/')}{ROUTE_A}", wait_until="domcontentloaded", timeout=60000)
    wait_for_controls(page)
    prepop_a = read_control_state(page)
    page.goto(f"{base.rstrip('/')}{ROUTE_B}", wait_until="domcontentloaded", timeout=60000)
    wait_for_controls(page)
    prepop_b = read_control_state(page)
    membership_prepop = page_list_membership(page)

    # Cross-entry: City Record notice path keeps an independent key.
    page.goto(f"{base.rstrip('/')}{NOTICE_ROUTE}", wait_until="domcontentloaded", timeout=60000)
    wait_for_controls(page)
    notice_before = read_control_state(page)
    click_decision(page, "passed")
    notice_after = read_control_state(page)
    storage_cross = read_storage_decisions(page)
    page.goto(f"{base.rstrip('/')}{ROUTE_B}", wait_until="domcontentloaded", timeout=60000)
    wait_for_controls(page)
    cross_back_b = read_control_state(page)
    storage_label = normalize_ws(
        page.locator(".pursuit-controls-storage-label").inner_text()
        if page.locator(".pursuit-controls-storage-label").count()
        else ""
    )

    served_values = {
        "viewport_name": name,
        "controls_present_on_route_a": bool(state_a_empty and state_a_empty.get("ready")),
        "controls_present_on_route_b": bool(state_b_saved and state_b_saved.get("ready")),
        "route_a": ROUTE_A,
        "route_b": ROUTE_B,
        "matter_a": MATTER_A,
        "matter_b": MATTER_B,
        "fresh_route_a_decision": storage_after_a.get("by_matter", {}).get(MATTER_A),
        "fresh_route_b_decision": storage_both.get("by_matter", {}).get(MATTER_B),
        "fresh_storage_record_count": storage_both.get("record_count"),
        "reload_a_passed_pressed": reload_a.get("passed_pressed") if reload_a else None,
        "reload_a_current_text": reload_a.get("current_text") if reload_a else None,
        "reload_b_pursuing_pressed": reload_b.get("pursuing_pressed") if reload_b else None,
        "reload_b_current_text": reload_b.get("current_text") if reload_b else None,
        "keyboard_focused_decision": keyboard_state.get("focused_decision"),
        "keyboard_saved_passed_pressed": state_a_saved.get("passed_pressed") if state_a_saved else None,
        "actions_flex_direction": (state_b_saved or {}).get("actions_flex_direction"),
        "cleared_b_hidden_clear": cleared_b.get("clear_hidden") if cleared_b else None,
        "reload_cleared_b_pursuing_pressed": (
            reload_cleared_b.get("pursuing_pressed") if reload_cleared_b else None
        ),
        "reload_a_still_passed_after_clear_b": (
            reload_a_after_clear.get("passed_pressed") if reload_a_after_clear else None
        ),
        "storage_record_count_after_clear_b": storage_after_clear.get("record_count"),
        "prepopulated_a_pursuing_pressed": prepop_a.get("pursuing_pressed") if prepop_a else None,
        "prepopulated_b_passed_pressed": prepop_b.get("passed_pressed") if prepop_b else None,
        "notice_route": NOTICE_ROUTE,
        "notice_matter_ref": notice_before.get("matter_ref") if notice_before else None,
        "notice_saved_passed_pressed": notice_after.get("passed_pressed") if notice_after else None,
        "cross_entry_b_still_passed": cross_back_b.get("passed_pressed") if cross_back_b else None,
        "cross_entry_storage_has_notice": NOTICE_MATTER in (storage_cross.get("by_matter") or {}),
        "cross_entry_storage_has_matter_b": MATTER_B in (storage_cross.get("by_matter") or {}),
        "list_membership_unchanged_on_route_a": after_membership_a == before_membership,
        "list_membership_unchanged_on_route_b": after_membership_b == before_membership_b,
        "list_membership_count_route_a": len(before_membership),
        "list_membership_count_route_b": len(before_membership_b),
        "storage_label_visible": "Saved in this browser" in storage_label,
    }

    # Capture-as-test: refuse incomplete observations.
    required_true = (
        "controls_present_on_route_a",
        "controls_present_on_route_b",
        "list_membership_unchanged_on_route_a",
        "list_membership_unchanged_on_route_b",
        "cross_entry_storage_has_notice",
        "cross_entry_storage_has_matter_b",
        "storage_label_visible",
    )
    for key in required_true:
        if served_values.get(key) is not True:
            raise AssertionError(f"{name}: required observation {key}={served_values.get(key)!r}")
    if served_values["fresh_route_a_decision"] != "passed":
        raise AssertionError(f"{name}: fresh A decision {served_values['fresh_route_a_decision']!r}")
    if served_values["fresh_route_b_decision"] != "pursuing":
        raise AssertionError(f"{name}: fresh B decision {served_values['fresh_route_b_decision']!r}")
    if served_values["reload_a_passed_pressed"] != "true":
        raise AssertionError(f"{name}: reload A did not recover passed")
    if served_values["reload_b_pursuing_pressed"] != "true":
        raise AssertionError(f"{name}: reload B did not recover pursuing")
    if served_values["keyboard_focused_decision"] != "passed":
        raise AssertionError(f"{name}: keyboard did not focus Passed")
    if served_values["prepopulated_a_pursuing_pressed"] != "true":
        raise AssertionError(f"{name}: prepopulated A did not recover pursuing")
    if served_values["prepopulated_b_passed_pressed"] != "true":
        raise AssertionError(f"{name}: prepopulated B did not recover passed")
    if served_values["reload_cleared_b_pursuing_pressed"] != "false":
        raise AssertionError(f"{name}: cleared B still pressed after reload")
    if served_values["reload_a_still_passed_after_clear_b"] != "true":
        raise AssertionError(f"{name}: clearing B disturbed A")
    if name == "mobile" and served_values["actions_flex_direction"] != "column":
        raise AssertionError(
            f"{name}: narrow actions flex-direction "
            f"{served_values['actions_flex_direction']!r} is not column"
        )
    if "result" in served_values or "pass" in served_values:
        raise AssertionError("served_values must not carry a pass verdict")

    digest = sha256_text(json.dumps(served_values, sort_keys=True, ensure_ascii=False))
    SCRATCH.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SCRATCH / f"local-pursuit-{name}-{width}x{height}.png"), full_page=True)

    return {
        "source": "headless-playwright-production-served-site",
        "name": f"native-routes-{name}",
        "route": ROUTE_A,
        "routes": [ROUTE_A, ROUTE_B, NOTICE_ROUTE],
        "viewport": {"width": width, "height": height},
        "revision": rev,
        "data_vintage": None,
        "assertion": (
            "Served canonical procurement routes expose Passed/Pursuing controls; "
            "fresh and prepopulated browser storage recover opposite states on "
            "2138505 and S48020; keyboard, narrow layout, clear/reload, and "
            "cross-entry notice navigation keep list membership unchanged."
        ),
        "sha256": digest,
        "file": None,
        "served_values": served_values,
    }


def build_receipt(*, base: str, artifact: dict, rev: str, observed_at: str, reads: list[dict]) -> dict:
    generated_at = artifact.get("generated_at")
    return {
        "schema": SCHEMA,
        "public_alias": PUBLIC_ALIAS,
        "observed_at": observed_at,
        "evidence_class": "deployed-production-read-back",
        "origin": normalize_base(base).rstrip("/"),
        "deployment": {
            "manifest_url": f"{normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH}",
            "revision": rev,
            "generated_at": generated_at,
            "deployment_at": artifact.get("deployment_at") or generated_at,
            "manifest_sha256": sha256_text(json.dumps(artifact, sort_keys=True)),
            "required_ancestor": REQUIRED_ANCESTOR,
            "required_ancestor_contained": True,
        },
        "capture": {
            "tool": "tools/capture_local_pursuit_controls_production_read.py",
            "browser": "chromium",
            "viewports": [{"name": n, "width": w, "height": h} for n, w, h in VIEWPORTS],
            "screenshot_binaries_committed": False,
        },
        "producer": {
            "path": PRODUCER_PATH,
            "schema": SCHEMA,
            "letters": ["A5"],
        },
        "letters": {
            "A5": {
                "clause": "served_routes_fresh_and_prepopulated_storage",
                "routes": [ROUTE_A, ROUTE_B, NOTICE_ROUTE],
                "reads": reads,
            }
        },
        "reads": reads,
        "summary": {
            "case_count": 1,
            "capture_count": len(reads),
            "letter": "A5",
        },
    }


def build_manifest(receipt: dict) -> dict:
    rev = receipt["deployment"]["revision"]
    return {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "local-pursuit-controls",
        "public_alias": PUBLIC_ALIAS,
        "surface": "Local Passed and Pursuing notes on procurement detail pages",
        "base": normalize_base(receipt["origin"]),
        "condition": (
            f"Production base {normalize_base(receipt['origin'])} after deployment; "
            "no image binary is committed."
        ),
        "capture_mode": "headless-playwright-production-served-site",
        "revision_format": "served artifact-manifest source_commit_sha",
        "revision": rev,
        "repository_revision": rev,
        "grounded_at": rev,
        "data_vintage": receipt["deployment"].get("generated_at"),
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; "
            "only this manifest is committed."
        ),
        "note": (
            "Production desktop/mobile receipts for Passed/Pursuing controls on "
            "native canonical procurement routes with fresh and prepopulated "
            "browser storage, keyboard focus, clear/reload, and cross-entry "
            "notice navigation. Textual served_values only."
        ),
        "verifier": "node --test test/friction_p1_capability.test.mjs",
        "producer": receipt["producer"],
        "captures": receipt["letters"]["A5"]["reads"],
    }


def validate(receipt: dict) -> None:
    if receipt.get("schema") != SCHEMA:
        raise AssertionError(f"unexpected schema {receipt.get('schema')}")
    if receipt.get("public_alias") != PUBLIC_ALIAS:
        raise AssertionError("public_alias mismatch")
    deployment = receipt.get("deployment") or {}
    if not re.fullmatch(r"[0-9a-f]{40}", deployment.get("revision") or ""):
        raise AssertionError("deployment.revision must be a 40-hex served SHA")
    if deployment.get("required_ancestor") != REQUIRED_ANCESTOR:
        raise AssertionError("deployment.required_ancestor mismatch")
    if deployment.get("required_ancestor_contained") is not True:
        raise AssertionError("deployment must record that the required ancestor is contained")
    producer = receipt.get("producer") or {}
    if producer.get("path") != PRODUCER_PATH:
        raise AssertionError("producer path mismatch")
    if producer.get("letters") != ["A5"]:
        raise AssertionError("producer letters mismatch")
    a5 = ((receipt.get("letters") or {}).get("A5") or {})
    if a5.get("clause") != "served_routes_fresh_and_prepopulated_storage":
        raise AssertionError("A5 clause mismatch")
    reads = a5.get("reads") or []
    if len(reads) < 2:
        raise AssertionError("A5 requires desktop and mobile served reads")
    for row in reads:
        values = row.get("served_values")
        if not isinstance(values, dict) or not values:
            raise AssertionError(f"{row.get('name')}: served_values missing")
        if values.get("fresh_route_a_decision") != "passed":
            raise AssertionError(f"{row.get('name')}: fresh A not passed")
        if values.get("fresh_route_b_decision") != "pursuing":
            raise AssertionError(f"{row.get('name')}: fresh B not pursuing")
        if values.get("reload_a_passed_pressed") != "true":
            raise AssertionError(f"{row.get('name')}: reload A missing passed")
        if values.get("reload_b_pursuing_pressed") != "true":
            raise AssertionError(f"{row.get('name')}: reload B missing pursuing")
        if values.get("list_membership_unchanged_on_route_a") is not True:
            raise AssertionError(f"{row.get('name')}: list membership changed on A")
        if values.get("list_membership_unchanged_on_route_b") is not True:
            raise AssertionError(f"{row.get('name')}: list membership changed on B")
        if "result" in values or "pass" in values:
            raise AssertionError("A5 served_values must not carry a pass verdict")
        if values.get("viewport_name") == "mobile":
            if values.get("actions_flex_direction") != "column":
                raise AssertionError(f"{row.get('name')}: mobile flex-direction not column")


def assert_canonical_json(path: Path) -> None:
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    canonical = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if raw != canonical:
        raise AssertionError(f"{path.relative_to(ROOT)} is not canonical sorted-key JSON")


def check() -> None:
    receipt = load_json(READBACK)
    validate(receipt)
    assert_canonical_json(READBACK)
    production = load_json(PRODUCTION)
    if production.get("schema") != SCHEMA:
        raise AssertionError("production-read schema mismatch")
    if production.get("producer", {}).get("letters") != ["A5"]:
        raise AssertionError("production-read producer letters mismatch")
    assert_canonical_json(PRODUCTION)
    manifest = load_json(MANIFEST)
    if manifest.get("public_alias") != PUBLIC_ALIAS:
        raise AssertionError("capture-manifest public_alias mismatch")
    if manifest.get("producer", {}).get("letters") != ["A5"]:
        raise AssertionError("capture-manifest producer letters mismatch")
    assert_canonical_json(MANIFEST)
    a5_names = {row["name"] for row in receipt["letters"]["A5"]["reads"]}
    manifest_names = {row.get("name") for row in manifest.get("captures") or []}
    if not a5_names.issubset(manifest_names):
        raise AssertionError("capture-manifest missing A5 captures")
    print(f"local-pursuit-controls A5 check passed: {READBACK.relative_to(ROOT)}")


def capture() -> dict:
    base = resolve_base()
    artifact = read_artifact_manifest(base)
    rev = deployed_revision(artifact)
    if not revision_contains_required_ancestor(rev):
        raise RuntimeError(
            f"served revision {rev} does not contain required ancestor "
            f"{REQUIRED_ANCESTOR}; wait for Pages deploy before capturing"
        )
    observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    print(f"production base={base} revision={rev}", flush=True)

    reads: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
            )
        )
        page = context.new_page()
        for name, width, height in VIEWPORTS:
            print(f"A5 local pursuit controls {name}", flush=True)
            reads.append(capture_journey(page, base, width, height, rev))
        browser.close()

    receipt = build_receipt(
        base=base,
        artifact=artifact,
        rev=rev,
        observed_at=observed_at,
        reads=reads,
    )
    validate(receipt)
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return 0

    receipt = capture()
    write_json(READBACK, receipt)
    write_json(PRODUCTION, receipt)
    write_json(MANIFEST, build_manifest(receipt))
    print(f"wrote {READBACK.relative_to(ROOT)}", flush=True)
    print(f"wrote {PRODUCTION.relative_to(ROOT)}", flush=True)
    print(f"wrote {MANIFEST.relative_to(ROOT)}", flush=True)
    for row in receipt["letters"]["A5"]["reads"]:
        values = row["served_values"]
        print(
            f"  {row['name']}: a={values['fresh_route_a_decision']} "
            f"b={values['fresh_route_b_decision']} "
            f"flex={values['actions_flex_direction']}",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(exc, file=sys.stderr)
        raise
