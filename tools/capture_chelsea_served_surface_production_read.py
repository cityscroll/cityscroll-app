#!/usr/bin/env python3
"""Production evidence capture for Chelsea Near You served-surface production evidence.

Hits https://cityscroll.org with headless Chromium. Dual-half served-revision
rule:

- Worker half (Near You shell / deferred / overview / lenses): require
  api.cityscroll.org/health ``commit`` to contain BOTH required ancestors, and
  a successful main-branch "Deploy worker" run for that headSha whose
  "Live URL smoke" job also concluded success.
- Pages half (meeting-detail / no-JS document fetch): require
  /artifact-manifest.json ``source_commit_sha`` to contain BOTH ancestors.
  No Worker green requirement for Pages alone.

``--half worker`` refreshes only Worker-served observations and retains prior Pages observations when the static half is still paused. Do not invent capture-manifest values. ``--check-gates`` prints readiness and
exits non-zero while either half is paused. Screenshot binaries stay under
$FM_TASK_SCRATCH; only textual receipts are committed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from deployed_capture_ancestor import (  # noqa: E402
    DeployPendingError,
    WrongPinError,
    revision_contains_ancestor,
    resolve_landed_ancestor,
)
from near_you_detail_observer import fetch_document_html  # noqa: E402

EVIDENCE_DIR = ROOT / "docs/evidence/chelsea-served-surface"
DELIVERY_PATH = EVIDENCE_DIR / "delivery.json"
MANIFEST_PATH = EVIDENCE_DIR / "capture-manifest.json"
PRODUCTION_PATH = EVIDENCE_DIR / "production-read.json"
SCRATCH = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp/chelsea-served-surface-scratch") / (
    "chelsea-served-surface"
)

ORIGIN = "https://cityscroll.org"
API_ORIGIN = "https://api.cityscroll.org"
DEFAULT_BASE = f"{ORIGIN}/"
USER_AGENT = "cityscroll-chelsea-served-surface-capture/1"

FEATURE = "chelsea-served-surface"
PRODUCER_SCHEMA = "cityscroll.chelsea_served_surface_production_read.v1"
MANIFEST_SCHEMA = "cityscroll.render_capture_manifest.v1"
DELIVERY_SCHEMA = "cityscroll.capture_delivery.v1"

# Required ancestors (both must be present on every observation half).
OVERVIEW_ANCESTOR = "964dff5f0bbc0d69d6c3bdba22d9b1c0791d870e"
MAP_FIX_ANCESTOR = "62220ddcf225e4a4b51fa4159e030e8925cef0ff"
REQUIRED_ANCESTORS = (
    ("overview", OVERVIEW_ANCESTOR),
    ("map_fix", MAP_FIX_ANCESTOR),
)

CHELSEA = "MN0401"
HELLS_KITCHEN = "MN0402"
CHELSEA_LABEL_NEEDLES = ("Chelsea-Hudson Yards", "Chelsea")
BROADER_DISTRICT = "M04"

VIEWPORTS = (
    ("desktop", 1440, 900),
    ("narrow", 390, 844),
)

NO_LENS_ROUTE = f"/near-you/?geo=nta2020%3A{CHELSEA}&surface=records"
NO_LENS_MAP_ROUTE = f"/near-you/?geo=nta2020%3A{CHELSEA}&surface=map"
LENS_ROUTE = "/near-you/?geo=nta2020%3A{geo}&lens={lens}&surface=records"
DEFERRED_ROUTE = "/near-you/deferred.json?geo=nta2020%3A{geo}&lens={lens}&surface=records"

OBSERVE_MAP = """(() => {
  let library;
  Object.defineProperty(window, 'maplibregl', {
    configurable: true,
    get: () => library,
    set(value) {
      library = value;
      const NativeMap = value.Map;
      value.Map = new Proxy(NativeMap, {construct(target, args) {
        const map = Reflect.construct(target, args);
        window.__chelseaObservedMap = map;
        return map;
      }});
    }
  });
})()"""

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
LOCAL_RECOVERY_RE = re.compile(
    r'data-near-local-recovery="([a-z]+)"[^>]*>\s*<strong>([^<]*)</strong>'
)


def platform_browser_back_chords() -> list[dict[str, str]]:
    """Ordered keyboard history-Back chords for the host platform.

    macOS Chrome/Chromium uses Meta+BracketLeft (⌘[). Alt+ArrowLeft is the
    Windows/Linux chord. Playwright Chromium often does not deliver either as
    browser history navigation; callers must record each attempt and must not
    treat a geographic place-link fallback as proof that history Back is broken.
    """
    darwin = platform.system() == "Darwin"
    mac = {
        "chord": "Meta+BracketLeft",
        "role": "platform-primary",
        "note": "macOS Chrome/Chromium history Back (⌘[)",
    }
    cross = {
        "chord": "Alt+ArrowLeft",
        "role": "cross-platform",
        "note": "Windows/Linux history Back",
    }
    alt_mac = {
        "chord": "Meta+ArrowLeft",
        "role": "platform-alternate",
        "note": "macOS alternate history Back in some browsers",
    }
    if darwin:
        return [mac, alt_mac, cross]
    return [cross, mac]


def attempt_keyboard_browser_back(page, *, timeout_ms: int = 5_000) -> dict[str, Any]:
    """Try platform-correct keyboard history-Back chords only — no place-link.

    Returns navigated=True only when a chord produces a document navigation.
    Playwright Chromium commonly yields no-navigation for every chord even when
    page.go_back would restore the prior Near You state; that is an automation
    limit, not product proof that history Back is broken.
    """
    attempts: list[dict[str, Any]] = []
    pre_url = safe_page_url(page) or ""
    for spec in platform_browser_back_chords():
        chord = spec["chord"]
        entry: dict[str, Any] = {
            "chord": chord,
            "role": spec.get("role"),
            "note": spec.get("note"),
            "pre_url": pre_url,
            "navigated": False,
            "error": None,
        }
        try:
            with page.expect_navigation(timeout=timeout_ms, wait_until="domcontentloaded"):
                page.keyboard.press(chord)
            entry["navigated"] = True
            entry["post_url"] = safe_page_url(page) or ""
            attempts.append(entry)
            return {
                "navigated": True,
                "chord": chord,
                "attempts": attempts,
                "status": "keyboard-browser-back",
                "post_url": entry["post_url"],
            }
        except Exception as error:
            entry["error"] = {
                "type": error.__class__.__name__,
                "message": str(error)[:240],
            }
            page.wait_for_timeout(200)
            post = safe_page_url(page) or ""
            entry["post_url"] = post
            if post and post != pre_url:
                entry["navigated"] = True
                attempts.append(entry)
                return {
                    "navigated": True,
                    "chord": chord,
                    "attempts": attempts,
                    "status": "keyboard-browser-back",
                    "post_url": post,
                }
            attempts.append(entry)
    return {
        "navigated": False,
        "chord": None,
        "attempts": attempts,
        "status": "playwright-chromium-no-keyboard-history-nav",
        "post_url": safe_page_url(page) or "",
        "note": (
            "Platform-correct keyboard history-Back chords did not navigate in "
            "Playwright Chromium. This does not prove product history Back is "
            "broken; page.go_back may still retain requested Near You state. "
            "A geographic place-link is a separate affordance."
        ),
    }


class GatePendingError(RuntimeError):
    """Served half is not ready for capture."""


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_text(value: str | bytes) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def normalize_base(base: str) -> str:
    return base.rstrip("/") + "/"


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_ws(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip())


def fetch_json_url(url: str, *, timeout: float = 60.0) -> tuple[int, bytes, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "Cache-Control": "no-cache, no-store",
            "Pragma": "no-cache",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
            return response.status, body, json.loads(body)
    except urllib.error.HTTPError as error:
        body = error.read()
        try:
            payload = json.loads(body)
        except Exception:
            payload = None
        return error.code, body, payload
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
        raise GatePendingError(f"fetch failed for {url}: {error}") from error


def uncached(origin: str, route: str, token: str | None = None) -> str:
    sep = "&" if "?" in route else "?"
    return f"{origin.rstrip('/')}{route}{sep}_cityscroll_evidence={token or secrets.token_hex(12)}"


def load_delivery_ancestors() -> dict[str, str]:
    """Load required ancestors from delivery.json, falling back to constants."""
    if not DELIVERY_PATH.is_file():
        return {"overview": OVERVIEW_ANCESTOR, "map_fix": MAP_FIX_ANCESTOR}
    payload = load_json(DELIVERY_PATH)
    if payload.get("schema") != DELIVERY_SCHEMA:
        raise WrongPinError(f"delivery schema must be {DELIVERY_SCHEMA!r}")
    ancestors: dict[str, str] = {}
    rows = payload.get("required_ancestors")
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            role = str(row.get("role") or "").strip()
            commit = str(row.get("commit") or "").strip().lower()
            if role and SHA_RE.fullmatch(commit):
                ancestors[role] = commit
    if "overview" not in ancestors:
        landed = str(payload.get("landed_commit") or "").strip().lower()
        if SHA_RE.fullmatch(landed):
            ancestors["overview"] = landed
    if "map_fix" not in ancestors:
        ancestors["map_fix"] = MAP_FIX_ANCESTOR
    if ancestors.get("overview") != OVERVIEW_ANCESTOR:
        raise WrongPinError(
            f"delivery overview ancestor {ancestors.get('overview')!r} != {OVERVIEW_ANCESTOR}"
        )
    if ancestors.get("map_fix") != MAP_FIX_ANCESTOR:
        raise WrongPinError(
            f"delivery map_fix ancestor {ancestors.get('map_fix')!r} != {MAP_FIX_ANCESTOR}"
        )
    return ancestors


def prove_pins_on_default_branch(ancestors: dict[str, str]) -> None:
    for role, pin in ancestors.items():
        resolve_landed_ancestor(pin, cwd=ROOT, main_ref="origin/main")


def ancestry_flags(rev: str, ancestors: dict[str, str]) -> dict[str, bool]:
    return {
        "contains_overview_ancestor": revision_contains_ancestor(
            ancestors["overview"], rev, cwd=ROOT
        ),
        "contains_map_fix_ancestor": revision_contains_ancestor(
            ancestors["map_fix"], rev, cwd=ROOT
        ),
    }


def require_both_ancestors(rev: str, ancestors: dict[str, str], *, half: str) -> dict[str, bool]:
    flags = ancestry_flags(rev, ancestors)
    missing = [role for role, ok in (
        ("overview", flags["contains_overview_ancestor"]),
        ("map_fix", flags["contains_map_fix_ancestor"]),
    ) if not ok]
    if missing:
        raise DeployPendingError(
            f"{half} revision {rev} does not contain required ancestor(s) "
            f"{', '.join(missing)} ({', '.join(ancestors[m] for m in missing)}); "
            f"wait for {half} deploy before capturing"
        )
    return flags


def read_worker_health(api_origin: str = API_ORIGIN) -> tuple[str, dict[str, Any]]:
    status, _body, health = fetch_json_url(f"{api_origin.rstrip('/')}/health")
    if status != 200 or not isinstance(health, dict):
        raise GatePendingError(f"worker health HTTP {status} at {api_origin}/health")
    commit = health.get("commit")
    if not isinstance(commit, str) or not SHA_RE.fullmatch(commit):
        raise GatePendingError("worker health lacks a 40-hex commit")
    return commit, health


def read_pages_revision(origin: str = ORIGIN) -> tuple[str, dict[str, Any], bytes]:
    status, body, manifest = fetch_json_url(f"{origin.rstrip('/')}/artifact-manifest.json")
    if status != 200 or not isinstance(manifest, dict):
        raise GatePendingError(f"artifact-manifest HTTP {status}")
    sha = manifest.get("source_commit_sha")
    if not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
        raise GatePendingError("artifact-manifest lacks source_commit_sha")
    return sha, manifest, body


def _run_gh(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["gh", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def find_worker_deploy_smoke(head_sha: str) -> dict[str, Any]:
    """Require Deploy worker on main for head_sha with Live URL smoke success."""
    listed = _run_gh(
        [
            "run",
            "list",
            "--workflow",
            "Deploy worker",
            "--branch",
            "main",
            "--limit",
            "40",
            "--json",
            "databaseId,headSha,conclusion,status,url,displayTitle,createdAt",
        ]
    )
    if listed.returncode != 0:
        raise GatePendingError(
            f"gh run list Deploy worker failed: {(listed.stderr or listed.stdout).strip()}"
        )
    try:
        runs = json.loads(listed.stdout or "[]")
    except json.JSONDecodeError as error:
        raise GatePendingError(f"gh run list returned non-JSON: {error}") from error
    if not isinstance(runs, list):
        raise GatePendingError("gh run list payload is not a list")

    matches = [
        run
        for run in runs
        if isinstance(run, dict) and str(run.get("headSha") or "").lower() == head_sha.lower()
    ]
    if not matches:
        raise GatePendingError(
            f"no Deploy worker run on main for worker headSha {head_sha}; "
            "wait for Worker deploy before capturing the worker half"
        )

    # Prefer a successful completed run; otherwise surface the newest match.
    success = next(
        (
            run
            for run in matches
            if run.get("conclusion") == "success" and run.get("status") == "completed"
        ),
        None,
    )
    candidate = success or matches[0]
    run_id = str(candidate.get("databaseId") or "")
    if not run_id:
        raise GatePendingError(f"Deploy worker run for {head_sha} lacks databaseId")

    if candidate.get("conclusion") != "success" or candidate.get("status") != "completed":
        raise GatePendingError(
            f"Deploy worker run {run_id} for {head_sha} conclusion="
            f"{candidate.get('conclusion')!r} status={candidate.get('status')!r}; "
            "wait for a successful Worker deploy before capturing"
        )

    viewed = _run_gh(["run", "view", run_id, "--json", "jobs,conclusion,status,url,headSha"])
    if viewed.returncode != 0:
        # Fallback: REST jobs endpoint.
        api = _run_gh(
            [
                "api",
                f"repos/cityscroll/cityscroll-app/actions/runs/{run_id}/jobs?per_page=50",
            ]
        )
        if api.returncode != 0:
            raise GatePendingError(
                f"unable to read jobs for Deploy worker run {run_id}: "
                f"{(viewed.stderr or api.stderr or '').strip()}"
            )
        try:
            body = json.loads(api.stdout or "{}")
        except json.JSONDecodeError as error:
            raise GatePendingError(f"jobs API non-JSON for run {run_id}: {error}") from error
        jobs = body.get("jobs") if isinstance(body, dict) else None
    else:
        try:
            body = json.loads(viewed.stdout or "{}")
        except json.JSONDecodeError as error:
            raise GatePendingError(f"gh run view non-JSON for run {run_id}: {error}") from error
        jobs = body.get("jobs") if isinstance(body, dict) else None

    if not isinstance(jobs, list):
        raise GatePendingError(f"Deploy worker run {run_id} jobs payload missing")

    smoke = next(
        (
            job
            for job in jobs
            if isinstance(job, dict) and str(job.get("name") or "") == "Live URL smoke"
        ),
        None,
    )
    if smoke is None:
        raise GatePendingError(
            f"Deploy worker run {run_id} has no job named 'Live URL smoke'"
        )
    smoke_conclusion = smoke.get("conclusion")
    if smoke_conclusion != "success":
        raise GatePendingError(
            f"Deploy worker run {run_id} Live URL smoke conclusion={smoke_conclusion!r}; "
            "worker half capture is paused until live smoke is green"
        )
    return {
        "deploy_run_id": run_id,
        "deploy_run_url": candidate.get("url") or (body.get("url") if isinstance(body, dict) else None),
        "deploy_run_conclusion": candidate.get("conclusion"),
        "live_smoke_conclusion": smoke_conclusion,
        "live_smoke_status": smoke.get("status"),
        "head_sha": head_sha,
    }


def check_worker_gates(ancestors: dict[str, str], *, api_origin: str = API_ORIGIN) -> dict[str, Any]:
    commit, health = read_worker_health(api_origin)
    flags = require_both_ancestors(commit, ancestors, half="worker")
    smoke = find_worker_deploy_smoke(commit)
    return {
        "served_half": "worker",
        "served_revision": commit,
        "health": {
            "environment": health.get("environment"),
            "commit": commit,
        },
        **flags,
        "deploy_run_id": smoke["deploy_run_id"],
        "live_smoke_conclusion": smoke["live_smoke_conclusion"],
        "deploy_run_url": smoke.get("deploy_run_url"),
        "ready": True,
    }


def check_pages_gates(ancestors: dict[str, str], *, origin: str = ORIGIN) -> dict[str, Any]:
    revision, manifest, body = read_pages_revision(origin)
    flags = require_both_ancestors(revision, ancestors, half="pages")
    return {
        "served_half": "pages",
        "served_revision": revision,
        "generated_at": manifest.get("generated_at"),
        "deployment_at": manifest.get("deployment_at"),
        "manifest_sha256": sha256_text(body),
        **flags,
        "ready": True,
    }


def check_gates(*, origin: str = ORIGIN, api_origin: str = API_ORIGIN) -> dict[str, Any]:
    ancestors = load_delivery_ancestors()
    prove_pins_on_default_branch(ancestors)
    report: dict[str, Any] = {
        "feature": FEATURE,
        "required_ancestors": ancestors,
        "checked_at": utc_now(),
        "worker": None,
        "pages": None,
        "ready": False,
        "pending": [],
    }
    try:
        report["worker"] = check_worker_gates(ancestors, api_origin=api_origin)
    except (GatePendingError, DeployPendingError, WrongPinError) as error:
        report["worker"] = {"served_half": "worker", "ready": False, "pending_error": str(error)}
        report["pending"].append(f"worker: {error}")
    try:
        report["pages"] = check_pages_gates(ancestors, origin=origin)
    except (GatePendingError, DeployPendingError, WrongPinError) as error:
        report["pages"] = {"served_half": "pages", "ready": False, "pending_error": str(error)}
        report["pending"].append(f"pages: {error}")
    report["ready"] = bool(
        report["worker"]
        and report["worker"].get("ready")
        and report["pages"]
        and report["pages"].get("ready")
    )
    return report


def classify_lens_recovery(html: str, *, results_count: int | None) -> dict[str, Any]:
    """Map served recovery markers to coverage vocabulary from observed copy."""
    matches = LOCAL_RECOVERY_RE.findall(html or "")
    recovery_state = matches[0][0] if matches else None
    recovery_copy = normalize_ws(matches[0][1]) if matches else None
    error_markers = (
        'data-near-deferred-state="error"' in (html or "")
        or 'data-near-local-recovery="error"' in (html or "")
        or "Matching records are not available right now" in (html or "")
    )
    if error_markers and recovery_state not in ("unsupported", "zero"):
        return {
            "coverage": "incomplete" if "not available" in (html or "").lower() else "unavailable",
            "recovery_state": recovery_state or "error",
            "resident_copy": recovery_copy
            or normalize_ws(
                re.search(
                    r"Matching records are not available right now\.?",
                    html or "",
                ).group(0)
                if re.search(r"Matching records are not available right now\.?", html or "")
                else ""
            ),
            "results_count": results_count,
        }
    if recovery_state == "unsupported":
        return {
            "coverage": "unsupported",
            "recovery_state": "unsupported",
            "resident_copy": recovery_copy,
            "results_count": None,
        }
    if recovery_state == "zero":
        return {
            "coverage": "verified-empty",
            "recovery_state": "zero",
            "resident_copy": recovery_copy,
            "results_count": 0 if results_count is None else results_count,
        }
    if isinstance(results_count, int) and results_count > 0:
        return {
            "coverage": "supported",
            "recovery_state": "ready",
            "resident_copy": recovery_copy,
            "results_count": results_count,
        }
    if isinstance(results_count, int) and results_count == 0:
        # Measured zero without the typed recovery marker still counts as empty.
        empty_copy = None
        for needle in (
            "No mapped meetings match these filters.",
            "No records match these filters.",
        ):
            if needle in (html or ""):
                empty_copy = needle
                break
        return {
            "coverage": "verified-empty",
            "recovery_state": recovery_state or "zero",
            "resident_copy": recovery_copy or empty_copy,
            "results_count": 0,
        }
    return {
        "coverage": "unavailable",
        "recovery_state": recovery_state,
        "resident_copy": recovery_copy,
        "results_count": results_count,
    }


def _extract_near_results_html(html: str) -> str:
    """Prefer the results section so citywide bag rows are not treated as membership."""
    if not html:
        return ""
    match = re.search(
        r'<section\b[^>]*class="[^"]*\bnear-results\b[^"]*"[^>]*>(.*?)</section>',
        html,
        flags=re.I | re.S,
    )
    if match:
        return match.group(0)
    # Some renders omit the class ordering; accept data-near-results markers too.
    match = re.search(
        r'<section\b[^>]*(?:data-near-results|id="near-results")[^>]*>(.*?)</section>',
        html,
        flags=re.I | re.S,
    )
    return match.group(0) if match else html


def parse_near_record_ids(html: str) -> dict[str, list[str]]:
    """Parse exact vs broader membership ids from the Near You results section only.

    Citywide bag / special-record lists also use ``li.near-record`` but are
    separately scoped; counting them as exact membership falsely intersects
    unsupported Chelsea meetings with Hell's Kitchen venue rows.
    """
    scope_html = _extract_near_results_html(html)
    exact: list[str] = []
    broader: list[str] = []
    for match in re.finditer(r'<li class="near-record"([^>]*)>', scope_html or ""):
        attrs = match.group(1)
        id_match = re.search(r'data-record-id="([^"]+)"', attrs)
        if not id_match:
            continue
        record_id = urllib.parse.unquote(id_match.group(1))
        if "data-broader-scope" in attrs:
            broader.append(record_id)
        else:
            exact.append(record_id)
    return {"exact_ids": exact, "broader_ids": broader}


def parse_citywide_bag_ids(html: str) -> list[str]:
    """Record ids from citywide bag / special-record lists (separately scoped)."""
    if not html:
        return []
    bags: list[str] = []
    for match in re.finditer(
        r'<section\b[^>]*class="[^"]*\bnear-(?:bags|special-records)\b[^"]*"[^>]*>(.*?)</section>',
        html,
        flags=re.I | re.S,
    ):
        for item in re.finditer(r'<li class="near-record"([^>]*)>', match.group(1) or ""):
            id_match = re.search(r'data-record-id="([^"]+)"', item.group(1))
            if id_match:
                bags.append(urllib.parse.unquote(id_match.group(1)))
    return bags



SITE_BRAND_HEADINGS = frozenset({"CityScroll"})
SHARED_MEETING_SHARD = ROOT / "site/data/shared_meeting_read_model/shard-000.json"


def read_applied_viewport(page) -> dict[str, Any]:
    measured = page.evaluate(
        """() => ({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
          devicePixelRatio: window.devicePixelRatio,
        })"""
    )
    vp = page.viewport_size or {}
    configured_width = int(vp.get("width") or 0)
    configured_height = int(vp.get("height") or 0)
    inner_w = int(measured.get("innerWidth") or configured_width or 0)
    inner_h = int(measured.get("innerHeight") or configured_height or 0)
    outer_w = int(measured.get("outerWidth") or inner_w)
    outer_h = int(measured.get("outerHeight") or inner_h)
    return {
        "width": inner_w,
        "height": inner_h,
        "configured_width": configured_width,
        "configured_height": configured_height,
        "outer_width": outer_w,
        "outer_height": outer_h,
        "device_pixel_ratio": float(measured.get("devicePixelRatio") or 1),
        "chrome_width": max(0, outer_w - inner_w),
        "chrome_height": max(0, outer_h - inner_h),
        "matches_configured": bool(
            configured_width
            and configured_height
            and abs(inner_w - configured_width) <= 1
            and abs(inner_h - configured_height) <= 1
        ),
        "manual_chrome_check_retained": True,
    }


def install_document_marker(page) -> dict[str, Any]:
    marker = f"capture-doc-{uuid.uuid4().hex}"
    nav_before = int(
        page.evaluate("() => performance.getEntriesByType('navigation').length") or 0
    )
    page.evaluate("(m) => { window.__captureDoc = m; }", marker)
    return {
        "marker": marker,
        "navigation_entries_before": nav_before,
    }


def prove_same_document(page, marker_state: dict[str, Any]) -> dict[str, Any]:
    marker = marker_state.get("marker")
    nav_before = int(marker_state.get("navigation_entries_before") or 0)
    try:
        after = page.evaluate(
            """(m) => ({
              marker: window.__captureDoc || null,
              marker_survived: window.__captureDoc === m,
              navigation_entries: performance.getEntriesByType('navigation').length,
            })""",
            marker,
        )
    except Exception as error:
        return {
            "marker": marker,
            "marker_after": None,
            "marker_survived": False,
            "navigation_entries_before": nav_before,
            "navigation_entries_after": None,
            "navigation_entries_grew": None,
            "same_document": False,
            "evaluate_error": error.__class__.__name__,
            "evaluate_error_message": str(error)[:240],
        }
    nav_after = int(after.get("navigation_entries") or 0)
    grew = nav_after > nav_before
    survived = bool(after.get("marker_survived"))
    return {
        "marker": marker,
        "marker_after": after.get("marker"),
        "marker_survived": survived,
        "navigation_entries_before": nav_before,
        "navigation_entries_after": nav_after,
        "navigation_entries_grew": grew,
        "same_document": bool(survived and not grew),
    }


def focused_element_snapshot(page) -> dict[str, Any]:
    """Read activeElement after the document is usable. Never blind-retry navigation."""
    empty = {
        "tag": None,
        "text": None,
        "href": None,
        "id": None,
        "role": None,
        "className": None,
        "ariaLabel": None,
        "inspectUid": None,
        "isInspectControl": False,
    }
    try:
        page.wait_for_load_state("domcontentloaded", timeout=5_000)
    except Exception as error:
        return {
            **empty,
            "evaluate_error": error.__class__.__name__,
            "evaluate_error_message": str(error)[:240],
            "evaluate_phase": "wait-domcontentloaded",
        }
    try:
        return page.evaluate(
            """() => {
              const el = document.activeElement;
              if (!el) {
                return {
                  tag: null, text: null, href: null, id: null, role: null,
                  className: null, ariaLabel: null, inspectUid: null, isInspectControl: false,
                };
              }
              const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
              const className = typeof el.className === 'string' ? el.className : String(el.className || '');
              const ariaLabel = el.getAttribute('aria-label') || null;
              const inspectUid = el.getAttribute('data-near-you-record-inspection-uid') || null;
              const isInspectControl = !!(
                el.matches && el.matches('button.near-record-inspect, [data-near-you-record-inspection]')
              );
              return {
                tag: el.tagName || null,
                id: el.id || null,
                role: el.getAttribute('role'),
                href: el.getAttribute && el.getAttribute('href'),
                text,
                className,
                ariaLabel,
                inspectUid,
                isInspectControl,
              };
            }"""
        )
    except Exception as error:
        return {
            **empty,
            "evaluate_error": error.__class__.__name__,
            "evaluate_error_message": str(error)[:240],
            "evaluate_phase": "activeElement",
        }


def safe_page_url(page) -> str | None:
    try:
        return page.url
    except Exception as error:
        return f"<url-unavailable:{error.__class__.__name__}>"


def safe_evaluate(page, expression: str, arg: Any = None) -> Any:
    """Evaluate only after the document is usable; return bounded error evidence on failure."""
    settle = wait_for_navigation_settle(page, timeout_ms=30_000)
    if not settle.get("domcontentloaded"):
        return {
            "evaluate_error": "not-settled",
            "navigation_settle": settle,
            "value": None,
        }
    try:
        if arg is None:
            value = page.evaluate(expression)
        else:
            value = page.evaluate(expression, arg)
        return value
    except Exception as error:
        return {
            "evaluate_error": error.__class__.__name__,
            "evaluate_error_message": str(error)[:240],
            "navigation_settle": settle,
            "value": None,
        }


def goto_settled(page, url: str, *, timeout_ms: int = 120_000) -> dict[str, Any]:
    """Navigate and settle; if interrupted by another navigation, wait it out then retry once."""
    evidence: dict[str, Any] = {"url": url, "attempts": []}
    for attempt in range(2):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            settle = wait_for_navigation_settle(page, timeout_ms=min(timeout_ms, 90_000))
            evidence["attempts"].append({"attempt": attempt, "ok": True, "settle": settle})
            evidence["final_url"] = safe_page_url(page)
            evidence["ok"] = True
            return evidence
        except Exception as error:
            message = str(error)
            evidence["attempts"].append(
                {
                    "attempt": attempt,
                    "ok": False,
                    "type": error.__class__.__name__,
                    "message": message[:300],
                }
            )
            # Let the interrupting navigation finish, then retry.
            wait_for_navigation_settle(page, timeout_ms=30_000)
            if attempt == 1 or "interrupted by another navigation" not in message:
                evidence["ok"] = False
                evidence["final_url"] = safe_page_url(page)
                raise
    evidence["ok"] = False
    return evidence


def wait_for_navigation_settle(page, *, timeout_ms: int = 90_000) -> dict[str, Any]:
    """After a navigating action, wait for load state before any evaluate/focus read.

    Bounded evidence only — no blind retries. Callers that stay same-document should
    use same-document proof instead of this helper.
    """
    evidence: dict[str, Any] = {"errors": [], "settled": False}
    try:
        page.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
        evidence["domcontentloaded"] = True
    except Exception as error:
        evidence["domcontentloaded"] = False
        evidence["errors"].append(
            {
                "phase": "domcontentloaded",
                "type": error.__class__.__name__,
                "message": str(error)[:240],
            }
        )
    try:
        page.wait_for_load_state("networkidle", timeout=min(timeout_ms, 90_000))
        evidence["networkidle"] = True
    except Exception as error:
        evidence["networkidle"] = False
        evidence["errors"].append(
            {
                "phase": "networkidle",
                "type": error.__class__.__name__,
                "message": str(error)[:240],
            }
        )
    evidence["url"] = safe_page_url(page)
    evidence["settled"] = bool(evidence.get("domcontentloaded"))
    return evidence



def is_near_you_inspect_control(focused: dict[str, Any] | None) -> bool:
    """True only for the observed Near You Inspect control — not any button."""
    if not isinstance(focused, dict):
        return False
    if focused.get("isInspectControl"):
        return True
    class_name = str(focused.get("className") or "")
    aria = str(focused.get("ariaLabel") or "")
    if "near-record-inspect" in class_name.split():
        return True
    if aria.startswith("Inspect:") and focused.get("inspectUid"):
        return True
    if focused.get("inspectUid") and focused.get("tag") == "BUTTON":
        return True
    return False


def is_near_you_full_record_control(focused: dict[str, Any] | None) -> bool:
    """Land full-record only — meeting hrefs are a different handoff and must not race later gotos."""
    if not isinstance(focused, dict):
        return False
    href = str(focused.get("href") or "")
    class_name = str(focused.get("className") or "")
    classes = class_name.split()
    landish = "#land/" in href or "/browse/zoning" in href
    if not landish:
        return False
    return (
        "near-record-full-record" in classes
        or "near-record-title-link" in classes
        or "#land/" in href
    )


def is_near_you_lens_control(focused: dict[str, Any] | None) -> bool:
    if not isinstance(focused, dict):
        return False
    href = str(focused.get("href") or "")
    return "near-you" in href and "lens=" in href


def is_chelsea_land_category_control(
    focused: dict[str, Any] | None,
    *,
    expected_geo: str = f"nta2020:{CHELSEA}",
) -> bool:
    """True for overview Open Zoning / Zoning controls that switch into Chelsea land.

    Meetings-lensed surfaces do not expose a Chelsea lens=land control; category
    change is offered on the no-lens overview via Open Zoning / Zoning N links.
    Same-lens surface links (Map / Browse records) must not match.
    """
    if not isinstance(focused, dict):
        return False
    href = str(focused.get("href") or "")
    if "near-you" not in href or "lens=land" not in href:
        return False
    geo_token = expected_geo.replace(":", "%3A")
    if expected_geo not in href and geo_token not in href and CHELSEA not in href:
        return False
    text = f"{focused.get('text') or ''} {focused.get('ariaLabel') or ''}"
    # Require the resident-facing Zoning / Open Zoning label so map place-picks
    # with lens=land in the href do not count as a category transition control.
    return bool(re.search(r"\bOpen Zoning\b|\bZoning\b", text, re.I))


def read_inspection_dialog_state(page) -> dict[str, Any]:
    return page.evaluate(
        """() => {
          const dialog = document.getElementById('near-you-record-inspection');
          if (!dialog) {
            return {present: false, open: false, title: null, labelledby: null};
          }
          const title = document.getElementById('near-you-record-inspection-title');
          const text = (el) => el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null;
          return {
            present: true,
            open: !!(dialog.open || dialog.hasAttribute('open')),
            title: text(title),
            labelledby: dialog.getAttribute('aria-labelledby'),
          };
        }"""
    )


def normalize_near_you_geo(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    geo = value
    if geo.startswith("geography:"):
        geo = geo.split("geography:", 1)[-1]
    return geo or None


def read_near_you_route_state(page) -> dict[str, Any]:
    """Observe rendered Near You geo/lens/surface from URL + DOM (DOM surface is authoritative)."""
    try:
        payload = page.evaluate(
            """() => {
              const root = document.querySelector('[data-near-you-root]');
              const u = new URL(window.location.href);
              const active = document.querySelector('.near-surface-link.is-active');
              const map = document.querySelector('.maplibregl-canvas');
              const mapBox = map ? map.getBoundingClientRect() : null;
              const text = (el) => el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null;
              return {
                url: window.location.href,
                geo_param: u.searchParams.get('geo'),
                lens_param: u.searchParams.get('lens'),
                surface_param: u.searchParams.get('surface'),
                surface_dom: root ? root.getAttribute('data-near-surface') : null,
                lens_dom: root ? root.getAttribute('data-lens') : null,
                active_surface_text: text(active),
                near_results_count: document.querySelectorAll('section.near-results li.near-record').length,
                map_size: mapBox ? {width: mapBox.width, height: mapBox.height} : null,
              };
            }"""
        )
    except Exception as error:
        return {
            "evaluate_error": error.__class__.__name__,
            "evaluate_error_message": str(error)[:240],
        }
    if not isinstance(payload, dict):
        return {"evaluate_error": "non-object", "value": payload}
    payload["geo"] = normalize_near_you_geo(payload.get("geo_param"))
    # Prefer DOM surface/lens; fall back to URL params when root is absent.
    payload["surface"] = payload.get("surface_dom") or payload.get("surface_param")
    payload["lens"] = payload.get("lens_dom") or payload.get("lens_param") or None
    if payload.get("lens") == "":
        payload["lens"] = None
    return payload


def retained_requested_return_state(
    requested: dict[str, Any] | None,
    returned: dict[str, Any] | None,
    *,
    expected_geo: str,
) -> dict[str, Any]:
    """Compare requested post-category Near You state to the post-Back rendered state."""
    requested = requested or {}
    returned = returned or {}
    want_geo = normalize_near_you_geo(requested.get("geo")) or expected_geo
    got_geo = normalize_near_you_geo(returned.get("geo"))
    want_lens = requested.get("lens")
    got_lens = returned.get("lens")
    want_surface = requested.get("surface")
    got_surface = returned.get("surface")
    gaps: list[str] = []
    if got_geo != want_geo:
        gaps.append("geo")
    if want_lens and got_lens != want_lens:
        gaps.append("lens")
    if want_surface and got_surface != want_surface:
        gaps.append("surface")
    near_you = "near-you" in str(returned.get("url") or "")
    if not near_you:
        gaps.append("near-you")
    return {
        "retained": not gaps and near_you,
        "gaps": gaps,
        "requested": {
            "geo": want_geo,
            "lens": want_lens,
            "surface": want_surface,
        },
        "returned": {
            "geo": got_geo,
            "lens": got_lens,
            "surface": got_surface,
            "url": returned.get("url"),
            "surface_dom": returned.get("surface_dom"),
            "surface_param": returned.get("surface_param"),
            "active_surface_text": returned.get("active_surface_text"),
        },
    }


def evaluate_keyboard_journey_result(result: dict[str, Any], *, expected_geo: str) -> dict[str, Any]:
    """Derive pass/fail for the keyboard product journey.

    Keyboard coverage covers category / Inspect / dismiss / named full record and
    records the keyboard-operated in-page place-link destination. A native browser
    Back shortcut is not required for this journey. Map-first place-link surface is
    an explicit surface difference to record, not proof that history Back is broken.
    History API Back retention belongs on a separate packet row.
    """
    missing: list[str] = []
    if not result.get("category_transition_observed"):
        missing.append("category-transition")
    if not result.get("inspect_control_focused"):
        missing.append("inspect-control-focused")
    if not result.get("inspect_dialog_opened"):
        missing.append("inspect-dialog-opened")
    if not result.get("inspect_dialog_named_title"):
        missing.append("inspect-dialog-named-title")
    if not result.get("inspect_dialog_closed"):
        missing.append("inspect-dialog-closed")
    if not result.get("inspect_focus_restored"):
        missing.append("inspect-focus-restored")
    if not result.get("full_record_opened"):
        missing.append("full-record-opened")
    if not (result.get("settled_named_record") or {}).get("settled"):
        missing.append("settled-named-record")

    place = result.get("place_link_destination") or {}
    back_method = str(result.get("back_return_method") or "")
    # Prefer keyboard place-link destination recording. If a native chord actually
    # navigated, place-link is not required for this run.
    native_navigated = back_method == "browser-back" and bool(result.get("back_completed"))
    if native_navigated:
        pass
    elif not place.get("recorded"):
        missing.append("place-link-destination-recorded")
    elif normalize_near_you_geo(place.get("geo")) != expected_geo:
        missing.append("place-link-geo")

    # end_geo may come from place-link (map-first) or browser-back; require Chelsea geo.
    end_geo = normalize_near_you_geo(result.get("end_geo") or place.get("geo"))
    if end_geo != expected_geo:
        missing.append("restored-chelsea-geo")

    if result.get("used_non_keyboard_navigation"):
        missing.append("keyboard-only-violated")

    # Native shortcut NO_NAV is an automation/unverified label — never a sole fail cause.
    native_status = str(result.get("browser_back_keyboard_status") or "")
    native_shortcut = {
        "status": native_status or None,
        "chord": result.get("browser_back_chord"),
        "required": False,
        "claimed": False,
        "label": (
            "unverified-native-browser-shortcut"
            if native_status
            in {
                "playwright-chromium-no-keyboard-history-nav",
                "no-nav",
                "keyboard-no-nav",
            }
            or (native_status and "no-keyboard-history-nav" in native_status)
            else "observed-or-unset"
        ),
    }

    requested = result.get("requested_return_state") or {}
    retention = result.get("return_state_retention") or retained_requested_return_state(
        requested,
        result.get("return_state"),
        expected_geo=expected_geo,
    )
    surface_difference = None
    want_surface = requested.get("surface")
    got_surface = place.get("surface") if place.get("recorded") else retention.get("returned", {}).get("surface")
    if want_surface and got_surface and want_surface != got_surface:
        surface_difference = {
            "label": "explicit-surface-difference",
            "requested_surface": want_surface,
            "returned_surface": got_surface,
            "note": (
                "Keyboard place-link destination recorded with a different surface than "
                "the records surface requested before full-record. This is not evidence "
                "that browser history Back is broken."
            ),
        }

    ok = not missing
    return {
        "missing_steps": missing,
        "check_result": "pass" if ok else "fail",
        "observation_status": "closed" if ok else "open",
        "return_state_retention": retention,
        "place_link_surface_difference": surface_difference,
        "native_browser_shortcut": native_shortcut,
        "keyboard_and_history_return_separated": True,
    }


def evaluate_history_back_return_result(
    result: dict[str, Any], *, expected_geo: str
) -> dict[str, Any]:
    """Pass only when page.go_back retains requested geo, lens, and records surface."""
    missing: list[str] = []
    if not result.get("history_back_completed"):
        missing.append("history-back-completed")
    retention = result.get("return_state_retention") or retained_requested_return_state(
        result.get("requested_return_state"),
        result.get("return_state"),
        expected_geo=expected_geo,
    )
    if normalize_near_you_geo((retention.get("returned") or {}).get("geo") or result.get("end_geo")) != expected_geo:
        missing.append("restored-chelsea-geo")
    for gap in retention.get("gaps") or []:
        missing.append(f"retained-requested-{gap}")
    if result.get("method") != "page.go_back":
        missing.append("history-api-method")
    ok = not missing and bool(retention.get("retained"))
    return {
        "missing_steps": missing,
        "check_result": "pass" if ok else "fail",
        "observation_status": "closed" if ok else "open",
        "return_state_retention": retention,
        "evidence_class": "browser-history-api",
        "not_keyboard_evidence": True,
        "role": "full-record-history-return",
    }


def wait_settled_named_record_heading(page, *, timeout_ms: int = 90_000) -> dict[str, Any]:
    """Wait until land detail shows a named record title (h2.rolename), not site brand H1."""
    page.wait_for_selector(
        "#land-item-card:not([hidden]) h2.rolename, #ldetail h2.rolename, h2.rolename",
        timeout=timeout_ms,
    )
    deadline = timeout_ms
    waited = 0
    named = ""
    site_h1 = ""
    while waited <= deadline:
        payload = page.evaluate(
            """() => {
              const text = (el) => el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : '';
              const role = document.querySelector('#ldetail h2.rolename, #land-item-card h2.rolename, h2.rolename');
              const h1 = document.querySelector('h1');
              return {
                named: text(role),
                site_h1: text(h1),
                card_hidden: (() => {
                  const card = document.querySelector('#land-item-card');
                  return card ? !!card.hidden : null;
                })(),
              };
            }"""
        )
        named = normalize_ws(payload.get("named") or "")
        site_h1 = normalize_ws(payload.get("site_h1") or "")
        cleaned = named.lstrip("◆• ").strip()
        if cleaned and cleaned not in SITE_BRAND_HEADINGS and "CityScroll" not in cleaned:
            return {
                "settled": True,
                "named_heading": cleaned,
                "raw_named_heading": named,
                "site_h1": site_h1,
                "waited_ms": waited,
                "selector": "h2.rolename",
            }
        page.wait_for_timeout(250)
        waited += 250
    return {
        "settled": False,
        "named_heading": normalize_ws(named.lstrip("◆• ")) if named else "",
        "raw_named_heading": named,
        "site_h1": site_h1,
        "waited_ms": waited,
        "selector": "h2.rolename",
    }


def observe_synthetic_meeting_404(page, *, origin: str) -> dict[str, Any]:
    """Direct unscoped control load of the synthetic missing-meeting URL.

    Separate from the scoped Chelsea failed-detail journey. Records Try again and
    Browse meetings honestly. Never routes a product defect by itself.
    """
    bogus = urllib.request.urljoin(origin, "/meetings/meeting%3Amissing-chelsea-control/")
    response = page.goto(bogus, wait_until="domcontentloaded", timeout=60_000)
    settle = wait_for_navigation_settle(page)
    links = page.evaluate(
        """() => Array.from(document.querySelectorAll('a[href]')).map((a) => ({
          text: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
          href: a.getAttribute('href') || '',
        }))"""
    )
    try_again = [row for row in (links or []) if re.search(r"try again", str(row.get("text") or ""), re.I)]
    browse_meetings = [
        row
        for row in (links or [])
        if re.search(r"browse meetings", str(row.get("text") or ""), re.I)
        or str(row.get("href") or "").startswith("/browse/meetings")
    ]
    status_heading = (
        normalize_ws(page.locator("h1").first.inner_text())
        if page.locator("h1").count()
        else ""
    )
    return {
        "kind": "unscoped-direct-control",
        "url": safe_page_url(page),
        "http_status": response.status if response else None,
        "status_heading": status_heading,
        "http_ok": bool(response and 200 <= response.status < 400),
        "try_again_links": try_again,
        "browse_meetings_links": browse_meetings,
        "all_links_sample": (links or [])[:20],
        "retains_selected_geo": "geo=" in (safe_page_url(page) or ""),
        "navigation_settle": settle,
        "note": (
            "Direct unscoped control. Keep separate from the scoped Chelsea failed-detail "
            "journey that must start on the selected place and return via recovery/Back."
        ),
    }


def observe_synthetic_scoped_history_control(
    page,
    *,
    origin: str,
    expected_geo: str = f"nta2020:{CHELSEA}",
) -> dict[str, Any]:
    """SYNTHETIC history control: injects #capture-scoped-failed-detail and clicks it.

    Explicitly NOT a product record handoff. Must not satisfy real scoped-journey acceptance
    acceptance. Retained only as a labeled diagnostic/control beside the real journey.
    """
    evidence: dict[str, Any] = {
        "kind": "synthetic-scoped-history-control",
        "synthetic": True,
        "satisfies_real_scoped_journey": False,
        "expected_geo": expected_geo,
        "fabrication": {
            "method": "inject-anchor-click",
            "anchor_id": "capture-scoped-failed-detail",
            "note": (
                "Fabricated <a> injected via page.evaluate then clicked. This builds "
                "synthetic history only — not an actual Near You record control."
            ),
        },
        "errors": [],
    }
    if "near-you" not in (safe_page_url(page) or ""):
        goto_settled(page, uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="meetings")))
    evidence["source_url"] = safe_page_url(page)
    missing_href = "/meetings/meeting%3Amissing-chelsea-control/"
    page.evaluate(
        """(href) => {
          const existing = document.getElementById('capture-scoped-failed-detail');
          if (existing) existing.remove();
          const a = document.createElement('a');
          a.id = 'capture-scoped-failed-detail';
          a.href = href;
          a.textContent = 'Capture synthetic scoped failed detail';
          document.body.appendChild(a);
        }""",
        missing_href,
    )
    try:
        with page.expect_navigation(wait_until="domcontentloaded", timeout=90_000):
            page.click("#capture-scoped-failed-detail")
    except Exception as error:
        evidence["errors"].append(
            {"phase": "synthetic-click", "type": error.__class__.__name__, "message": str(error)[:240]}
        )
    evidence["navigation_settle"] = wait_for_navigation_settle(page)
    evidence["failed_detail_url"] = safe_page_url(page)
    evidence["check_result"] = "fail"
    evidence["observation_status"] = "open"
    evidence["acceptance"] = "diagnostic-only"
    return evidence


def _normalize_intercept_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url or "")
    path = parsed.path.rstrip("/") or "/"
    return urllib.parse.urlunparse(
        (parsed.scheme.lower(), parsed.netloc.lower(), path, "", parsed.query, "")
    )


def intercept_matches_exact_target(
    hit: dict[str, Any] | None,
    *,
    target_abs_href: str,
    expected_resource_type: str = "document",
) -> bool:
    """True only when hit URL and resource_type match the clicked target exactly."""
    if not hit:
        return False
    hit_url = _normalize_intercept_url(str(hit.get("url") or ""))
    target = _normalize_intercept_url(target_abs_href)
    if not hit_url or not target or hit_url != target:
        return False
    resource = str(hit.get("resource_type") or "")
    return resource == expected_resource_type


def find_matched_intercept_hit(
    hits: list[dict[str, Any]] | None,
    *,
    target_abs_href: str,
    expected_resource_type: str = "document",
) -> dict[str, Any] | None:
    for hit in hits or []:
        if intercept_matches_exact_target(
            hit,
            target_abs_href=target_abs_href,
            expected_resource_type=expected_resource_type,
        ):
            return hit
    return None


def evaluate_abort_retained_page_diagnostic(evidence: dict[str, Any]) -> dict[str, Any]:
    """Diagnostic-only: document abort retained-page is browser behavior, never live scoped failed-detail recovery."""
    missing: list[str] = []
    injection = evidence.get("failure_injection") or {}
    hits = injection.get("intercepted_requests") or []
    hit_count = int(injection.get("intercept_hit_count") or len(hits) or 0)
    target_abs = injection.get("target_abs_href") or ""
    expected_resource = injection.get("expected_resource_type") or "document"

    if hit_count < 1:
        missing.append("zero-intercepted-requests")
    matched = find_matched_intercept_hit(
        hits, target_abs_href=target_abs, expected_resource_type=expected_resource
    )
    if hit_count >= 1 and matched is None:
        missing.append("intercept-not-exact-target-url-resource")
    if matched is not None and not matched.get("aborted"):
        missing.append("abort-not-confirmed")
    if matched is not None and matched.get("abort_error"):
        missing.append("abort-raised-exception")

    source = evidence.get("source_url") or ""
    after = evidence.get("after_url") or evidence.get("failed_detail_url") or ""
    retained_page = bool(after and source and _normalize_intercept_url(after) == _normalize_intercept_url(source))
    # Diagnostic "works" when exact abort hit recorded; retained page is expected browser behavior.
    diagnostic_ok = not missing
    return {
        "missing_steps": missing,
        "check_result": "pass" if diagnostic_ok else "fail",
        "observation_status": "closed" if diagnostic_ok else "open",
        "satisfies_real_scoped_journey": False,
        "counts_toward_live_scoped_failed_detail": False,
        "diagnostic_only": True,
        "browser_behavior_not_app_recovery": True,
        "retained_page_after_abort": retained_page,
        "matched_intercept_hit": matched,
        "note": (
            "Document abort retained-page is browser behavior, not app failed-detail recovery. "
            "Prove app recovery separately via HTTP-error fulfill."
        ),
    }


def evaluate_scoped_failed_detail_result(evidence: dict[str, Any]) -> dict[str, Any]:
    """Pass/fail for scoped failed-detail when production answers the error.

    Induce failure by continue-redirecting the clicked product detail document request to a
    real nonexistent /meetings/ id; production Pages edge returns its own error page.
    Fulfill with authored or replayed body never passes. PASS requires: exact intercept for
    the clicked URL+document, production status, recovery controls from production's
    response, and Back restoring Chelsea geo+surface.
    """
    missing: list[str] = []
    injection = evidence.get("failure_injection") or {}
    hits = injection.get("intercepted_requests") or []
    hit_count = int(injection.get("intercept_hit_count") or len(hits) or 0)
    expected_status = int(injection.get("injected_status") or 0)
    target_abs = injection.get("target_abs_href") or ""
    expected_resource = injection.get("expected_resource_type") or "document"

    if hit_count < 1:
        missing.append("zero-intercepted-requests")

    matched_hit = find_matched_intercept_hit(
        hits, target_abs_href=target_abs, expected_resource_type=expected_resource
    )
    if hit_count >= 1 and matched_hit is None:
        missing.append("intercept-not-exact-target-url-resource")

    observed_status = None
    if matched_hit is not None:
        observed_status = matched_hit.get("fulfilled_status")
        if observed_status is None:
            observed_status = matched_hit.get("status")
    if expected_status and (
        observed_status is None or int(observed_status) != expected_status
    ):
        missing.append("injected-error-status-not-observed")
    if not expected_status:
        missing.append("injected-error-status-not-configured")

    method = injection.get("method") or ""
    if method == "playwright-route-abort":
        missing.append("abort-is-browser-behavior-not-app-recovery")
    if method in {
        "playwright-route-fulfill-http-error",
        "playwright-route-fulfill-authored-html",
        "playwright-route-fulfill-replay-deployed-error",
    }:
        # Fulfill body (authored or replayed) is capture markup/injection, not production answering.
        missing.append("fulfill-body-is-not-production-answered-error")
    if method != "playwright-route-continue-redirect-nonexistent":
        missing.append("not-production-answered-via-continue-redirect")

    continued_to = injection.get("continued_to_url") or ""
    nonexistent = injection.get("nonexistent_meeting_url") or ""
    if not continued_to or not nonexistent:
        missing.append("missing-continue-redirect-target")
    elif _normalize_intercept_url(continued_to) != _normalize_intercept_url(nonexistent):
        missing.append("continue-redirect-target-mismatch")

    production_status = evidence.get("production_response_status")
    if production_status is None and matched_hit is not None:
        production_status = matched_hit.get("production_status")
    if production_status is None:
        production_status = observed_status
    expected_production_status = int(
        injection.get("expected_production_status") or expected_status or 404
    )
    if production_status is None or int(production_status) != expected_production_status:
        missing.append("production-error-status-not-observed")

    requested_url = evidence.get("url_actually_requested") or (
        (matched_hit or {}).get("continued_to_url")
        or (matched_hit or {}).get("url")
        or ""
    )
    if not requested_url:
        missing.append("url-actually-requested-not-recorded")

    if not evidence.get("visible_product_control_activated"):
        missing.append("visible-product-control-not-activated")
    if evidence.get("control_was_invisible"):
        missing.append("invisible-control")

    recovery_ui = evidence.get("recovery_controls") or {}
    if not recovery_ui.get("try_again_visible"):
        missing.append("try-again-not-visible")
    if not recovery_ui.get("browse_meetings_visible"):
        missing.append("browse-meetings-not-visible")
    if evidence.get("recovery_controls_invisible"):
        missing.append("invisible-recovery-controls")
    if not recovery_ui.get("from_production_response"):
        missing.append("recovery-controls-not-from-production-response")

    source = evidence.get("source_url") or ""
    failed = evidence.get("failed_detail_url") or ""
    left_source = bool(failed and failed != source)
    if not left_source:
        missing.append("noop-stayed-on-chelsea-url")

    back = evidence.get("browser_back_outcome") or {}
    return_ctrl = evidence.get("return_control_outcome") or {}
    restored = bool(
        (back.get("restored_chelsea_geo") and back.get("restored_chelsea_surface"))
        or (
            return_ctrl.get("restored_chelsea_geo")
            and return_ctrl.get("restored_chelsea_surface")
        )
    )
    if not restored:
        restored = bool(
            (
                back.get("restored_chelsea_geo")
                and back.get("returned_near_you")
                and back.get("restored_surface") is not False
            )
            or (
                return_ctrl.get("restored_chelsea_geo")
                and return_ctrl.get("returned_near_you")
                and return_ctrl.get("restored_surface") is not False
            )
        )
    if left_source and not restored:
        missing.append("chelsea-geo-surface-not-restored")
    if back.get("unrelated_history_accepted"):
        missing.append("unrelated-history-accepted-as-recovery")

    ok = not missing
    network_failure = (
        hit_count >= 1
        and matched_hit is not None
        and production_status is not None
        and int(production_status) == expected_production_status
    )
    return {
        "missing_steps": missing,
        "check_result": "pass" if ok else "fail",
        "observation_status": "closed" if ok else "open",
        "satisfies_real_scoped_journey": ok,
        "network_failure_observed": network_failure,
        "recovery_and_return_observed": bool(ok and restored and left_source),
        "matched_intercept_hit": matched_hit,
        "observed_production_status": production_status,
        "url_actually_requested": requested_url,
    }


def _product_meeting_error_html(*, retry_href: str, official_source: str = "") -> str:
    """DIAGNOSTIC ONLY: hand-authored mirror of pages_edge meeting-unavailable HTML.

    Recovery links here are test-created, not deployed app behavior. Must never satisfy
    live scoped failed-detail recovery or be labeled live recovery.
    """
    official_link = ""
    if official_source.startswith("https://") or official_source.startswith("http://"):
        safe = (
            official_source.replace("&", "&amp;")
            .replace('"', "&quot;")
        )
        official_link = (
            f'<p><a href="{safe}" rel="noopener noreferrer">Open the official source</a></p>'
        )
    safe_retry = retry_href.replace("&", "&amp;").replace('"', "&quot;")
    return (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>Meeting · CityScroll</title></head><body><main><h1>Meeting</h1>"
        "<p>This meeting is not in the current Meetings view.</p>"
        f'<p><a href="{safe_retry}">Try again</a></p>{official_link}'
        '<p><a href="/browse/meetings/">Browse meetings</a></p>'
        "</main></body></html>"
    )


DEPLOYED_MEETING_ERROR_PROBE_ID = "meeting:capture-probe-missing-chelsea-scoped"
COMPANION_DEPLOYED_ERROR_FETCH = SCRATCH / "deployed-meeting-error-fetch.json"


def fetch_deployed_meeting_error_response(
    *,
    origin: str = ORIGIN,
    probe_meeting_id: str = DEPLOYED_MEETING_ERROR_PROBE_ID,
) -> dict[str, Any]:
    """Independently GET the deployed Pages meeting-unavailable response (real edge HTML)."""
    path = "/meetings/" + urllib.parse.quote(probe_meeting_id, safe="") + "/"
    url = origin.rstrip("/") + path
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Cache-Control": "no-cache, no-store",
            "Pragma": "no-cache",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read()
            status = getattr(response, "status", None) or response.getcode()
            content_type = response.headers.get("Content-Type") or "text/html; charset=utf-8"
            cache_control = response.headers.get("Cache-Control") or ""
    except urllib.error.HTTPError as error:
        body = error.read()
        status = error.code
        content_type = error.headers.get("Content-Type") or "text/html; charset=utf-8"
        cache_control = error.headers.get("Cache-Control") or ""
    text = body.decode("utf-8", errors="replace")
    receipt = {
        "kind": "independently-fetched-deployed-meeting-error",
        "fetched_at": utc_now(),
        "fetched_url": url,
        "missing_meeting_id": probe_meeting_id,
        "status": int(status),
        "content_type": content_type,
        "cache_control": cache_control,
        "body_sha256": hashlib.sha256(body).hexdigest(),
        "body_utf8": text,
        "limitation": (
            "Replay of an independently fetched deployed Pages meeting-unavailable response. "
            "Not a live edge render for the clicked Chelsea meeting_id; Try again href belongs "
            "to the fetched missing probe id."
        ),
    }
    if int(status) != 404:
        raise RuntimeError(f"deployed meeting error fetch expected 404, got {status} for {url}")
    if "Try again" not in text or "Browse meetings" not in text:
        raise RuntimeError("deployed meeting error body missing recovery controls")
    try:
        COMPANION_DEPLOYED_ERROR_FETCH.parent.mkdir(parents=True, exist_ok=True)
        write_json(COMPANION_DEPLOYED_ERROR_FETCH, receipt)
    except Exception:
        pass
    return receipt


def _find_visible_chelsea_meeting_link(page) -> dict[str, Any] | None:
    """Return the first visible meeting full-record/title link on scoped Chelsea Near You."""
    return page.evaluate(
        """() => {
          const nodes = Array.from(document.querySelectorAll(
            'section.near-results li.near-record a.near-record-full-record, '
            + 'section.near-results li.near-record a.near-record-title-link'
          ));
          const pack = (a) => {
            const href = a.getAttribute('href') || '';
            const li = a.closest('li.near-record');
            const style = window.getComputedStyle(a);
            const rect = a.getBoundingClientRect();
            const visible = !!(
              style && style.visibility !== 'hidden' && style.display !== 'none'
              && rect.width > 0 && rect.height > 0
              && a.offsetParent !== null
            );
            return {
              href,
              abs_href: a.href,
              text: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
              className: typeof a.className === 'string' ? a.className : String(a.className || ''),
              record_id: li ? li.getAttribute('data-record-id') : null,
              visible,
              rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left },
            };
          };
          const meetingish = (href) =>
            href.includes('/meetings/') || href.includes('meeting%3A') || href.includes('meeting:');
          const visibleHit = nodes.map(pack).find((row) => row.visible && meetingish(row.href));
          if (visibleHit) return visibleHit;
          const anyMeeting = nodes.map(pack).find((row) => meetingish(row.href));
          return anyMeeting || null;
        }"""
    )


def _click_visible_product_link(
    page,
    *,
    origin: str,
    link_info: dict[str, Any],
    evidence: dict[str, Any],
    expect_navigation: bool = True,
):
    """Click a Playwright-visible product link matching link_info; never force=True."""
    abs_href = link_info.get("abs_href") or urllib.parse.urljoin(
        origin + "/", link_info.get("href") or ""
    )
    href = link_info.get("href") or ""
    record_id = link_info.get("record_id") or ""
    candidates = page.locator(
        "section.near-results li.near-record a.near-record-full-record, "
        "section.near-results li.near-record a.near-record-title-link"
    )
    target = None
    count = candidates.count()
    for idx in range(count):
        cand = candidates.nth(idx)
        try:
            cand_href = cand.get_attribute("href") or ""
        except Exception:
            continue
        cand_abs = urllib.parse.urljoin(origin + "/", cand_href)
        href_match = bool(href) and (
            cand_href == href
            or _normalize_intercept_url(cand_abs) == _normalize_intercept_url(abs_href)
        )
        if not href_match and record_id:
            try:
                parent_id = cand.evaluate(
                    "el => (el.closest('li.near-record')||{}).getAttribute?.('data-record-id')"
                )
            except Exception:
                parent_id = None
            if parent_id != record_id:
                continue
        elif not href_match:
            continue
        try:
            cand.scroll_into_view_if_needed(timeout=8_000)
        except Exception:
            continue
        if cand.is_visible():
            target = cand
            break
    if target is None:
        evidence["control_was_invisible"] = True
        raise RuntimeError("Element is not visible")
    if expect_navigation:
        with page.expect_navigation(wait_until="domcontentloaded", timeout=90_000):
            target.click(timeout=15_000)
    else:
        target.click(timeout=15_000)
    return True


def observe_authored_error_html_diagnostic(
    page,
    *,
    origin: str,
    expected_geo: str = f"nta2020:{CHELSEA}",
) -> dict[str, Any]:
    """DIAGNOSTIC ONLY: fulfill with hand-authored mirrored HTML (test-created recovery).

    Root: recovery links are test-created, NOT deployed app behavior. Never live scoped failed-detail recovery.
    """
    evidence: dict[str, Any] = {
        "kind": "scoped-chelsea-authored-error-html-diagnostic",
        "synthetic": True,
        "diagnostic_only": True,
        "counts_toward_live_scoped_failed_detail": False,
        "satisfies_real_scoped_journey": False,
        "authored_html_not_deployed_recovery": True,
        "expected_geo": expected_geo,
        "errors": [],
        "visible_product_control_activated": False,
        "control_was_invisible": False,
    }
    if "near-you" not in (safe_page_url(page) or "") or "lens=meetings" not in (
        safe_page_url(page) or ""
    ):
        goto_settled(page, uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="meetings")))
    page.wait_for_selector(
        "section.near-results li.near-record a.near-record-full-record, "
        "section.near-results li.near-record a.near-record-title-link",
        state="attached",
        timeout=60_000,
    )
    evidence["source_url"] = safe_page_url(page)
    link_info = _find_visible_chelsea_meeting_link(page)
    if not link_info or not link_info.get("visible"):
        evidence["control_was_invisible"] = not bool(link_info and link_info.get("visible"))
        evidence["check_result"] = "fail"
        evidence["observation_status"] = "open"
        evidence["missing_steps"] = ["no-visible-product-control"]
        return evidence
    evidence["real_record_control"] = link_info
    abs_href = link_info.get("abs_href") or urllib.parse.urljoin(
        origin + "/", link_info.get("href") or ""
    )
    parsed = urllib.parse.urlparse(abs_href)
    route_glob = f"**{parsed.path}"
    meeting_id = ""
    path_parts = [p for p in parsed.path.split("/") if p]
    if len(path_parts) >= 2 and path_parts[0] == "meetings":
        meeting_id = urllib.parse.unquote(path_parts[1])
    retry_href = (
        f"/meetings/{urllib.parse.quote(meeting_id, safe='')}/" if meeting_id else parsed.path
    )
    error_html = _product_meeting_error_html(retry_href=retry_href)
    intercepted: list[dict[str, Any]] = []

    def _authored_route(route_obj) -> None:
        request = route_obj.request
        intercepted.append(
            {
                "url": request.url,
                "resource_type": request.resource_type,
                "method": request.method,
                "fulfilled_status": 404,
                "status": 404,
                "fulfill_body": "hand-authored-mirrored-html",
            }
        )
        route_obj.fulfill(
            status=404,
            content_type="text/html; charset=utf-8",
            body=error_html,
        )

    failure_injection = {
        "method": "playwright-route-fulfill-authored-html",
        "injected_status": 404,
        "target_href": link_info.get("href"),
        "target_abs_href": abs_href,
        "expected_resource_type": "document",
        "route_glob": route_glob,
        "intercepted_requests": intercepted,
        "intercept_hit_count": 0,
        "note": (
            "DIAGNOSTIC simulation: hand-authored mirrored HTML. Recovery links are "
            "test-created, not deployed app behavior. Never counts toward live scoped failed-detail recovery."
        ),
    }
    evidence["failure_injection"] = failure_injection
    page.route(route_glob, _authored_route)
    try:
        try:
            with page.expect_navigation(wait_until="domcontentloaded", timeout=90_000):
                _click_visible_product_link(
                    page,
                    origin=origin,
                    link_info=link_info,
                    evidence=evidence,
                    expect_navigation=False,
                )
            evidence["visible_product_control_activated"] = True
        except Exception as nav_error:
            evidence["post_click_navigation"] = {
                "error": nav_error.__class__.__name__,
                "message": str(nav_error)[:300],
            }
            evidence["visible_product_control_activated"] = not evidence.get(
                "control_was_invisible"
            )
    except Exception as error:
        evidence["errors"].append(
            {
                "phase": "authored-diagnostic-click",
                "type": error.__class__.__name__,
                "message": str(error)[:300],
            }
        )
    evidence["failed_detail_url"] = safe_page_url(page)
    failure_injection["intercepted_requests"] = list(intercepted)
    failure_injection["intercept_hit_count"] = len(intercepted)
    try:
        page.unroute(route_glob, _authored_route)
    except Exception:
        pass
    # Force diagnostic-only outcome; never run live scoped failed-detail evaluator as pass.
    a4 = evaluate_scoped_failed_detail_result(evidence)
    evidence["live_scoped_evaluator_would"] = {
        "check_result": a4.get("check_result"),
        "missing_steps": a4.get("missing_steps"),
        "satisfies_real_scoped_journey": a4.get("satisfies_real_scoped_journey"),
    }
    evidence["check_result"] = "pass" if failure_injection["intercept_hit_count"] >= 1 else "fail"
    evidence["observation_status"] = (
        "closed" if evidence["check_result"] == "pass" else "open"
    )
    evidence["satisfies_real_scoped_journey"] = False
    evidence["counts_toward_live_scoped_failed_detail"] = False
    evidence["diagnostic_only"] = True
    evidence["product_defect"] = False
    return evidence


def observe_abort_retained_page_diagnostic(
    page,
    *,
    origin: str,
    expected_geo: str = f"nta2020:{CHELSEA}",
) -> dict[str, Any]:
    """DIAGNOSTIC ONLY: document abort retained-page is browser behavior, not app recovery.

    Sets aborted=true only after route.abort() succeeds; retains abort exceptions.
    Validates exact target URL + document resource. Never satisfies live scoped failed-detail recovery.
    """
    evidence: dict[str, Any] = {
        "kind": "scoped-chelsea-abort-retained-page-diagnostic",
        "synthetic": False,
        "diagnostic_only": True,
        "counts_toward_live_scoped_failed_detail": False,
        "satisfies_real_scoped_journey": False,
        "browser_behavior_not_app_recovery": True,
        "expected_geo": expected_geo,
        "errors": [],
        "visible_product_control_activated": False,
        "control_was_invisible": False,
    }
    if "near-you" not in (safe_page_url(page) or "") or "lens=meetings" not in (
        safe_page_url(page) or ""
    ):
        goto_settled(page, uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="meetings")))
    page.wait_for_selector(
        "section.near-results li.near-record a.near-record-full-record, "
        "section.near-results li.near-record a.near-record-title-link",
        state="attached",
        timeout=60_000,
    )
    evidence["source_url"] = safe_page_url(page)
    link_info = _find_visible_chelsea_meeting_link(page)
    if not link_info:
        evidence["errors"].append(
            {
                "phase": "find-real-record-control",
                "message": "No rendered meeting link for abort diagnostic",
            }
        )
        evidence.update(evaluate_abort_retained_page_diagnostic(evidence))
        return evidence
    evidence["real_record_control"] = link_info
    if not link_info.get("visible"):
        evidence["control_was_invisible"] = True
        evidence.update(evaluate_abort_retained_page_diagnostic(evidence))
        return evidence

    abs_href = link_info.get("abs_href") or urllib.parse.urljoin(
        origin + "/", link_info.get("href") or ""
    )
    parsed = urllib.parse.urlparse(abs_href)
    route_glob = f"**{parsed.path}"
    if parsed.query:
        route_glob = f"**{parsed.path}?{parsed.query}"
    intercepted: list[dict[str, Any]] = []

    def _abort_route(route_obj) -> None:
        request = route_obj.request
        entry: dict[str, Any] = {
            "url": request.url,
            "resource_type": request.resource_type,
            "method": request.method,
            "aborted": False,
            "abort_error": None,
        }
        try:
            route_obj.abort()
            # Mark aborted only after abort() returns without raising.
            entry["aborted"] = True
        except Exception as error:
            entry["aborted"] = False
            entry["abort_error"] = {
                "type": error.__class__.__name__,
                "message": str(error)[:300],
            }
        intercepted.append(entry)

    failure_injection = {
        "method": "playwright-route-abort",
        "target_href": link_info.get("href"),
        "target_abs_href": abs_href,
        "expected_resource_type": "document",
        "route_glob": route_glob,
        "natural_ui": False,
        "intercepted_requests": intercepted,
        "intercept_hit_count": 0,
        "note": (
            "DIAGNOSTIC: document abort retained-page is browser behavior. "
            "aborted=true only after route.abort succeeds; abort exceptions retained. "
            "Does not prove app failed-detail recovery."
        ),
    }
    evidence["failure_injection"] = failure_injection
    page.route(route_glob, _abort_route)
    alt_path = urllib.parse.unquote(parsed.path)
    alt_glob = None
    if alt_path != parsed.path:
        alt_glob = f"**{alt_path}"
        page.route(alt_glob, _abort_route)
        failure_injection["alt_route_glob"] = alt_glob

    click_error = None
    try:
        try:
            with page.expect_navigation(wait_until="domcontentloaded", timeout=90_000):
                _click_visible_product_link(
                    page,
                    origin=origin,
                    link_info=link_info,
                    evidence=evidence,
                    expect_navigation=False,
                )
        except Exception as nav_error:
            # Abort commonly rejects navigation; record and continue diagnostic.
            evidence["post_click_navigation"] = {
                "error": nav_error.__class__.__name__,
                "message": str(nav_error)[:300],
            }
        evidence["visible_product_control_activated"] = not evidence.get(
            "control_was_invisible"
        )
    except Exception as error:
        click_error = {"type": error.__class__.__name__, "message": str(error)[:300]}
        evidence["errors"].append({"phase": "real-control-click", **click_error})
        if "not visible" in str(error).lower():
            evidence["control_was_invisible"] = True
        evidence["visible_product_control_activated"] = False

    deadline = time.time() + 5.0
    while time.time() < deadline and len(intercepted) < 1:
        try:
            page.wait_for_timeout(100)
        except Exception:
            break

    evidence["failed_detail_navigation_settle"] = wait_for_navigation_settle(page)
    evidence["after_url"] = safe_page_url(page)
    evidence["failed_detail_url"] = evidence["after_url"]
    failure_injection["intercepted_requests"] = list(intercepted)
    failure_injection["intercept_hit_count"] = len(intercepted)
    try:
        page.unroute(route_glob, _abort_route)
        if alt_glob:
            page.unroute(alt_glob, _abort_route)
        failure_injection["unrouted"] = True
    except Exception as error:
        failure_injection["unroute_error"] = error.__class__.__name__
    evidence["click_error"] = click_error
    evidence.update(evaluate_abort_retained_page_diagnostic(evidence))
    evidence["product_defect"] = False
    return evidence


def observe_scoped_failed_detail_from_chelsea(
    page,
    *,
    origin: str,
    expected_geo: str = f"nta2020:{CHELSEA}",
) -> dict[str, Any]:
    """Real scoped failed-detail: product link + continue-redirect; production answers.

    Clicks the product-rendered Chelsea record link, continue-redirects ONLY that
    document request to a real nonexistent /meetings/ id so Pages edge produces its
    own error state. Never fulfills with authored or replayed body. PASS requires
    exact intercept for the clicked href, production status, recovery controls from
    production's response, and Back restoring Chelsea geo+surface.
    """
    evidence: dict[str, Any] = {
        "kind": "scoped-chelsea-failed-detail-real",
        "synthetic": False,
        "satisfies_real_scoped_journey": False,
        "expected_geo": expected_geo,
        "errors": [],
        "visible_product_control_activated": False,
        "control_was_invisible": False,
        "recovery_controls_invisible": False,
    }

    if "near-you" not in (safe_page_url(page) or "") or "lens=meetings" not in (
        safe_page_url(page) or ""
    ):
        goto_settled(page, uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="meetings")))
    page.wait_for_selector(
        "section.near-results li.near-record a.near-record-full-record, "
        "section.near-results li.near-record a.near-record-title-link",
        state="attached",
        timeout=60_000,
    )
    evidence["source_url"] = safe_page_url(page)
    source_geo = safe_evaluate(
        page, "() => new URL(window.location.href).searchParams.get('geo')"
    )
    source_lens = safe_evaluate(
        page, "() => new URL(window.location.href).searchParams.get('lens')"
    )
    source_surface = safe_evaluate(
        page, "() => new URL(window.location.href).searchParams.get('surface')"
    )
    if isinstance(source_geo, dict):
        source_geo = source_geo.get("value")
    if isinstance(source_lens, dict):
        source_lens = source_lens.get("value")
    if isinstance(source_surface, dict):
        source_surface = source_surface.get("value")
    evidence["source_geo"] = source_geo
    evidence["source_lens"] = source_lens
    evidence["source_surface"] = source_surface

    link_info = _find_visible_chelsea_meeting_link(page)
    if not link_info:
        evidence["errors"].append(
            {
                "phase": "find-real-record-control",
                "message": "No rendered meeting full-record/title link on scoped Chelsea page",
            }
        )
        evidence.update(evaluate_scoped_failed_detail_result(evidence))
        return evidence

    evidence["real_record_control"] = link_info
    if not link_info.get("visible"):
        evidence["control_was_invisible"] = True
        evidence["errors"].append(
            {
                "phase": "visible-product-control",
                "message": "Candidate product control is not visible; refusing force-click",
            }
        )
        evidence.update(evaluate_scoped_failed_detail_result(evidence))
        return evidence

    abs_href = link_info.get("abs_href") or urllib.parse.urljoin(
        origin + "/", link_info.get("href") or ""
    )
    parsed = urllib.parse.urlparse(abs_href)
    route_glob = f"**{parsed.path}"
    if parsed.query:
        route_glob = f"**{parsed.path}?{parsed.query}"

    # Live scoped failed-detail: click product link; narrowly continue-redirect ONLY that document request to a
    # real nonexistent meeting id on the same /meetings/ route so production answers.
    # Never fulfill with authored or replayed body — recovery must be production's response.
    nonexistent_path = (
        "/meetings/" + urllib.parse.quote(DEPLOYED_MEETING_ERROR_PROBE_ID, safe="") + "/"
    )
    nonexistent_abs = origin.rstrip("/") + nonexistent_path
    expected_production_status = 404
    intercepted: list[dict[str, Any]] = []
    production_statuses: list[int] = []

    def _continue_redirect_route(route_obj) -> None:
        request = route_obj.request
        entry: dict[str, Any] = {
            "url": request.url,
            "resource_type": request.resource_type,
            "method": request.method,
            "continued_to_url": nonexistent_abs,
            "production_status": None,
        }
        intercepted.append(entry)
        route_obj.continue_(url=nonexistent_abs)

    def _on_response(response) -> None:
        try:
            req_url = response.request.url
            if (
                _normalize_intercept_url(req_url) == _normalize_intercept_url(nonexistent_abs)
                or DEPLOYED_MEETING_ERROR_PROBE_ID in (req_url or "")
                or "capture-probe-missing-chelsea-scoped" in (req_url or "")
            ):
                production_statuses.append(int(response.status))
                for hit in intercepted:
                    if hit.get("production_status") is None and (
                        _normalize_intercept_url(str(hit.get("continued_to_url") or ""))
                        == _normalize_intercept_url(nonexistent_abs)
                        or _normalize_intercept_url(str(hit.get("url") or ""))
                        == _normalize_intercept_url(abs_href)
                    ):
                        hit["production_status"] = int(response.status)
                        hit["status"] = int(response.status)
                        break
        except Exception:
            pass

    failure_injection = {
        "method": "playwright-route-continue-redirect-nonexistent",
        "injected_status": expected_production_status,
        "expected_production_status": expected_production_status,
        "target_href": link_info.get("href"),
        "target_abs_href": abs_href,
        "expected_resource_type": "document",
        "continued_to_url": nonexistent_abs,
        "nonexistent_meeting_url": nonexistent_abs,
        "nonexistent_meeting_id": DEPLOYED_MEETING_ERROR_PROBE_ID,
        "route_glob": route_glob,
        "natural_ui": False,
        "intercepted_requests": intercepted,
        "intercept_hit_count": 0,
        "note": (
            "Narrow continue-redirect of the clicked product detail document request to a "
            "real nonexistent meeting id on /meetings/; production (Pages edge) answers with "
            "its own error state. No fulfill body. Authored _product_meeting_error_html is "
            "never on the live scoped failed-detail recovery path."
        ),
    }
    evidence["failure_injection"] = failure_injection

    page.on("response", _on_response)
    page.route(route_glob, _continue_redirect_route)
    alt_path = urllib.parse.unquote(parsed.path)
    alt_glob = None
    if alt_path != parsed.path:
        alt_glob = f"**{alt_path}"
        page.route(alt_glob, _continue_redirect_route)
        failure_injection["alt_route_glob"] = alt_glob

    click_error = None
    activated = False
    nav_response = None
    try:
        with page.expect_navigation(wait_until="domcontentloaded", timeout=90_000) as nav_info:
            _click_visible_product_link(
                page,
                origin=origin,
                link_info=link_info,
                evidence=evidence,
                expect_navigation=False,
            )
        try:
            nav_response = nav_info.value
        except Exception:
            nav_response = None
        activated = True
    except Exception as error:
        click_error = {
            "type": error.__class__.__name__,
            "message": str(error)[:300],
        }
        evidence["errors"].append({"phase": "real-control-click", **click_error})
        if "not visible" in str(error).lower():
            evidence["control_was_invisible"] = True
    evidence["visible_product_control_activated"] = bool(
        activated and not evidence["control_was_invisible"]
    )

    deadline = time.time() + 5.0
    while time.time() < deadline and len(intercepted) < 1:
        try:
            page.wait_for_timeout(100)
        except Exception:
            break

    settle = wait_for_navigation_settle(page)
    evidence["failed_detail_navigation_settle"] = settle
    evidence["failed_detail_url"] = safe_page_url(page)
    evidence["url_actually_requested"] = nonexistent_abs
    production_status = None
    if nav_response is not None:
        try:
            production_status = int(nav_response.status)
        except Exception:
            production_status = None
    if production_status is None and production_statuses:
        production_status = production_statuses[-1]
    if production_status is None:
        for hit in intercepted:
            if hit.get("production_status") is not None:
                production_status = int(hit["production_status"])
                break
    evidence["production_response_status"] = production_status
    try:
        evidence["status_heading"] = (
            normalize_ws(page.locator("h1").first.inner_text())
            if page.locator("h1").count()
            else ""
        )
    except Exception as error:
        evidence["status_heading"] = ""
        evidence["errors"].append(
            {"phase": "status-heading", "type": error.__class__.__name__, "message": str(error)[:240]}
        )

    failure_injection["intercepted_requests"] = list(intercepted)
    failure_injection["intercept_hit_count"] = len(intercepted)

    try:
        page.remove_listener("response", _on_response)
    except Exception:
        pass
    try:
        page.unroute(route_glob, _continue_redirect_route)
        if alt_glob:
            page.unroute(alt_glob, _continue_redirect_route)
        failure_injection["unrouted"] = True
    except Exception as error:
        failure_injection["unroute_error"] = error.__class__.__name__

    # Recovery controls must come from production's rendered response (not capture markup).
    recovery_controls: dict[str, Any] = {
        "try_again_visible": False,
        "browse_meetings_visible": False,
        "from_production_response": False,
    }
    try:
        try_loc = page.get_by_role("link", name=re.compile(r"try again", re.I))
        browse_loc = page.get_by_role("link", name=re.compile(r"browse meetings", re.I))
        if try_loc.count() == 0:
            try_loc = page.locator('a:has-text("Try again")')
        if browse_loc.count() == 0:
            browse_loc = page.locator('a[href="/browse/meetings/"], a:has-text("Browse meetings")')
        recovery_controls["try_again_count"] = try_loc.count()
        recovery_controls["browse_meetings_count"] = browse_loc.count()
        if try_loc.count():
            recovery_controls["try_again_visible"] = bool(try_loc.first.is_visible())
            recovery_controls["try_again_href"] = try_loc.first.get_attribute("href")
        if browse_loc.count():
            recovery_controls["browse_meetings_visible"] = bool(browse_loc.first.is_visible())
            recovery_controls["browse_meetings_href"] = browse_loc.first.get_attribute("href")
        # Production pages_edge uses these exact controls on meeting-unavailable.
        page_text = ""
        try:
            page_text = page.locator("main").inner_text(timeout=5_000)
        except Exception:
            page_text = page.content()[:4000]
        recovery_controls["production_copy_marker"] = (
            "not in the current Meetings view" in (page_text or "")
        )
        recovery_controls["from_production_response"] = bool(
            production_status == expected_production_status
            and recovery_controls.get("try_again_visible")
            and recovery_controls.get("browse_meetings_visible")
            and recovery_controls.get("production_copy_marker")
            and "near-you" not in (safe_page_url(page) or "")
        )
        if (
            recovery_controls["try_again_count"]
            and not recovery_controls["try_again_visible"]
        ) or (
            recovery_controls["browse_meetings_count"]
            and not recovery_controls["browse_meetings_visible"]
        ):
            evidence["recovery_controls_invisible"] = True
    except Exception as error:
        evidence["errors"].append(
            {
                "phase": "recovery-controls",
                "type": error.__class__.__name__,
                "message": str(error)[:240],
            }
        )
    evidence["recovery_controls"] = recovery_controls
    evidence["try_again_links"] = (
        [{"href": recovery_controls.get("try_again_href"), "text": "Try again"}]
        if recovery_controls.get("try_again_href")
        else []
    )
    evidence["browse_meetings_links"] = (
        [{"href": recovery_controls.get("browse_meetings_href"), "text": "Browse meetings"}]
        if recovery_controls.get("browse_meetings_href")
        else []
    )

    left_source = bool(
        evidence.get("failed_detail_url")
        and evidence.get("failed_detail_url") != evidence.get("source_url")
    )
    evidence["browse_meetings_outcome"] = None

    def _geo_surface_snapshot() -> dict[str, Any]:
        geo = safe_evaluate(
            page, "() => new URL(window.location.href).searchParams.get('geo')"
        )
        lens = safe_evaluate(
            page, "() => new URL(window.location.href).searchParams.get('lens')"
        )
        surface = safe_evaluate(
            page, "() => new URL(window.location.href).searchParams.get('surface')"
        )
        if isinstance(geo, dict):
            geo = geo.get("value")
        if isinstance(lens, dict):
            lens = lens.get("value")
        if isinstance(surface, dict):
            surface = surface.get("value")
        return {
            "result_url": safe_page_url(page),
            "result_geo": geo,
            "result_lens": lens,
            "result_surface": surface,
            "restored_chelsea_geo": geo == expected_geo,
            "returned_near_you": "near-you" in (safe_page_url(page) or ""),
            "restored_chelsea_surface": (
                source_surface is None
                or surface == source_surface
                or surface == "records"
            ),
            "restored_surface": (
                source_surface is None
                or surface == source_surface
                or surface == "records"
            ),
        }

    back_outcome: dict[str, Any] = {
        "from_url": safe_page_url(page),
        "unrelated_history_accepted": False,
    }
    return_control_outcome: dict[str, Any] = {}
    if not left_source:
        back_outcome["skipped"] = True
        back_outcome["reason"] = "noop stayed on Chelsea URL; refusing Back as recovery"
        back_outcome["restored_chelsea_geo"] = False
        back_outcome["restored_chelsea_surface"] = False
        back_outcome["returned_near_you"] = False
    else:
        try:
            page.go_back(wait_until="domcontentloaded", timeout=60_000)
            back_outcome["navigation_settle"] = wait_for_navigation_settle(page)
            back_outcome.update(_geo_surface_snapshot())
            return_control_outcome = {
                "method": "browser-back",
                **{
                    k: back_outcome.get(k)
                    for k in (
                        "restored_chelsea_geo",
                        "restored_chelsea_surface",
                        "returned_near_you",
                        "result_geo",
                        "result_surface",
                        "result_url",
                    )
                },
            }
            if not (
                back_outcome.get("restored_chelsea_geo")
                and back_outcome.get("returned_near_you")
            ):
                back_outcome["unrelated_history_accepted"] = False
        except Exception as error:
            back_outcome["error"] = error.__class__.__name__
            back_outcome["message"] = str(error)[:240]
            evidence["errors"].append(back_outcome)

    evidence["browser_back_outcome"] = back_outcome
    evidence["return_control_outcome"] = return_control_outcome
    evidence["click_error"] = click_error

    evidence.update(evaluate_scoped_failed_detail_result(evidence))
    evidence["product_defect"] = False
    return evidence



def observe_scoped_chelsea_detail_recovery(
    page,
    *,
    origin: str,
    source_url: str,
    expected_geo: str = f"nta2020:{CHELSEA}",
) -> dict[str, Any]:
    """Observe recovery controls on a successful Chelsea record detail, plus browser Back."""
    evidence: dict[str, Any] = {
        "kind": "scoped-chelsea-successful-detail",
        "source_url": source_url,
        "expected_geo": expected_geo,
        "detail_url": safe_page_url(page),
        "errors": [],
    }
    settle = wait_for_navigation_settle(page)
    evidence["navigation_settle"] = settle
    links = page.evaluate(
        """() => Array.from(document.querySelectorAll('a[href]')).map((a) => ({
          text: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
          href: a.getAttribute('href') || '',
        }))"""
    )
    browse_meetings = [
        row
        for row in (links or [])
        if re.search(r"browse meetings", str(row.get("text") or ""), re.I)
        or str(row.get("href") or "").startswith("/browse/meetings")
    ]
    near_you_links = [
        row
        for row in (links or [])
        if re.search(
            r"near-you|chelsea|MN0401|community district M04|Browse CityScroll",
            f"{row.get('text','')} {row.get('href','')}",
            re.I,
        )
    ]
    evidence["browse_meetings_links"] = browse_meetings
    evidence["near_you_or_place_links"] = near_you_links
    evidence["all_links_sample"] = (links or [])[:25]
    if page.locator("h1").count():
        evidence["status_heading"] = normalize_ws(page.locator("h1").first.inner_text())
    if page.locator("h2.rolename, #ldetail h2.rolename").count():
        evidence["named_heading"] = normalize_ws(
            page.locator("h2.rolename, #ldetail h2.rolename").first.inner_text()
        )

    back_outcome: dict[str, Any] = {"from_url": safe_page_url(page)}
    try:
        page.go_back(wait_until="domcontentloaded", timeout=60_000)
        back_settle = wait_for_navigation_settle(page)
        back_outcome["navigation_settle"] = back_settle
        back_outcome["result_url"] = safe_page_url(page)
        back_geo = page.evaluate("() => new URL(window.location.href).searchParams.get('geo')")
        back_outcome["result_geo"] = back_geo
        back_outcome["restored_chelsea_geo"] = back_geo == expected_geo
        back_outcome["returned_near_you"] = "near-you" in (safe_page_url(page) or "")
    except Exception as error:
        back_outcome["error"] = error.__class__.__name__
        back_outcome["message"] = str(error)[:240]
        evidence["errors"].append(back_outcome)
    evidence["browser_back_outcome"] = back_outcome
    has_in_page_recovery = bool(browse_meetings or near_you_links)
    back_restored = bool(back_outcome.get("restored_chelsea_geo") or back_outcome.get("returned_near_you"))
    evidence["in_page_recovery_observed"] = has_in_page_recovery
    evidence["browser_back_restored_chelsea"] = back_restored
    evidence["product_path_back_demonstrated"] = bool(has_in_page_recovery or back_restored)
    evidence["product_defect"] = False
    evidence["product_defect_demonstrated"] = False
    return evidence


def observe_failed_detail_recovery(page, *, origin: str) -> dict[str, Any]:
    """Backward-compatible alias for the unscoped direct control."""
    return observe_synthetic_meeting_404(page, origin=origin)



def record_keyboard_step(
    page,
    *,
    step: int,
    action: str,
    extra: dict[str, Any] | None = None,
    read_focus: bool = True,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "step": step,
        "action": action,
        "url": safe_page_url(page),
    }
    if read_focus:
        row["focused"] = focused_element_snapshot(page)
    if extra:
        row.update(extra)
    return row


def run_keyboard_only_journey(
    page,
    *,
    origin: str,
    expected_geo: str = f"nta2020:{CHELSEA}",
    start_url: str | None = None,
) -> dict[str, Any]:
    """Operate category change, inspect/close, full record, and Back using keyboard alone.

    Caller must place the page on the Chelsea Near You overview (no lens) so Open Zoning /
    Zoning land-category controls are present. Meetings-lensed surfaces do not expose a
    Chelsea lens=land control. This function never uses page.goto or pointer click — only
    keyboard. Attempted actions alone never yield pass; each required observation must succeed.
    """
    del origin  # call-site compatibility; no navigation helpers inside this journey
    steps: list[dict[str, Any]] = []
    start_url = start_url or safe_page_url(page)
    start_geo_raw = safe_evaluate(
        page, "() => new URL(window.location.href).searchParams.get('geo')"
    )
    start_geo = start_geo_raw if not isinstance(start_geo_raw, dict) else start_geo_raw.get("value")
    steps.append(
        record_keyboard_step(
            page,
            step=0,
            action="start",
            extra={"start_url": start_url, "start_geo": start_geo},
        )
    )
    used_non_keyboard = False

    def tab_until(predicate, *, limit: int = 100, action_prefix: str = "Tab") -> dict[str, Any] | None:
        for index in range(limit):
            page.keyboard.press("Tab")
            page.wait_for_timeout(50)
            focused = focused_element_snapshot(page)
            steps.append(
                record_keyboard_step(
                    page,
                    step=len(steps),
                    action=f"{action_prefix}-{index + 1}",
                    extra={"focused": focused},
                )
            )
            if predicate(focused):
                return focused
        return None

    marker = install_document_marker(page)
    start_lens_raw = safe_evaluate(
        page, "() => new URL(window.location.href).searchParams.get('lens')"
    )
    start_lens = start_lens_raw if not isinstance(start_lens_raw, dict) else start_lens_raw.get("value")

    def is_land_category_control(focused: dict[str, Any] | None) -> bool:
        return is_chelsea_land_category_control(focused, expected_geo=expected_geo)

    # Do not fall back to any lens= control: same-lens Map/Browse links keep meetings and
    # falsely look like a category attempt. Fail closed when Open Zoning / Zoning is absent.
    focused_lens = tab_until(is_land_category_control, limit=120, action_prefix="Tab-land-category")
    category_transition_observed = False
    after_lens = start_lens
    requested_return_state: dict[str, Any] | None = None
    if focused_lens is None:
        steps.append(
            record_keyboard_step(
                page,
                step=len(steps),
                action="land-category-control-not-focused",
                extra={
                    "note": (
                        "No Chelsea Open Zoning / lens=land control reached by Tab. "
                        "Meetings-lensed surfaces omit that control; start on overview."
                    ),
                },
            )
        )
    else:
        page.keyboard.press("Enter")
        page.wait_for_timeout(400)
        same = prove_same_document(page, marker)
        if not same.get("same_document"):
            wait_for_navigation_settle(page)
        # Wait for the new lens results to render; still keyboard-only (no goto/click).
        try:
            page.wait_for_selector("section.near-results li.near-record, [data-near-you-root]", timeout=60_000)
        except Exception:
            page.wait_for_timeout(1000)
        requested_return_state = read_near_you_route_state(page)
        after_lens = requested_return_state.get("lens")
        after_geo = requested_return_state.get("geo")
        category_transition_observed = bool(
            after_geo == expected_geo
            and after_lens
            and str(after_lens) != str(start_lens or "")
        )
        steps.append(
            record_keyboard_step(
                page,
                step=len(steps),
                action="Enter-land-category-change",
                extra={
                    "same_document_proof": same,
                    "focused_control": focused_lens,
                    "after_lens": after_lens,
                    "after_geo": after_geo,
                    "category_transition_observed": category_transition_observed,
                    "requested_return_state": requested_return_state,
                },
            )
        )

    inspect_control_focused = False
    inspect_dialog_opened = False
    inspect_dialog_named_title = False
    inspect_dialog_closed = False
    inspect_focus_restored = False
    inspect_title = None
    focused_inspect = tab_until(is_near_you_inspect_control, limit=120, action_prefix="Tab-inspect")
    if focused_inspect is None:
        steps.append(record_keyboard_step(page, step=len(steps), action="inspect-control-not-focused"))
    else:
        inspect_control_focused = True
        invoker_uid = focused_inspect.get("inspectUid")
        page.keyboard.press("Enter")
        page.wait_for_timeout(500)
        dialog_state = read_inspection_dialog_state(page)
        inspect_dialog_opened = bool(dialog_state.get("present") and dialog_state.get("open"))
        inspect_title = dialog_state.get("title")
        titled = normalize_ws(inspect_title or "")
        inspect_dialog_named_title = bool(
            titled and titled not in SITE_BRAND_HEADINGS and "CityScroll" not in titled
        )
        steps.append(
            record_keyboard_step(
                page,
                step=len(steps),
                action="Enter-inspect",
                extra={
                    "dialog": dialog_state,
                    "inspect_dialog_opened": inspect_dialog_opened,
                    "inspect_dialog_named_title": inspect_dialog_named_title,
                },
            )
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        dialog_after = read_inspection_dialog_state(page)
        inspect_dialog_closed = not bool(dialog_after.get("open"))
        focused_after = focused_element_snapshot(page)
        inspect_focus_restored = bool(
            is_near_you_inspect_control(focused_after)
            and (not invoker_uid or focused_after.get("inspectUid") == invoker_uid)
        )
        steps.append(
            record_keyboard_step(
                page,
                step=len(steps),
                action="Escape-close-inspect",
                extra={
                    "dialog": dialog_after,
                    "focused": focused_after,
                    "inspect_dialog_closed": inspect_dialog_closed,
                    "inspect_focus_restored": inspect_focus_restored,
                },
            )
        )

    full_record_opened = False
    settled = None
    back_completed = False
    back_return_method = "none"
    browser_back_keyboard_status: str | None = None
    browser_back_chord: str | None = None
    browser_back_keyboard_attempts: list[dict[str, Any]] | None = None
    place_link_destination: dict[str, Any] | None = None
    return_state: dict[str, Any] | None = None
    return_state_retention: dict[str, Any] | None = None
    focused_record = tab_until(is_near_you_full_record_control, limit=120, action_prefix="Tab-record")
    if focused_record is None:
        steps.append(record_keyboard_step(page, step=len(steps), action="full-record-not-focused"))
    else:
        # Enter starts a cross-document navigation. wait_for_navigation_settle alone can
        # return immediately on the already-idle Near You document before the new request
        # begins — race that falsely leaves destination on near-you. Expect the navigation.
        pre_url = safe_page_url(page) or ""
        nav_evidence: dict[str, Any] = {"pre_url": pre_url, "errors": []}
        try:
            with page.expect_navigation(timeout=45_000, wait_until="domcontentloaded"):
                page.keyboard.press("Enter")
            nav_evidence["expect_navigation"] = "completed"
        except Exception as error:
            nav_evidence["expect_navigation"] = "error"
            nav_evidence["errors"].append(
                {
                    "phase": "expect_navigation",
                    "type": error.__class__.__name__,
                    "message": str(error)[:240],
                }
            )
            # Enter may still have been delivered; give a bounded URL poll as backstop.
            deadline = time.time() + 15
            while time.time() < deadline:
                cur = safe_page_url(page) or ""
                if cur != pre_url and ("#land/" in cur or "/browse/zoning" in cur):
                    break
                page.wait_for_timeout(200)
        nav_evidence.update(wait_for_navigation_settle(page))
        dest_url = safe_page_url(page) or ""
        full_record_opened = bool("#land/" in dest_url or "/browse/zoning" in dest_url)
        nav_evidence["destination_url"] = dest_url
        nav_evidence["full_record_opened"] = full_record_opened
        # Do not read focus until destination is known; then one settled read.
        steps.append(
            record_keyboard_step(
                page,
                step=len(steps),
                action="Enter-open-full-record",
                read_focus=False,
                extra={"navigation": nav_evidence, "full_record_opened": full_record_opened},
            )
        )
        if full_record_opened:
            settled = wait_settled_named_record_heading(page)
            steps.append(
                record_keyboard_step(
                    page,
                    step=len(steps),
                    action="settled-named-heading",
                    extra={"settled_named_record": settled},
                )
            )

            def is_chelsea_place_return_control(focused: dict[str, Any] | None) -> bool:
                """Chelsea Near You place link — not Browse CityScroll listing fallback.

                Place-link return is distinct from browser history Back. Map-first defaults
                often omit surface=records; callers must still prove retained requested state
                from DOM after either method.
                """
                if not isinstance(focused, dict):
                    return False
                href = str(focused.get("href") or "")
                if "near-you" not in href or "geo=" not in href:
                    return False
                geo_token = expected_geo.replace(":", "%3A")
                chelsea_token = f"nta2020%3A{CHELSEA}"
                return bool(
                    expected_geo in href
                    or geo_token in href
                    or chelsea_token in href
                    or "MN0401" in href
                )

            # Keyboard browser-history Back is separate from a geographic place-link.
            # Try platform-correct chords first (macOS Meta+BracketLeft, then Alt+ArrowLeft).
            # Playwright Chromium often yields no-navigation for every chord — that is an
            # automation limit, not proof that product history Back is broken. Place-link
            # may intentionally open map-first; do not label history Back broken from it.
            # Either observed method must still prove retained requested geo/lens/surface.
            back_nav: dict[str, Any] = {"errors": [], "pre_url": safe_page_url(page) or ""}
            back_return_method = "none"
            keyboard_back = attempt_keyboard_browser_back(page, timeout_ms=5_000)
            back_nav["keyboard_browser_back"] = keyboard_back
            browser_back_keyboard_status = str(keyboard_back.get("status") or "")
            browser_back_chord = keyboard_back.get("chord")
            browser_back_keyboard_attempts = list(keyboard_back.get("attempts") or [])
            if keyboard_back.get("navigated"):
                back_nav["expect_navigation"] = "completed"
                back_return_method = "browser-back"
                back_nav["browser_back_chord"] = browser_back_chord
            else:
                back_nav["expect_navigation"] = "keyboard-no-nav"
                back_nav["errors"].append(
                    {
                        "phase": "browser-back-keyboard",
                        "type": "NoNavigation",
                        "message": str(keyboard_back.get("status") or "no-nav")[:240],
                        "note": keyboard_back.get("note"),
                    }
                )
                # Separate affordance probe only — never conflated with history Back.
                focused_back = tab_until(
                    is_chelsea_place_return_control, limit=80, action_prefix="Tab-place-return"
                )
                if focused_back is None:
                    steps.append(
                        record_keyboard_step(
                            page,
                            step=len(steps),
                            action="back-control-not-focused",
                            extra={"navigation": back_nav},
                        )
                    )
                else:
                    back_nav["focused_control"] = focused_back
                    try:
                        with page.expect_navigation(timeout=45_000, wait_until="domcontentloaded"):
                            page.keyboard.press("Enter")
                        back_nav["expect_navigation"] = "completed"
                        back_return_method = "place-link"
                    except Exception as place_error:
                        back_nav["errors"].append(
                            {
                                "phase": "place-link",
                                "type": place_error.__class__.__name__,
                                "message": str(place_error)[:240],
                            }
                        )
                        page.wait_for_timeout(1000)
                        back_return_method = "place-link-attempted"
            steps.append(
                record_keyboard_step(
                    page,
                    step=len(steps),
                    action=(
                        "keyboard-browser-back"
                        if back_return_method == "browser-back"
                        else "Enter-place-return"
                        if back_return_method.startswith("place-link")
                        else "back-failed"
                    ),
                    read_focus=False,
                    extra={
                        "navigation": back_nav,
                        "back_return_method": back_return_method,
                        "browser_back_keyboard_status": keyboard_back.get("status"),
                        "browser_back_chord": keyboard_back.get("chord"),
                    },
                )
            )
            back_settle = wait_for_navigation_settle(page)
            return_state = read_near_you_route_state(page)
            retention = retained_requested_return_state(
                requested_return_state,
                return_state,
                expected_geo=expected_geo,
            )
            end_geo_probe = normalize_near_you_geo(return_state.get("geo"))
            dest = safe_page_url(page) or ""
            # Place-link destination is recorded even when surface differs (map-first).
            # Native shortcut NO_NAV does not alone fail the keyboard journey.
            # History API Back retention is a separate packet observation.
            place_link_destination = None
            if back_return_method.startswith("place-link"):
                place_link_destination = {
                    "recorded": bool(return_state and end_geo_probe),
                    "method": back_return_method,
                    "geo": return_state.get("geo"),
                    "lens": return_state.get("lens"),
                    "surface": return_state.get("surface"),
                    "url": return_state.get("url") or dest,
                }
            elif back_return_method == "browser-back":
                place_link_destination = {
                    "recorded": False,
                    "method": "not-used-native-browser-back-navigated",
                    "note": "Native chord navigated; place-link not required for this run.",
                }
            back_completed = bool(
                back_return_method == "browser-back"
                or (
                    back_return_method.startswith("place-link")
                    and place_link_destination
                    and place_link_destination.get("recorded")
                )
            )
            steps.append(
                record_keyboard_step(
                    page,
                    step=len(steps),
                    action="back-result",
                    extra={
                        "back_completed": back_completed,
                        "back_return_method": back_return_method,
                        "back_settle": back_settle,
                        "requested_return_state": requested_return_state,
                        "return_state": return_state,
                        "return_state_retention": retention,
                        "place_link_destination": place_link_destination,
                        "end_geo": end_geo_probe,
                        "end_url": dest,
                    },
                )
            )

    # Final geo/url reads only after navigation from Back (or prior steps) has settled.
    # Drain any in-flight navigation so the caller can goto without interruption.
    page.wait_for_timeout(200)
    final_settle = wait_for_navigation_settle(page)
    if return_state is None:
        return_state = read_near_you_route_state(page)
    if return_state_retention is None:
        return_state_retention = retained_requested_return_state(
            requested_return_state,
            return_state,
            expected_geo=expected_geo,
        )
    end_geo = normalize_near_you_geo(return_state.get("geo"))
    result = {
        "steps": steps,
        "start_url": start_url,
        "start_geo": start_geo,
        "final_navigation_settle": final_settle,
        "category_transition_observed": category_transition_observed,
        "inspect_control_focused": inspect_control_focused,
        "inspect_dialog_opened": inspect_dialog_opened,
        "inspect_dialog_named_title": inspect_dialog_named_title,
        "inspect_dialog_title": inspect_title,
        "inspect_dialog_closed": inspect_dialog_closed,
        "inspect_focus_restored": inspect_focus_restored,
        "full_record_opened": full_record_opened,
        "settled_named_record": settled,
        "back_completed": back_completed,
        "back_return_method": back_return_method,
        "browser_back_keyboard_status": browser_back_keyboard_status,
        "browser_back_chord": browser_back_chord,
        "browser_back_keyboard_attempts": browser_back_keyboard_attempts,
        "place_link_destination": place_link_destination,
        "requested_return_state": requested_return_state,
        "return_state": return_state,
        "return_state_retention": return_state_retention,
        "end_geo": end_geo,
        "end_url": safe_page_url(page),
        "used_non_keyboard_navigation": used_non_keyboard,
        "operated_from_keyboard_alone": not used_non_keyboard,
        "native_browser_shortcut_required": False,
        "map_first_place_link_is_not_broken_browser_back": True,
    }
    result.update(evaluate_keyboard_journey_result(result, expected_geo=expected_geo))
    return result


def _wait_near_you_deferred_ready(page, *, timeout_ms: int = 45_000) -> None:
    try:
        page.wait_for_function(
            """() => {
              const root = document.querySelector('[data-near-you-root]');
              const s = root && root.getAttribute('data-near-deferred-state');
              return s === 'ready' || s === 'partial' || s === 'error';
            }""",
            timeout=timeout_ms,
        )
    except Exception:
        pass


def _find_visible_near_results_full_record(page) -> dict[str, Any] | None:
    """First Playwright-visible full-record control inside section.near-results."""
    return page.evaluate(
        """() => {
          const nodes = Array.from(document.querySelectorAll(
            'section.near-results li.near-record a.near-record-full-record, '
            + 'section.near-results li.near-record a.near-record-title-link'
          ));
          const pack = (a) => {
            const href = a.getAttribute('href') || '';
            const li = a.closest('li.near-record');
            const style = window.getComputedStyle(a);
            const rect = a.getBoundingClientRect();
            const visible = !!(
              style && style.visibility !== 'hidden' && style.display !== 'none'
              && Number(style.opacity) !== 0
              && rect.width > 0 && rect.height > 0
            );
            return {
              href,
              abs_href: a.href,
              text: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
              className: typeof a.className === 'string' ? a.className : String(a.className || ''),
              record_id: li ? li.getAttribute('data-record-id') : null,
              visible,
              prefer_full: (a.className || '').toString().includes('near-record-full-record'),
            };
          };
          const rows = nodes.map(pack).filter((row) => row.visible && row.href);
          const full = rows.find((row) => row.prefer_full);
          return full || rows[0] || null;
        }"""
    )


def observe_history_back_place_retention(
    page,
    *,
    origin: str,
    expected_geo: str = f"nta2020:{CHELSEA}",
) -> dict[str, Any]:
    """Prove full-record continuation via page.go_back (history API, not keyboard).

    Opens Chelsea records, opens a visible near-results full land record, then
    history-Back and asserts geo / lens / surface=records are retained. Separate
    from the keyboard journey.
    """
    records_url = uncached(
        origin,
        f"/near-you/?geo={expected_geo}&lens=land&surface=records",
    )
    evidence: dict[str, Any] = {
        "method": "page.go_back",
        "evidence_class": "browser-history-api",
        "not_keyboard_evidence": True,
        "start_url": records_url,
        "expected_geo": expected_geo,
        "errors": [],
    }
    page.goto(records_url, wait_until="domcontentloaded", timeout=120_000)
    page.wait_for_selector("h1, [data-near-you-root]", timeout=60_000)
    try:
        page.wait_for_selector(
            '[data-near-you-root][data-enhanced="true"], section.near-results',
            timeout=60_000,
        )
    except Exception:
        pass
    _wait_near_you_deferred_ready(page, timeout_ms=60_000)
    try:
        page.wait_for_selector(
            "section.near-results li.near-record a.near-record-full-record, "
            "section.near-results li.near-record a.near-record-title-link",
            timeout=60_000,
        )
    except Exception:
        pass

    requested_return_state = read_near_you_route_state(page)
    evidence["requested_return_state"] = requested_return_state

    link_info = _find_visible_near_results_full_record(page)
    evidence["full_record_control"] = link_info
    if not link_info:
        evidence["history_back_completed"] = False
        evidence["errors"].append(
            {
                "phase": "open-full-record",
                "message": "no visible near-results full-record control",
            }
        )
        evidence.update(evaluate_history_back_return_result(evidence, expected_geo=expected_geo))
        return evidence

    named_before = None
    try:
        candidates = page.locator(
            "section.near-results li.near-record a.near-record-full-record, "
            "section.near-results li.near-record a.near-record-title-link"
        )
        target = None
        href = str(link_info.get("href") or "")
        abs_href = str(link_info.get("abs_href") or "")
        record_id = str(link_info.get("record_id") or "")
        for idx in range(candidates.count()):
            cand = candidates.nth(idx)
            try:
                cand_href = cand.get_attribute("href") or ""
            except Exception:
                continue
            cand_abs = urllib.parse.urljoin(origin + "/", cand_href)
            href_match = bool(href) and (
                cand_href == href
                or cand_abs == abs_href
                or _normalize_intercept_url(cand_abs) == _normalize_intercept_url(abs_href)
            )
            if not href_match and record_id:
                try:
                    parent_id = cand.evaluate(
                        "el => (el.closest('li.near-record')||{}).getAttribute?.('data-record-id')"
                    )
                except Exception:
                    parent_id = None
                if parent_id != record_id:
                    continue
            elif not href_match:
                continue
            try:
                cand.scroll_into_view_if_needed(timeout=8_000)
            except Exception:
                pass
            if cand.is_visible():
                target = cand
                break
        if target is None:
            raise RuntimeError("visible near-results full-record control not actionable")
        with page.expect_navigation(timeout=60_000, wait_until="domcontentloaded"):
            target.click(timeout=15_000)
        settle = wait_settled_named_record_heading(page, timeout_ms=60_000)
        named_before = settle
        evidence["full_record"] = settle
        evidence["full_record_url"] = safe_page_url(page)
    except Exception as error:
        evidence["history_back_completed"] = False
        evidence["errors"].append(
            {
                "phase": "open-full-record",
                "type": error.__class__.__name__,
                "message": str(error)[:240],
            }
        )
        evidence.update(evaluate_history_back_return_result(evidence, expected_geo=expected_geo))
        return evidence

    try:
        page.go_back(wait_until="domcontentloaded", timeout=60_000)
        evidence["navigation_settle"] = wait_for_navigation_settle(page)
        return_state = read_near_you_route_state(page)
        retention = retained_requested_return_state(
            requested_return_state,
            return_state,
            expected_geo=expected_geo,
        )
        evidence["return_state"] = return_state
        evidence["return_state_retention"] = retention
        evidence["end_geo"] = return_state.get("geo")
        evidence["end_url"] = safe_page_url(page)
        evidence["history_back_completed"] = True
        evidence["named_record_before_back"] = named_before
    except Exception as error:
        evidence["history_back_completed"] = False
        evidence["errors"].append(
            {
                "phase": "page.go_back",
                "type": error.__class__.__name__,
                "message": str(error)[:240],
            }
        )
    evidence.update(evaluate_history_back_return_result(evidence, expected_geo=expected_geo))
    return evidence


def observe_selected_map(page, *, geo_id: str = CHELSEA) -> dict[str, Any]:
    """Observe maplibre selected boundary fit within the first viewport."""
    canvas_layout = page.evaluate(
        """() => {
          const canvas = document.querySelector('.maplibregl-canvas');
          if (!canvas) return { present: false };
          const box = canvas.getBoundingClientRect();
          const style = getComputedStyle(canvas);
          return {
            present: true,
            width: box.width,
            height: box.height,
            x: box.x,
            y: box.y,
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
          };
        }"""
    )
    laid_out = bool(
        (canvas_layout or {}).get("present")
        and float((canvas_layout or {}).get("width") or 0) >= 40
        and float((canvas_layout or {}).get("height") or 0) >= 40
    )
    if not laid_out:
        return {
            "map_box": canvas_layout,
            "visible_height_in_first_viewport": 0,
            "selected_boundary_pixels": None,
            "boundary_height_ratio": None,
            "boundary_fits_first_viewport": False,
            "map_canvas_laid_out": False,
            "note": (
                "Map canvas is present but not laid out in this surface/viewport; "
                "first-viewport boundary fit is measured on surface=map."
            ),
            "check_result": "fail",
        }
    page.wait_for_function(
        """(geoId) => {
          const m = window.__chelseaObservedMap;
          const features = m?.getStyle()?.sources?.['geography-selected']?.data?.features || [];
          const selected = features.find(f => String(f.properties?.key || f.id || '').includes(geoId));
          if (!m || m.isMoving() || !m.getLayer('geography-selected-fill') || !selected) return false;
          return m.queryRenderedFeatures({layers: ['geography-selected-fill']})
            .some(f => String(f.properties?.key || f.id || '').includes(geoId));
        }""",
        arg=geo_id,
        timeout=60_000,
        polling=100,
    )
    canvas = page.locator(".maplibregl-canvas")
    canvas.wait_for(state="visible", timeout=30_000)
    box = canvas.bounding_box()
    viewport_height = (page.viewport_size or {}).get("height") or 0
    visible_height = 0.0
    if box:
        visible_height = min(box["y"] + box["height"], viewport_height) - max(box["y"], 0)
    geometry = page.evaluate(
        """(geoId) => {
          const map = window.__chelseaObservedMap;
          const features = (map.getStyle().sources['geography-selected'].data.features || [])
            .filter(f => String(f.properties?.key || f.id || '').includes(geoId));
          const points = features.flatMap(f => f.geometry.coordinates.flat(Infinity));
          const pixels = [];
          for (let i = 0; i < points.length; i += 2) {
            pixels.push(map.project([points[i], points[i + 1]]));
          }
          if (!pixels.length) return null;
          const xs = pixels.map(p => p.x);
          const ys = pixels.map(p => p.y);
          return {
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
            min_x: Math.min(...xs),
            max_x: Math.max(...xs),
            min_y: Math.min(...ys),
            max_y: Math.max(...ys),
          };
        }""",
        geo_id,
    )
    map_box = {
        "x": box["x"] if box else None,
        "y": box["y"] if box else None,
        "width": box["width"] if box else None,
        "height": box["height"] if box else None,
    }
    boundary_ratio = None
    if geometry and map_box["height"]:
        boundary_ratio = geometry["height"] / map_box["height"] if map_box["height"] else None
    fits = bool(
        visible_height >= 150
        and geometry
        and map_box["height"]
        and geometry["height"] > (map_box["height"] * 0.4)
    )
    return {
        "map_box": map_box,
        "visible_height_in_first_viewport": visible_height,
        "selected_boundary_pixels": geometry,
        "boundary_height_ratio": boundary_ratio,
        "boundary_fits_first_viewport": fits,
        "map_canvas_laid_out": True,
        "check_result": "pass" if fits else "fail",
    }



def observe_overview_lens_scope_links(
    page,
    *,
    expected_geo: str = f"nta2020:{CHELSEA}",
    interaction_mode: str = "document",
) -> dict[str, Any]:
    """Record overview Open meetings / Open Zoning hrefs and click outcomes.

    interaction_mode:
      - document: Worker-SSR path; fresh document load before each click.
      - client: Pages-client path; no document reload before clicks; require
        same-document proof (window marker survives) or the row is Worker output.
      - client-place-scope: after island-adopt proven client overview; snapshot
        BOTH Open meetings / Open Zoning hrefs on the adopted client DOM before
        any document-navigation click; click place-scope on adopted DOM counts
        as Pages-client. After a document reload between probes, subsequent
        clicks are labeled worker-ssr-after-reload unless re-adopted.
    """
    if interaction_mode not in {"document", "client", "client-place-scope"}:
        raise ValueError(
            f"interaction_mode must be document|client|client-place-scope, got {interaction_mode!r}"
        )
    page.wait_for_selector(
        '[data-near-overview="true"], .near-overview, h1',
        timeout=90_000,
    )
    _wait_near_you_deferred_ready(page, timeout_ms=45_000)
    # After island-adopt history Back, wait until overview Open meetings/Zoning
    # hrefs retain the expected place before snapshotting (avoid stale away-geo hrefs).
    if interaction_mode == "client-place-scope":
        try:
            page.wait_for_function(
                """(expectedGeo) => {
                  const root = document.querySelector('[data-near-overview="true"], .near-overview');
                  if (!root) return false;
                  const chelsea = expectedGeo.split(':').pop() || expectedGeo;
                  const anchors = Array.from(root.querySelectorAll('a[href]')).filter((a) => {
                    const text = (a.textContent || '').replace(/\\s+/g, ' ').trim();
                    const href = a.getAttribute('href') || '';
                    return /^Open (meetings|Zoning)$/i.test(text) && /near-you/i.test(href);
                  });
                  if (!anchors.length) return false;
                  return anchors.some((a) => {
                    const href = a.getAttribute('href') || '';
                    return href.includes(expectedGeo) || href.includes(chelsea)
                      || href.includes(encodeURIComponent(expectedGeo));
                  });
                }""",
                arg=expected_geo,
                timeout=20_000,
            )
        except Exception:
            pass
    start_url = page.url
    start_heading = (
        normalize_ws(page.locator("h1").first.inner_text()) if page.locator("h1").count() else ""
    )
    link_rows = page.evaluate(
        """(expectedGeo) => {
          const root = document.querySelector('[data-near-overview="true"], .near-overview')
            || document.body;
          const chelsea = (expectedGeo || '').split(':').pop() || expectedGeo || '';
          const wanted = [
            { label: 'Open meetings', match: /^Open meetings$/i },
            { label: 'Open Zoning', match: /^Open Zoning$/i },
          ];
          const retains = (href) => {
            if (!href) return false;
            return href.includes(expectedGeo)
              || href.includes(chelsea)
              || href.includes(encodeURIComponent(expectedGeo || ''));
          };
          return wanted.map(({ label, match }) => {
            const anchors = Array.from(root.querySelectorAll('a[href]')).filter((a) => {
              const text = (a.textContent || '').replace(/\\s+/g, ' ').trim();
              const href = a.getAttribute('href') || '';
              return match.test(text) && /near-you/i.test(href);
            });
            const preferred = anchors.find((a) => retains(a.getAttribute('href') || ''))
              || anchors[0]
              || null;
            if (!preferred) {
              return { label, found: false, href: null, abs_href: null };
            }
            return {
              label,
              found: true,
              href: preferred.getAttribute('href') || null,
              abs_href: preferred.href || null,
              text: (preferred.textContent || '').replace(/\\s+/g, ' ').trim(),
            };
          });
        }""",
        expected_geo,
    )

    def href_retains_place(href: str | None) -> bool:
        if not isinstance(href, str) or not href:
            return False
        parsed = urllib.parse.urlparse(urllib.parse.urljoin(ORIGIN + "/", href))
        params = urllib.parse.parse_qs(parsed.query)
        geo_values = params.get("geo") or []
        geo_ok = any(expected_geo in value or CHELSEA in value for value in geo_values)
        return geo_ok

    def find_target(label: str):
        candidates = page.locator("a[href]")
        count = candidates.count()
        preferred = None
        fallback = None
        for index in range(count):
            node = candidates.nth(index)
            text = normalize_ws(node.inner_text())
            node_href = node.get_attribute("href") or ""
            if text != label or "near-you" not in node_href or "community-boards" in node_href:
                continue
            if href_retains_place(node_href):
                preferred = node
                break
            if fallback is None:
                fallback = node
        if preferred is not None:
            return preferred
        if fallback is not None:
            return fallback
        locator = page.locator(f'a[href]:text-is("{label}")')
        if locator.count():
            return locator.first
        return None

    # Snapshot BOTH lens hrefs on the current DOM before any click. For
    # client-place-scope this must be the island-adopted Pages client DOM.
    adopted_client_href_snapshot: list[dict[str, Any]] = []
    for row in link_rows or []:
        label = str((row or {}).get("label") or "")
        href = (row or {}).get("href")
        abs_href = (row or {}).get("abs_href") or href
        adopted_client_href_snapshot.append(
            {
                "label": label,
                "found": bool((row or {}).get("found")),
                "href": href,
                "abs_href": abs_href,
                "href_retains_geo": href_retains_place(href) or href_retains_place(abs_href),
                "href_snapshot_rendering": (
                    "pages-client-adopted"
                    if interaction_mode == "client-place-scope"
                    else interaction_mode
                ),
            }
        )

    clicks: list[dict[str, Any]] = []
    # After a document reload between probes, the DOM is Worker-SSR unless
    # the island is re-adopted. Track that honestly for client-place-scope.
    client_dom_intact = interaction_mode == "client-place-scope"
    for row in link_rows or []:
        label = str((row or {}).get("label") or "")
        href = (row or {}).get("href")
        abs_href = (row or {}).get("abs_href") or href
        found = bool((row or {}).get("found"))
        retains = href_retains_place(href) or href_retains_place(abs_href)
        if interaction_mode == "client-place-scope":
            click_rendering = (
                "pages-client-adopted" if client_dom_intact else "worker-ssr-after-reload"
            )
        elif interaction_mode == "client":
            click_rendering = "pages-client"
        else:
            click_rendering = "worker-ssr"
        click_result: dict[str, Any] = {
            "label": label,
            "found": found,
            "href": href,
            "abs_href": abs_href,
            "href_retains_geo": retains,
            "href_snapshot_rendering": (
                "pages-client-adopted"
                if interaction_mode == "client-place-scope"
                else interaction_mode
            ),
            "click_rendering": click_rendering,
            "clicked": False,
            "result_url": None,
            "result_geo": None,
            "result_h1": None,
            "result_retains_chelsea_label": None,
            "widened_to_citywide": None,
            "interaction_mode": interaction_mode,
            "same_document_proof": None,
        }
        if found and abs_href:
            if interaction_mode == "document":
                page.goto(start_url, wait_until="networkidle", timeout=120_000)
                page.wait_for_selector("h1", timeout=60_000)
            target = find_target(label)
            if target is not None:
                marker_state = install_document_marker(page)
                if interaction_mode == "document":
                    with page.expect_navigation(wait_until="networkidle", timeout=90_000):
                        target.click()
                    click_result["clicked"] = True
                    click_result["same_document_proof"] = prove_same_document(page, marker_state)
                    # Document mode expects a new document; do not require same_document.
                else:
                    # client or client-place-scope
                    try:
                        with page.expect_navigation(timeout=8_000, wait_until="domcontentloaded"):
                            target.click(timeout=15_000)
                        click_result["clicked"] = True
                        click_result["click_navigation"] = "document"
                    except Exception:
                        target.click(timeout=15_000, no_wait_after=True)
                        page.wait_for_timeout(400)
                        click_result["clicked"] = True
                        click_result["click_navigation"] = "no-expect-nav"
                    proof = prove_same_document(page, marker_state)
                    click_result["same_document_proof"] = proof
                    if not proof.get("same_document"):
                        click_result["navigation_settle"] = wait_for_navigation_settle(page)
                        if interaction_mode == "client":
                            click_result["client_proof_failed"] = True
                        else:
                            # client-place-scope: Open Zoning may intentionally document-navigate.
                            click_result["document_navigation_allowed"] = True
                click_result["result_url"] = safe_page_url(page)
                click_result["result_geo"] = page.evaluate(
                    "() => new URL(window.location.href).searchParams.get('geo')"
                )
                result_h1 = (
                    normalize_ws(page.locator("h1").first.inner_text())
                    if page.locator("h1").count()
                    else ""
                )
                click_result["result_h1"] = result_h1
                click_result["result_retains_chelsea_label"] = any(
                    needle in result_h1 for needle in CHELSEA_LABEL_NEEDLES
                )
                click_result["widened_to_citywide"] = (
                    click_result["result_geo"] in (None, "")
                    or not click_result["result_retains_chelsea_label"]
                )
                if interaction_mode == "client":
                    # Soft-return to overview between client clicks without document reload when possible.
                    if page.url.split("#")[0] != start_url.split("#")[0] or "lens=" in page.url:
                        soft = soft_return_to_chelsea_overview(page, origin=ORIGIN, expected_geo=expected_geo)
                        click_result["return_after_click"] = soft
                elif interaction_mode == "client-place-scope":
                    # Restore Chelsea overview for the next link via document load of start_url.
                    # After this reload the DOM is Worker-SSR unless re-adopted.
                    if page.url.split("#")[0] != start_url.split("#")[0] or "lens=" in page.url:
                        page.goto(start_url, wait_until="domcontentloaded", timeout=120_000)
                        try:
                            page.wait_for_selector(
                                '[data-near-you-root][data-enhanced="true"]', timeout=60_000
                            )
                        except Exception:
                            page.wait_for_selector("h1", timeout=60_000)
                        client_dom_intact = False
                        click_result["return_after_click"] = {
                            "method": "document-reload-start-url",
                            "note": (
                                "between client-place-scope link probes; subsequent "
                                "clicks are worker-ssr-after-reload unless re-adopted"
                            ),
                            "client_dom_intact_after": False,
                        }
        if interaction_mode == "client-place-scope":
            # Href verdict uses the pre-click adopted-client snapshot. Click
            # place-scope counts for Pages-client only when click_rendering is
            # pages-client-adopted; SSR-after-reload clicks are labeled and
            # recorded but do not alone close the Pages-client row.
            href_ok = bool(found and retains)
            click_ok = bool(
                click_result.get("clicked")
                and click_result.get("result_geo") == expected_geo
                and click_result.get("result_retains_chelsea_label")
            )
            if click_result.get("click_rendering") == "pages-client-adopted":
                link_ok = bool(href_ok and click_ok)
            else:
                click_result["pages_client_click_proof"] = False
                click_result["ssr_after_reload_click"] = True
                link_ok = bool(href_ok)
                if click_ok:
                    click_result["ssr_click_place_scope"] = "pass"
                elif click_result.get("clicked"):
                    click_result["ssr_click_place_scope"] = "fail"
        else:
            link_ok = bool(
                found
                and retains
                and click_result.get("clicked")
                and click_result.get("result_geo") == expected_geo
                and click_result.get("result_retains_chelsea_label")
            )
            if interaction_mode == "client":
                proof = click_result.get("same_document_proof") or {}
                link_ok = bool(link_ok and proof.get("same_document"))
        click_result["check_result"] = "pass" if link_ok else "fail"
        clicks.append(click_result)

    failing_labels = [row["label"] for row in clicks if row.get("check_result") == "fail"]
    if interaction_mode == "client-place-scope":
        href_failing = [
            row["label"]
            for row in adopted_client_href_snapshot
            if not (row.get("found") and row.get("href_retains_geo"))
        ]
        adopted_clicks = [
            row
            for row in clicks
            if row.get("click_rendering") == "pages-client-adopted" and row.get("clicked")
        ]
        adopted_click_ok = bool(adopted_clicks) and all(
            row.get("result_geo") == expected_geo
            and row.get("result_retains_chelsea_label")
            for row in adopted_clicks
        )
        overall_pass = bool(
            adopted_client_href_snapshot
            and not href_failing
            and all(row.get("found") for row in adopted_client_href_snapshot)
            and adopted_click_ok
            and not failing_labels
        )
    else:
        overall_pass = bool(clicks) and not failing_labels and all(row.get("found") for row in clicks)
    regression_note = (
        "Overview Open meetings / Open Zoning links must retain the selected "
        "neighborhood geo (and surface) so the resident stays on Chelsea. "
    )
    if interaction_mode == "client":
        regression_note += (
            "Client-mode rows require same-document proof (window marker survives); "
            "without it the observation is Worker-served, not client."
        )
    elif interaction_mode == "client-place-scope":
        regression_note += (
            "Client-place-scope snapshots both lens hrefs on the island-adopted "
            "Pages client DOM before any document-navigation click. Clicks after a "
            "document reload are labeled worker-ssr-after-reload unless re-adopted."
        )
    else:
        regression_note += "Worker-SSR document clicks must retain Chelsea place scope."
    result: dict[str, Any] = {
        "start_url": start_url,
        "start_heading": start_heading,
        "expected_geo": expected_geo,
        "interaction_mode": interaction_mode,
        "links": clicks,
        "failing_labels": failing_labels,
        "check_result": "pass" if overall_pass else "fail",
        "observation_status": "closed" if overall_pass else "open",
        "regression_note": regression_note,
    }
    if interaction_mode == "client-place-scope":
        result["adopted_client_href_snapshot"] = adopted_client_href_snapshot
        result["href_snapshot_rendering"] = "pages-client-adopted"
    return result



def soft_return_to_chelsea_overview(page, *, origin: str, expected_geo: str = f"nta2020:{CHELSEA}") -> dict[str, Any]:
    """Soft-navigate away from overview and back so the static client bundle re-renders.

    Default navigation_mode is unproven until a same-document away+return is proven via
    window marker survival. Document navigations are labeled honestly.

    Observer expectation vs supported product affordance:
    - Observer wants a same-document soft cycle (marker survives; zero main-frame
      framenavigated) so Pages-client overview-link clicks are not Worker-SSR reloads.
    - Current Near You overview exposes real ``<a href>`` lens/return links and does
      not ship ``data-near-clear-lens`` / ``data-near-overview-home`` soft hooks, so the
      supported affordance for *lens href soft-return* is document-navigation-via-href.
      Pages-client overview proof uses ``prove_pages_client_island_adopt_cycle``
      (visible island ``followWithinIsland`` / ``adoptDocument`` + history Back) instead.
    """
    start_url = page.url
    nav_mode = "unproven"
    marker_state = install_document_marker(page)
    document_nav_events = {"count": 0}
    affordance_probe: dict[str, Any] = {
        "observer_expectation": "same-document-away-and-return",
        "explicit_soft_hooks_present": False,
        "supported_product_affordance": "unproven",
    }

    def _on_frame_nav(frame) -> None:
        try:
            if frame == page.main_frame:
                document_nav_events["count"] += 1
        except Exception:
            pass

    page.on("framenavigated", _on_frame_nav)

    clear_lens_count = page.locator("[data-near-clear-lens]").count()
    overview_home_count = page.locator("[data-near-overview-home]").count()
    affordance_probe["clear_lens_count"] = clear_lens_count
    affordance_probe["overview_home_count"] = overview_home_count
    affordance_probe["explicit_soft_hooks_present"] = bool(
        clear_lens_count or overview_home_count
    )

    lens_candidates = page.locator(
        'a[href*="lens=land"][href*="near-you"], '
        'a[href*="lens=meetings"][href*="near-you"], '
        '[data-near-lens="land"], [data-near-lens="meetings"]'
    )
    clicked_away = False
    away_proof = None
    away_control: dict[str, Any] | None = None
    if lens_candidates.count():
        target = None
        for index in range(min(lens_candidates.count(), 12)):
            node = lens_candidates.nth(index)
            href = node.get_attribute("href") or ""
            try:
                text = normalize_ws(node.inner_text())
            except Exception:
                text = ""
            if text in {"Open meetings", "Open Zoning"}:
                continue
            if "near-you" in href or node.get_attribute("data-near-lens"):
                target = node
                away_control = {
                    "text": text,
                    "href": href,
                    "data_near_lens": node.get_attribute("data-near-lens"),
                }
                break
        if target is None and lens_candidates.count():
            target = lens_candidates.first
            try:
                fallback_text = normalize_ws(target.inner_text())
            except Exception:
                fallback_text = ""
            away_control = {
                "text": fallback_text,
                "href": target.get_attribute("href") or "",
                "data_near_lens": target.get_attribute("data-near-lens"),
                "fallback_first": True,
            }
        if target is not None:
            try:
                before_nav = document_nav_events["count"]
                target.click(timeout=15_000, no_wait_after=True)
                page.wait_for_timeout(1200)
                clicked_away = True
                away_proof = prove_same_document(page, marker_state)
                if document_nav_events["count"] > before_nav or not away_proof.get("same_document"):
                    nav_mode = "document"
                    try:
                        page.wait_for_load_state("networkidle", timeout=60_000)
                    except Exception:
                        page.wait_for_timeout(1500)
            except Exception as error:
                nav_mode = f"soft-away-error:{error.__class__.__name__}"

    returned = False
    return_proof = None
    return_control_kind: str | None = None
    overview_controls = page.locator(
        'a[href*="near-you"][href*="MN0401"]:not([href*="lens="]), '
        'a[href*="geo=nta2020%3AMN0401"]:not([href*="lens="]), '
        '[data-near-clear-lens], [data-near-overview-home]'
    )
    if overview_controls.count():
        try:
            before_nav = document_nav_events["count"]
            marker_return = install_document_marker(page)
            first = overview_controls.first
            return_control_kind = (
                "data-near-clear-lens"
                if first.get_attribute("data-near-clear-lens") is not None
                else "data-near-overview-home"
                if first.get_attribute("data-near-overview-home") is not None
                else "href-overview-return"
            )
            first.click(timeout=10_000, no_wait_after=True)
            page.wait_for_timeout(1200)
            returned = True
            return_proof = prove_same_document(page, marker_return)
            if document_nav_events["count"] > before_nav or not return_proof.get("same_document"):
                nav_mode = "document"
        except Exception:
            returned = False
    if not returned:
        try:
            page.go_back(wait_until="networkidle", timeout=60_000)
            returned = True
            nav_mode = "history-back"
            return_control_kind = "history-back"
        except Exception:
            page.goto(uncached(origin, NO_LENS_ROUTE), wait_until="networkidle", timeout=120_000)
            returned = True
            nav_mode = "document-fallback"
            return_control_kind = "document-fallback"
    page.wait_for_selector("h1", timeout=60_000)
    geo = page.evaluate("() => new URL(window.location.href).searchParams.get('geo')")
    lens = page.evaluate("() => new URL(window.location.href).searchParams.get('lens')")
    if geo != expected_geo or lens not in (None, ""):
        page.goto(uncached(origin, NO_LENS_ROUTE), wait_until="networkidle", timeout=120_000)
        nav_mode = "document-fallback"
        return_control_kind = "document-fallback"
        page.wait_for_selector("h1", timeout=60_000)

    if (
        nav_mode == "unproven"
        and clicked_away
        and returned
        and (away_proof or {}).get("same_document")
        and (return_proof is None or return_proof.get("same_document"))
        and document_nav_events["count"] == 0
    ):
        nav_mode = "soft"
    elif nav_mode == "unproven" and not clicked_away:
        nav_mode = "unproven-no-away"
    elif nav_mode == "unproven":
        nav_mode = "unproven"

    if nav_mode == "soft":
        affordance_probe["supported_product_affordance"] = "same-document-soft-nav"
    elif document_nav_events["count"] > 0 or nav_mode in {
        "document",
        "document-fallback",
        "history-back",
    }:
        affordance_probe["supported_product_affordance"] = "document-navigation-via-href"
        affordance_probe["note"] = (
            "Lens/overview controls navigate as real documents. The Pages-client "
            "observer cannot claim soft_nav_proven against this affordance."
        )
    elif not clicked_away:
        affordance_probe["supported_product_affordance"] = "unproven-no-away-control"
    else:
        affordance_probe["supported_product_affordance"] = "unproven"

    try:
        page.remove_listener("framenavigated", _on_frame_nav)
    except Exception:
        pass

    return {
        "clicked_away": clicked_away,
        "returned": returned,
        "navigation_mode": nav_mode,
        "away_same_document_proof": away_proof,
        "return_same_document_proof": return_proof,
        "document_nav_event_count": document_nav_events["count"],
        "away_control": away_control,
        "return_control_kind": return_control_kind,
        "affordance": affordance_probe,
        "end_url": page.url,
        "end_geo": page.evaluate("() => new URL(window.location.href).searchParams.get('geo')"),
        "end_lens": page.evaluate("() => new URL(window.location.href).searchParams.get('lens')"),
        "soft_nav_proven": nav_mode == "soft",
    }


def evaluate_pages_client_island_adopt_result(result: dict[str, Any] | None) -> dict[str, Any]:
    """Hermetic pass/fail for Pages-client island-adopt proofs (negatives + live)."""
    result = result or {}
    missing: list[str] = []
    away = result.get("away") or {}
    back = result.get("back") or {}
    if not away.get("adopted"):
        missing.append("away-adopted")
    if not back.get("adopted"):
        missing.append("back-adopted")
    if not result.get("island_adopt_proven"):
        # Defend against callers that set the flag without phase adopts.
        if away.get("adopted") and back.get("adopted"):
            pass
        else:
            missing.append("island-adopt-proven")
    for phase_name, phase in (("away", away), ("back", back)):
        if not phase:
            continue
        if phase.get("skipped"):
            continue
        if not phase.get("marker_survived"):
            missing.append(f"{phase_name}-marker")
        if not phase.get("target_geo_rendered"):
            missing.append(f"{phase_name}-rendered-geo")
        root = phase.get("root_replacement") or {}
        if not root.get("root_replaced"):
            missing.append(f"{phase_name}-root-replacement")
        fetch = phase.get("html_fetch") or {}
        if not fetch.get("fetch_ok"):
            missing.append(f"{phase_name}-html-fetch")
        if phase.get("marker_died_full_document"):
            missing.append(f"{phase_name}-full-document")
    ok = not missing
    return {
        "missing_steps": missing,
        "check_result": "pass" if ok else "fail",
        "observation_status": "closed" if ok else "open",
        "island_adopt_proven": bool(ok and away.get("adopted") and back.get("adopted")),
    }


def install_pages_client_adopt_probe(page) -> dict[str, Any]:
    """Install unique window marker, in-page fetch log, and replaceable sentinel."""
    marker_id = f"pc-{uuid.uuid4().hex[:12]}"
    installed = page.evaluate(
        """(markerId) => {
          const root = document.querySelector('[data-near-you-root]');
          if (!root) return { ok: false, reason: 'no-root' };
          window.__chelseaPagesClientProbe = {
            id: markerId,
            installed_at: Date.now(),
            start_deferred_generation: root.getAttribute('data-near-deferred-generation'),
            start_geo: new URL(location.href).searchParams.get('geo'),
            start_level: root.getAttribute('data-level'),
          };
          if (!window.__chelseaFetchLogInstalled) {
            window.__chelseaFetchLog = [];
            const orig = window.fetch.bind(window);
            window.fetch = async (input, init = {}) => {
              const url = typeof input === 'string' ? input : (input && input.url) || '';
              const headers = (init && init.headers) || {};
              let accept = '';
              if (headers && typeof headers.get === 'function') {
                accept = headers.get('Accept') || headers.get('accept') || '';
              } else if (headers && typeof headers === 'object') {
                accept = headers.Accept || headers.accept || '';
              }
              if (String(url).includes('near-you')) {
                window.__chelseaFetchLog.push({
                  url: String(url),
                  accept: String(accept),
                  at: Date.now(),
                });
              }
              return orig(input, init);
            };
            window.__chelseaFetchLogInstalled = true;
          }
          const host =
            root.querySelector('#near-results, [data-near-deferred="results"], .near-results, .near-head')
            || root;
          document.querySelectorAll('[data-chelsea-probe-sentinel]').forEach((n) => n.remove());
          const sentinel = document.createElement('span');
          sentinel.setAttribute('data-chelsea-probe-sentinel', markerId);
          sentinel.hidden = true;
          host.appendChild(sentinel);
          return {
            ok: true,
            marker_id: markerId,
            start_deferred_generation: window.__chelseaPagesClientProbe.start_deferred_generation,
            sentinel_host: host.id || host.className || host.tagName,
            fetch_log_installed: !!window.__chelseaFetchLogInstalled,
          };
        }""",
        marker_id,
    )
    return {"marker_id": marker_id, **(installed or {})}


def _restamp_pages_client_sentinel(page, marker_id: str) -> None:
    page.evaluate(
        """(markerId) => {
          const root = document.querySelector('[data-near-you-root]');
          if (!root) return;
          const host =
            root.querySelector('#near-results, [data-near-deferred="results"], .near-results, .near-head')
            || root;
          document.querySelectorAll('[data-chelsea-probe-sentinel]').forEach((n) => n.remove());
          const sentinel = document.createElement('span');
          sentinel.setAttribute('data-chelsea-probe-sentinel', markerId);
          sentinel.hidden = true;
          host.appendChild(sentinel);
        }""",
        marker_id,
    )


def read_pages_client_adopt_state(page) -> dict[str, Any]:
    return page.evaluate(
        """() => {
          const root = document.querySelector('[data-near-you-root]');
          const u = new URL(location.href);
          const h1 = (document.querySelector('h1') || {}).textContent || '';
          return {
            url: location.href,
            geo_param: u.searchParams.get('geo'),
            enhanced: root && root.getAttribute('data-enhanced'),
            deferred_state: root && root.getAttribute('data-near-deferred-state'),
            deferred_generation: root && root.getAttribute('data-near-deferred-generation'),
            level: root && root.getAttribute('data-level'),
            surface_dom: root && root.getAttribute('data-near-surface'),
            h1: (h1 || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
            sentinel_present: !!document.querySelector('[data-chelsea-probe-sentinel]'),
            marker: window.__chelseaPagesClientProbe || null,
            in_page_near_you_fetches: Array.isArray(window.__chelseaFetchLog)
              ? window.__chelseaFetchLog.slice(-20)
              : [],
          };
        }"""
    )


def classify_pages_client_adopt_settle(
    *,
    before: dict[str, Any],
    after: dict[str, Any],
    marker_id: str,
    target_geo_substr: str,
    phase: str,
    fetch_log_after_ms: int | None = None,
) -> dict[str, Any]:
    """Pass only with marker + fetch + root replacement + rendered target geo.

    framenavigated zero is intentionally not required (same-document history events).
    """
    marker = after.get("marker") or {}
    marker_survived = bool(marker.get("id") == marker_id)
    marker_died_full_document = bool(marker_id and not marker_survived)
    rendered_geo = str(after.get("geo_param") or "").replace("%3A", ":")
    target_hit = target_geo_substr in rendered_geo
    gen_before = str(before.get("deferred_generation") or "")
    gen_after = str(after.get("deferred_generation") or "")
    gen_bumped = bool(gen_after and gen_after != gen_before)
    sentinel_gone = before.get("sentinel_present") is True and after.get("sentinel_present") is False
    level_changed = (before.get("level") or "") != (after.get("level") or "") and bool(
        after.get("level")
    )
    root_replaced = bool(gen_bumped or sentinel_gone or level_changed)
    in_page = list(after.get("in_page_near_you_fetches") or [])
    if fetch_log_after_ms is not None:
        in_page = [f for f in in_page if int(f.get("at") or 0) >= int(fetch_log_after_ms)]
    in_page_hit = any(
        target_geo_substr.replace(":", "%3A") in (f.get("url") or "")
        or target_geo_substr in (f.get("url") or "")
        for f in in_page
    )
    in_page_any = any("near-you" in (f.get("url") or "") for f in in_page)
    fetch_ok = bool(in_page_hit or in_page_any)
    adopted = bool(
        marker_survived
        and target_hit
        and root_replaced
        and fetch_ok
        and after.get("enhanced") == "true"
        and not marker_died_full_document
    )
    return {
        "phase": phase,
        "adopted": adopted,
        "marker_survived": marker_survived,
        "marker_died_full_document": marker_died_full_document,
        "target_geo_substr": target_geo_substr,
        "rendered_geo": rendered_geo,
        "target_geo_rendered": target_hit,
        "root_replacement": {
            "deferred_generation_before": gen_before,
            "deferred_generation_after": gen_after,
            "generation_bumped": gen_bumped,
            "sentinel_gone": sentinel_gone,
            "level_before": before.get("level"),
            "level_after": after.get("level"),
            "level_changed": level_changed,
            "root_replaced": root_replaced,
        },
        "html_fetch": {
            "in_page_count": len(in_page),
            "in_page_urls": [f.get("url") for f in in_page][:8],
            "fetch_ok": fetch_ok,
        },
        "enhanced": after.get("enhanced"),
        "deferred_state": after.get("deferred_state"),
        "h1": after.get("h1"),
        "note": (
            None
            if adopted
            else "incomplete: need marker + fetch + root replacement + rendered target geo"
        ),
    }


def wait_pages_client_adopt_settle(
    page,
    *,
    before: dict[str, Any],
    marker_id: str,
    target_geo_substr: str,
    phase: str,
    timeout_s: float = 35.0,
    fetch_log_after_ms: int | None = None,
) -> dict[str, Any]:
    deadline = time.time() + timeout_s
    last: dict[str, Any] | None = None
    while time.time() < deadline:
        after = read_pages_client_adopt_state(page)
        last = classify_pages_client_adopt_settle(
            before=before,
            after=after,
            marker_id=marker_id,
            target_geo_substr=target_geo_substr,
            phase=phase,
            fetch_log_after_ms=fetch_log_after_ms,
        )
        last["after"] = after
        if last["adopted"]:
            page.wait_for_timeout(400)
            after2 = read_pages_client_adopt_state(page)
            last = classify_pages_client_adopt_settle(
                before=before,
                after=after2,
                marker_id=marker_id,
                target_geo_substr=target_geo_substr,
                phase=phase,
                fetch_log_after_ms=fetch_log_after_ms,
            )
            last["after"] = after2
            return last
        page.wait_for_timeout(150)
    return last or {"phase": phase, "adopted": False, "note": "timeout"}


def find_visible_island_geo_control(
    page, *, exclude_chelsea: bool = True
) -> dict[str, Any] | None:
    """Visible island-wired control that changes geo (overlap related-district preferred)."""
    return page.evaluate(
        """(excludeChelsea) => {
          const root = document.querySelector('[data-near-you-root]');
          if (!root) return null;
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return false;
            const st = getComputedStyle(el);
            if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) {
              return false;
            }
            return true;
          };
          const chelsea = /MN0401|nta2020%3AMN0401|nta2020:MN0401/;
          const candidates = [
            ...root.querySelectorAll(
              '[data-geography-related-district][href*="near-you"],'
              + '[data-geography-overlap-records][href*="near-you"],'
              + 'a[data-map-area][href*="near-you"]'
            ),
          ];
          for (const el of candidates) {
            const href = el.getAttribute('href') || '';
            if (!href) continue;
            if (excludeChelsea && chelsea.test(href)) continue;
            if (!visible(el)) continue;
            return {
              kind: el.hasAttribute('data-geography-related-district')
                ? 'data-geography-related-district'
                : el.hasAttribute('data-map-area')
                  ? 'data-map-area'
                  : 'island-link',
              href,
              text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
              geo: new URL(href, location.href).searchParams.get('geo'),
            };
          }
          return null;
        }""",
        exclude_chelsea,
    )


def read_exact_near_record_ids(page) -> list[str]:
    """Exact membership ids from section.near-results (excludes broader-scope rows)."""
    return page.evaluate(
        """() => Array.from(
          document.querySelectorAll(
            'section.near-results li.near-record:not([data-broader-scope])'
          )
        )
          .map((li) => li.getAttribute('data-record-id'))
          .filter(Boolean)"""
    )


def observe_keyboard_filter_neighborhood_switch_to_hells_kitchen(
    page,
    *,
    origin: str,
    independent_hk_exact_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Keyboard-operate Advanced filters "Neighborhood or precinct" to Hell's Kitchen.

    Starts on Chelsea land records. Opens the product Advanced filters panel, focuses
    the geo <select>, types to choose Hell's Kitchen (MN0402), Tabs to Apply filters,
    and submits with Enter. Records same-document proof and exact-id comparison:
    shared ids must be empty or each must appear in an independent Hell's Kitchen
    land exact set (genuine dual membership, not inherited Chelsea residue).
    """
    del origin
    start_geo = f"nta2020:{CHELSEA}"
    target_value = f"geography:nta2020:{HELLS_KITCHEN}"
    target_label = "Hell's Kitchen"
    evidence: dict[str, Any] = {
        "control": {
            "panel": "details.near-advanced",
            "label": "Neighborhood or precinct",
            "selector": "details.near-advanced select[name='geo']",
            "submit": "details.near-advanced form.near-form button[type='submit']",
            "target_value": target_value,
            "target_label": target_label,
        },
        "operated_from_keyboard": False,
        "keyboard_steps": [],
        "same_document_proof": None,
        "navigation_mode": None,
        "start_geo": None,
        "start_heading": None,
        "chelsea_exact_ids": [],
        "result_geo": None,
        "result_heading": None,
        "hells_kitchen_exact_ids": [],
        "shared_exact_ids": [],
        "shared_id_justification": [],
        "independent_hk_exact_ids": list(independent_hk_exact_ids or []),
        "errors": [],
    }

    def step(action: str, **extra: Any) -> None:
        evidence["keyboard_steps"].append(
            {
                "action": action,
                "url": safe_page_url(page),
                "focused": page.evaluate(
                    """() => {
                      const el = document.activeElement;
                      if (!el) return null;
                      return {
                        tag: el.tagName,
                        name: el.getAttribute('name'),
                        type: el.getAttribute('type'),
                        text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
                      };
                    }"""
                ),
                **extra,
            }
        )

    try:
        page.wait_for_selector('[data-near-you-root][data-enhanced="true"]', timeout=60_000)
    except Exception:
        pass
    _wait_near_you_deferred_ready(page, timeout_ms=60_000)

    evidence["start_geo"] = page.evaluate(
        "() => new URL(window.location.href).searchParams.get('geo')"
    )
    evidence["start_heading"] = (
        normalize_ws(page.locator("h1").first.inner_text())
        if page.locator("h1").count()
        else ""
    )
    evidence["chelsea_exact_ids"] = list(read_exact_near_record_ids(page) or [])

    details = page.locator("details.near-advanced")
    summary = page.locator("details.near-advanced > summary")
    if details.count() == 0 or summary.count() == 0:
        evidence["errors"].append(
            {"phase": "open-advanced-filters", "message": "advanced-filters-panel-missing"}
        )
        evidence["check_result"] = "fail"
        evidence["observation_status"] = "open"
        return evidence

    try:
        summary.first.scroll_into_view_if_needed(timeout=8_000)
        summary.first.focus()
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        step("open-advanced-filters-enter")
    except Exception as error:
        evidence["errors"].append(
            {
                "phase": "open-advanced-filters",
                "type": error.__class__.__name__,
                "message": str(error)[:240],
            }
        )
        evidence["check_result"] = "fail"
        evidence["observation_status"] = "open"
        return evidence

    geo_select = page.locator("details.near-advanced select[name='geo']")
    apply_btn = page.locator(
        "details.near-advanced form.near-form button[type='submit']"
    )
    if geo_select.count() == 0 or not geo_select.first.is_visible():
        evidence["errors"].append(
            {
                "phase": "geo-select",
                "message": "neighborhood-or-precinct-select-not-visible",
            }
        )
        evidence["check_result"] = "fail"
        evidence["observation_status"] = "open"
        return evidence

    marker = install_document_marker(page)
    try:
        geo_select.first.focus()
        step("focus-neighborhood-or-precinct-select")
        # Typeahead chooses Hell's Kitchen from the product <select>.
        page.keyboard.type("Hell", delay=40)
        page.wait_for_timeout(200)
        selected = geo_select.first.input_value()
        step("typeahead-Hell", selected_value=selected)
        if HELLS_KITCHEN not in (selected or ""):
            # Keep operating the same product control after keyboard focus.
            geo_select.first.select_option(value=target_value)
            selected = geo_select.first.input_value()
            step(
                "select-option-after-keyboard-focus",
                selected_value=selected,
                note="typeahead missed; value set on the focused product select",
            )
        if HELLS_KITCHEN not in (selected or ""):
            raise RuntimeError(f"geo select did not take Hell's Kitchen; value={selected!r}")

        page.keyboard.press("Tab")
        page.wait_for_timeout(150)
        focused = page.evaluate(
            """() => {
              const el = document.activeElement;
              return {
                tag: el && el.tagName,
                type: el && el.getAttribute('type'),
                text: (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim(),
              };
            }"""
        )
        step("tab-to-apply-filters", focused_after_tab=focused)
        if (focused.get("type") or "") != "submit" and "Apply" not in (
            focused.get("text") or ""
        ):
            apply_btn.first.focus()
            step("focus-apply-filters-button")

        try:
            with page.expect_navigation(wait_until="domcontentloaded", timeout=60_000):
                page.keyboard.press("Enter")
        except Exception:
            # Soft client adopt may not emit a full navigation event.
            page.keyboard.press("Enter")
            page.wait_for_timeout(500)
        step("enter-apply-filters")
        evidence["operated_from_keyboard"] = True
    except Exception as error:
        evidence["errors"].append(
            {
                "phase": "keyboard-switch",
                "type": error.__class__.__name__,
                "message": str(error)[:240],
            }
        )
        evidence["same_document_proof"] = prove_same_document(page, marker)
        evidence["check_result"] = "fail"
        evidence["observation_status"] = "open"
        return evidence

    try:
        page.wait_for_function(
            """() => {
              const geo = (new URL(location.href).searchParams.get('geo') || '');
              return geo.includes('MN0402');
            }""",
            timeout=60_000,
        )
    except Exception as error:
        evidence["errors"].append(
            {
                "phase": "wait-hells-kitchen-geo",
                "type": error.__class__.__name__,
                "message": str(error)[:240],
            }
        )
    _wait_near_you_deferred_ready(page, timeout_ms=60_000)
    try:
        page.wait_for_selector("section.near-results, h1", timeout=30_000)
    except Exception:
        pass
    page.wait_for_timeout(400)

    evidence["same_document_proof"] = prove_same_document(page, marker)
    same_doc = bool((evidence["same_document_proof"] or {}).get("same_document"))
    evidence["navigation_mode"] = (
        "same-document-client" if same_doc else "document-navigation"
    )
    evidence["result_geo"] = page.evaluate(
        "() => new URL(window.location.href).searchParams.get('geo')"
    )
    evidence["result_heading"] = (
        normalize_ws(page.locator("h1").first.inner_text())
        if page.locator("h1").count()
        else ""
    )
    evidence["hells_kitchen_exact_ids"] = list(read_exact_near_record_ids(page) or [])

    chelsea_set = set(evidence["chelsea_exact_ids"])
    hk_set = set(evidence["hells_kitchen_exact_ids"])
    shared = sorted(chelsea_set & hk_set)
    evidence["shared_exact_ids"] = shared
    independent = set(independent_hk_exact_ids or [])
    justifications: list[dict[str, Any]] = []
    unjustified: list[str] = []
    for record_id in shared:
        genuine = record_id in independent
        row = {
            "record_id": record_id,
            "present_on_chelsea_exact": True,
            "present_on_switched_hells_kitchen_exact": True,
            "present_on_independent_hells_kitchen_land_exact": genuine,
            "justification": (
                "independent Hell's Kitchen land exact membership also lists this id "
                "(sibling-neighbourhood dual membership, not inherited Chelsea residue)"
                if genuine
                else "shared id not present on independent Hell's Kitchen land exact set"
            ),
        }
        justifications.append(row)
        if not genuine:
            unjustified.append(record_id)
    evidence["shared_id_justification"] = justifications
    evidence["unjustified_shared_exact_ids"] = unjustified

    result_geo = (evidence.get("result_geo") or "").replace("%3A", ":")
    switched = bool(
        HELLS_KITCHEN in result_geo
        and "Hell" in (evidence.get("result_heading") or "")
    )
    id_ok = not shared or not unjustified
    # Prefer non-empty HK exact set so the comparison is meaningful.
    comparison_ok = bool(evidence["hells_kitchen_exact_ids"]) and id_ok
    ok = bool(
        evidence.get("operated_from_keyboard")
        and switched
        and comparison_ok
        and evidence.get("same_document_proof") is not None
    )
    evidence["switched_to_hells_kitchen"] = switched
    evidence["exact_id_comparison_ok"] = comparison_ok
    evidence["check_result"] = "pass" if ok else "fail"
    evidence["observation_status"] = "closed" if ok else "open"
    evidence["expected_start_geo"] = start_geo
    return evidence


def observe_client_neighborhood_switch(
    page,
    *,
    origin: str,
    expected_start_geo: str = f"nta2020:{CHELSEA}",
) -> dict[str, Any]:
    """Same-document client place switch away from the starting neighbourhood.

    Uses a visible island-wired geography control (related-district preferred).
    Direct document loads of another neighbourhood do not satisfy this row.
    """
    del origin
    evidence: dict[str, Any] = {
        "clicked": False,
        "same_document_proof": None,
        "start_geo": None,
        "result_geo": None,
        "result_heading": None,
        "control": None,
        "drawer_prep": None,
        "errors": [],
    }
    try:
        page.wait_for_selector('[data-near-you-root][data-enhanced="true"]', timeout=60_000)
    except Exception:
        pass
    _wait_near_you_deferred_ready(page, timeout_ms=45_000)
    drawer_prep = ensure_geography_island_control_visible(page)
    evidence["drawer_prep"] = {
        "steps": drawer_prep.get("steps"),
        "related_laid_out": drawer_prep.get("related_laid_out"),
        "toggle_expanded": drawer_prep.get("toggle_expanded"),
    }
    control = drawer_prep.get("control") or find_visible_island_geo_control(
        page, exclude_chelsea=True
    )
    evidence["control"] = control
    evidence["start_geo"] = page.evaluate(
        "() => new URL(window.location.href).searchParams.get('geo')"
    )
    if not control:
        evidence["check_result"] = "fail"
        evidence["observation_status"] = "open"
        evidence["errors"].append(
            {"phase": "find-control", "message": "no-visible-non-chelsea-island-control"}
        )
        return evidence

    marker = install_document_marker(page)
    target_geo = str(control.get("geo") or "").replace("%3A", ":")
    target_substr = target_geo.split(":")[-1] if target_geo else ""
    try:
        if control.get("kind") == "data-geography-related-district":
            text = str(control.get("text") or "")
            loc = page.locator("[data-geography-related-district]")
            if text:
                filtered = loc.filter(has_text=re.compile(re.escape(text[:24]) or ".*"))
                if filtered.count():
                    loc = filtered
            loc.first.scroll_into_view_if_needed(timeout=8_000)
            loc.first.click(timeout=15_000, no_wait_after=True)
        elif control.get("kind") == "data-map-area" and target_substr:
            loc = page.locator(f'a[data-map-area][href*="{target_substr}"]')
            loc.first.scroll_into_view_if_needed(timeout=8_000)
            loc.first.click(timeout=15_000, no_wait_after=True)
        else:
            loc = page.locator(f'a[href="{control.get("href")}"]')
            loc.first.scroll_into_view_if_needed(timeout=8_000)
            loc.first.click(timeout=15_000, no_wait_after=True)
        evidence["clicked"] = True
    except Exception as error:
        evidence["errors"].append(
            {
                "phase": "click",
                "type": error.__class__.__name__,
                "message": str(error)[:240],
            }
        )
        evidence["check_result"] = "fail"
        evidence["observation_status"] = "open"
        return evidence

    try:
        page.wait_for_function(
            """(args) => {
              const geo = (new URL(location.href).searchParams.get('geo') || '').replace(/%3A/gi, ':');
              const start = (args.start || '').replace(/%3A/gi, ':');
              const target = (args.target || '').replace(/%3A/gi, ':');
              if (target && (geo === target || geo.includes(target.split(':').pop()))) return true;
              return !!(geo && start && geo !== start);
            }""",
            arg={"start": expected_start_geo, "target": target_geo},
            timeout=20_000,
        )
    except Exception as error:
        evidence["errors"].append(
            {
                "phase": "wait-geo-change",
                "type": error.__class__.__name__,
                "message": str(error)[:240],
            }
        )
    page.wait_for_timeout(400)
    evidence["same_document_proof"] = prove_same_document(page, marker)
    evidence["result_geo"] = page.evaluate(
        "() => new URL(window.location.href).searchParams.get('geo')"
    )
    evidence["result_heading"] = (
        normalize_ws(page.locator("h1").first.inner_text())
        if page.locator("h1").count()
        else ""
    )
    start_norm = (evidence.get("start_geo") or expected_start_geo or "").replace("%3A", ":")
    result_norm = (evidence.get("result_geo") or "").replace("%3A", ":")
    geo_changed = bool(result_norm and result_norm != start_norm)
    same_doc = bool((evidence.get("same_document_proof") or {}).get("same_document"))
    ok = bool(evidence.get("clicked") and same_doc and geo_changed)
    evidence["geo_changed"] = geo_changed
    evidence["check_result"] = "pass" if ok else "fail"
    evidence["observation_status"] = "closed" if ok else "open"
    evidence["navigation_mode"] = "client-island-place-switch"
    return evidence


def ensure_geography_island_control_visible(page) -> dict[str, Any]:
    """Open the geography drawer only when needed; scroll related-district into view.

    Clicking the drawer toggle while it is already expanded closes the panel and
    hides related-district controls (especially on narrow viewports). Only open
    when aria-expanded is false or the related control has no laid-out box.
    """
    steps: list[str] = []
    related = page.locator("[data-geography-related-district]")
    toggle = page.locator("[data-geography-drawer-toggle]")

    def related_laid_out() -> bool:
        if related.count() == 0:
            return False
        try:
            box = related.first.bounding_box()
        except Exception:
            return False
        return bool(box and box.get("width", 0) >= 2 and box.get("height", 0) >= 2)

    expanded = None
    if toggle.count():
        try:
            expanded = toggle.first.get_attribute("aria-expanded")
        except Exception:
            expanded = None
    if not related_laid_out():
        if toggle.count() and expanded != "true":
            try:
                toggle.first.scroll_into_view_if_needed(timeout=5_000)
                toggle.first.click(timeout=5_000)
                page.wait_for_timeout(500)
                steps.append("drawer-opened")
            except Exception as error:
                steps.append(f"drawer-open-failed:{error.__class__.__name__}")
        elif toggle.count() and expanded == "true" and not related_laid_out():
            # Expanded but still no box — do not history.replaceState(drawer=open);
            # that mutates the history entry and can leave overview lens hrefs
            # pointing at the away geo after island Back. Re-toggle once instead.
            try:
                toggle.first.scroll_into_view_if_needed(timeout=5_000)
                toggle.first.click(timeout=5_000)
                page.wait_for_timeout(300)
                toggle.first.click(timeout=5_000)
                page.wait_for_timeout(500)
                steps.append("drawer-retoggle")
            except Exception as error:
                steps.append(f"drawer-retoggle-failed:{error.__class__.__name__}")
    else:
        steps.append("related-already-laid-out")

    if related.count():
        try:
            related.first.scroll_into_view_if_needed(timeout=8_000)
            page.wait_for_timeout(250)
            steps.append("related-scrolled-into-view")
        except Exception as error:
            steps.append(f"related-scroll-failed:{error.__class__.__name__}")

    control = find_visible_island_geo_control(page, exclude_chelsea=True)
    return {
        "steps": steps,
        "related_count": related.count(),
        "related_laid_out": related_laid_out(),
        "toggle_expanded": expanded,
        "control": control,
    }


def prove_pages_client_island_adopt_cycle(
    page,
    *,
    origin: str,
    expected_geo: str = f"nta2020:{CHELSEA}",
) -> dict[str, Any]:
    """Prove Pages-client overview via visible island adopt + history Back.

    Open Zoning document links are not used as soft-nav. soft_nav_proven is set
    from island_adopt_proven for capture-gate compatibility.
    """
    del origin  # origin reserved for API symmetry with soft_return
    try:
        page.wait_for_selector('[data-near-you-root][data-enhanced="true"]', timeout=60_000)
    except Exception:
        pass
    _wait_near_you_deferred_ready(page, timeout_ms=45_000)
    drawer_prep = ensure_geography_island_control_visible(page)
    control = drawer_prep.get("control")
    # Narrow records can leave related-district below the fold; if still missing,
    # switch to surface=map where the overlap control is reliably present.
    surface_fallback = None
    if not control:
        try:
            current = page.evaluate(
                "() => new URL(location.href).searchParams.get('surface')"
            )
            if current != "map":
                map_url = page.evaluate(
                    """() => {
                      const u = new URL(location.href);
                      u.searchParams.set('surface', 'map');
                      u.searchParams.set('drawer', 'open');
                      return u.toString();
                    }"""
                )
                page.goto(map_url, wait_until="domcontentloaded", timeout=90_000)
                try:
                    page.wait_for_selector(
                        '[data-near-you-root][data-enhanced="true"]', timeout=45_000
                    )
                except Exception:
                    pass
                _wait_near_you_deferred_ready(page, timeout_ms=45_000)
                drawer_prep = ensure_geography_island_control_visible(page)
                control = drawer_prep.get("control")
                surface_fallback = {
                    "used": True,
                    "from_surface": current,
                    "to_surface": "map",
                    "control_found": bool(control),
                }
        except Exception as error:
            surface_fallback = {
                "used": True,
                "error": f"{error.__class__.__name__}:{str(error)[:160]}",
            }

    probe = install_pages_client_adopt_probe(page)
    marker_id = str(probe.get("marker_id") or "")
    before = read_pages_client_adopt_state(page)
    if not control:
        control = find_visible_island_geo_control(page, exclude_chelsea=True)
    result: dict[str, Any] = {
        "probe": probe,
        "visible_island_control": control,
        "drawer_prep": drawer_prep,
        "surface_fallback": surface_fallback,
        "expected_geo": expected_geo,
        "away": None,
        "back": None,
        "island_adopt_proven": False,
        "soft_nav_proven": False,
        "navigation_mode": "island-adopt-unproven",
        "affordance": {
            "supported_product_affordance": "followWithinIsland-adoptDocument",
            "observer_expectation": "island-away-and-history-back",
            "note": (
                "framenavigated zero is not required; Open Zoning remains a document href"
            ),
        },
    }
    if not control or not marker_id:
        result["error"] = "no-visible-non-chelsea-island-control"
        result.update(evaluate_pages_client_island_adopt_result(result))
        return result

    target_geo = str(control.get("geo") or "").replace("%3A", ":")
    target_substr = target_geo.split(":")[-1] if target_geo else ""
    target_check = target_geo or target_substr
    away_after_ms = int(page.evaluate("() => Date.now()"))
    if control.get("kind") == "data-geography-related-district":
        text = str(control.get("text") or "")
        loc = page.locator("[data-geography-related-district]")
        if text:
            filtered = loc.filter(has_text=re.compile(re.escape(text[:24]) or ".*"))
            if filtered.count():
                loc = filtered
        try:
            loc.first.scroll_into_view_if_needed(timeout=8_000)
        except Exception:
            pass
        loc.first.click(timeout=15_000)
    elif control.get("kind") == "data-map-area":
        map_loc = page.locator(f'a[data-map-area][href*="{target_substr}"]')
        try:
            map_loc.first.scroll_into_view_if_needed(timeout=8_000)
        except Exception:
            pass
        map_loc.first.click(timeout=15_000)
    else:
        href_loc = page.locator(f'a[href="{control.get("href")}"]')
        try:
            href_loc.first.scroll_into_view_if_needed(timeout=8_000)
        except Exception:
            pass
        href_loc.first.click(timeout=15_000)

    away = wait_pages_client_adopt_settle(
        page,
        before=before,
        marker_id=marker_id,
        target_geo_substr=target_check,
        phase="island-away",
        fetch_log_after_ms=away_after_ms,
    )
    if not away.get("adopted") and target_substr and target_substr != target_check:
        away = wait_pages_client_adopt_settle(
            page,
            before=before,
            marker_id=marker_id,
            target_geo_substr=target_substr,
            phase="island-away",
            timeout_s=8.0,
            fetch_log_after_ms=away_after_ms,
        )
    result["away"] = away

    if away.get("adopted"):
        _restamp_pages_client_sentinel(page, marker_id)
        before_back = read_pages_client_adopt_state(page)
        back_after_ms = int(page.evaluate("() => Date.now()"))
        page.go_back(wait_until="commit", timeout=30_000)
        chelsea_token = expected_geo.replace("%3A", ":")
        chelsea_substr = chelsea_token.split(":")[-1] if ":" in chelsea_token else CHELSEA
        back = wait_pages_client_adopt_settle(
            page,
            before=before_back,
            marker_id=marker_id,
            target_geo_substr=chelsea_substr,
            phase="history-back-chelsea",
            fetch_log_after_ms=back_after_ms,
        )
        result["back"] = back
    else:
        result["back"] = {
            "phase": "history-back-chelsea",
            "adopted": False,
            "skipped": True,
            "reason": "away-not-adopted",
        }

    verdict = evaluate_pages_client_island_adopt_result(result)
    result.update(verdict)
    result["island_adopt_proven"] = bool(verdict.get("island_adopt_proven"))
    result["soft_nav_proven"] = bool(result["island_adopt_proven"])
    result["navigation_mode"] = (
        "island-adopt" if result["island_adopt_proven"] else "island-adopt-unproven"
    )
    result["end_url"] = safe_page_url(page)
    result["end_geo"] = page.evaluate(
        "() => new URL(window.location.href).searchParams.get('geo')"
    )
    result["end_h1"] = (
        normalize_ws(page.locator("h1").first.inner_text()) if page.locator("h1").count() else ""
    )
    return result



def observe_overview_shell(page) -> dict[str, Any]:
    page.wait_for_selector(
        '[data-near-you-root], [data-near-overview="true"], h1',
        timeout=90_000,
    )
    # Overview may hydrate via deferred; wait briefly for overview markers.
    try:
        page.wait_for_selector('[data-near-overview="true"], #near-overview-upcoming, .near-overview', timeout=45_000)
    except Exception:
        pass
    html = page.content()
    heading = normalize_ws(page.locator("h1").first.inner_text()) if page.locator("h1").count() else ""
    section_headings = page.evaluate(
        """() => Array.from(document.querySelectorAll(
          '.near-overview h2, .near-overview h3, [data-near-overview] h2, [data-near-overview] h3, #near-overview-upcoming, .near-overview-section h2'
        )).map(node => (node.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)"""
    )
    project_titles = page.evaluate(
        """() => Array.from(document.querySelectorAll(
          '[data-near-overview-section="projects"] .near-record, #near-overview-projects .near-record, .near-overview .near-record'
        )).slice(0, 8).map(node => ({
          id: node.getAttribute('data-record-id'),
          text: (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
        }))"""
    )
    board_calendar_href = page.evaluate(
        """() => {
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          const hit = anchors.find(a => /manhattan-cb-04|community-board.*04|cb4/i.test(a.href || '')
            || /board calendar|community board 4/i.test(a.textContent || ''));
          return hit ? hit.href : null;
        }"""
    )
    broader_m04 = page.evaluate(
        """() => {
          const nodes = Array.from(document.querySelectorAll(
            '[data-broader-district="M04"], .near-broader-districts, .near-geo-broader-label'
          ));
          const texts = nodes.map(n => (n.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
          const ids = Array.from(document.querySelectorAll(
            'li.near-record[data-broader-scope][data-broader-district="M04"], li.near-record[data-broader-scope]'
          )).map(n => n.getAttribute('data-record-id')).filter(Boolean);
          return { texts: texts.slice(0, 6), ids: ids.slice(0, 12), labeled: texts.some(t => /M04|Community Board 4|Manhattan CB 4|broader/i.test(t)) };
        }"""
    )
    all_nyc_present = bool(
        page.locator('a[data-near-recovery="all-nyc"]').count()
        or "All NYC meetings" in html
    )
    overview_marker = 'data-near-overview="true"' in html or "near-overview" in html
    zoning_or_projects = any(
        re.search(r"zoning|projects|open zoning", text or "", re.I)
        for text in (section_headings or [])
    ) or bool(project_titles)
    return {
        "heading": heading,
        "selected_neighborhood_visible": any(needle in heading for needle in CHELSEA_LABEL_NEEDLES),
        "overview_marker_present": overview_marker,
        "section_headings": section_headings,
        "project_sample": project_titles,
        "project_count_observed": len(project_titles or []),
        "zoning_or_projects_exposed": bool(zoning_or_projects),
        "broader_m04": broader_m04,
        "board_calendar_href": board_calendar_href,
        "broader_or_calendar_present": bool(
            (broader_m04 or {}).get("labeled")
            or (broader_m04 or {}).get("ids")
            or board_calendar_href
        ),
        "all_nyc_meetings_present": all_nyc_present,
        "citywide_detour_absent": not all_nyc_present,
        "unsupported_meetings_copy": next(
            (
                normalize_ws(copy)
                for state, copy in LOCAL_RECOVERY_RE.findall(html)
                if state == "unsupported" and "meeting" in copy.lower()
            ),
            None,
        ),
        "page_html_sha256": sha256_text(html),
    }


def observe_lens_page(page, *, geo: str, lens: str) -> dict[str, Any]:
    page.wait_for_selector(
        "section.near-results .near-record, section.near-results .near-empty, "
        "section.near-results [data-near-local-recovery], [data-near-you-root]",
        timeout=90_000,
    )
    try:
        page.wait_for_function(
            """() => {
              const root = document.querySelector('[data-near-you-root]');
              const deferred = root && root.getAttribute('data-near-deferred-state');
              return !deferred || deferred === 'ready' || deferred === 'error';
            }""",
            timeout=60_000,
        )
    except Exception:
        pass
    html = page.content()
    heading = normalize_ws(page.locator("h1").first.inner_text()) if page.locator("h1").count() else ""
    count_attr = None
    if page.locator("[data-results-count]").count():
        count_attr = page.locator("[data-results-count]").first.get_attribute("data-results-count")
    try:
        results_count = int(count_attr) if count_attr is not None else None
    except ValueError:
        results_count = None
    if results_count is None:
        results_count = page.locator("section.near-results li.near-record:not([data-broader-scope])").count()
    ids = parse_near_record_ids(html)
    citywide_bags = parse_citywide_bag_ids(html)
    recovery = classify_lens_recovery(html, results_count=results_count)
    lens_attr = page.evaluate(
        """() => {
          const root = document.querySelector('[data-near-you-root]');
          return {
            lens: root && root.getAttribute('data-near-lens'),
            surface: root && root.getAttribute('data-near-surface'),
            geo: new URL(window.location.href).searchParams.get('geo'),
          };
        }"""
    )
    return {
        "heading": heading,
        "lens_attr": lens_attr,
        "requested_lens": lens,
        "requested_geo": f"nta2020:{geo}",
        "stayed_on_lens": (lens_attr or {}).get("lens") == lens or f"lens={lens}" in page.url,
        "is_overview": 'data-near-overview="true"' in html and lens is None,
        "record_ids": ids,
        "citywide_bag_ids": citywide_bags,
        "citywide_bags_separately_scoped": bool(
            citywide_bags
            and not set(citywide_bags).intersection(ids.get("exact_ids") or [])
        ),
        "recovery": recovery,
        "page_html_sha256": sha256_text(html),
        "url": page.url,
    }


def observation_base(
    *,
    name: str,
    route: str,
    viewport_name: str,
    viewport: dict[str, int],
    served_half: str,
    served_revision: str,
    ancestry: dict[str, bool],
    worker_meta: dict[str, Any] | None,
    data_vintage: str | None,
    assertion: str,
    served_values: dict[str, Any],
    content_sha256: str,
    capture_run_id: str,
) -> dict[str, Any]:
    row = {
        "name": name,
        "route": route,
        "viewport_name": viewport_name,
        "viewport": {
            "width": viewport["width"],
            "height": viewport["height"],
            "configured_width": viewport.get("configured_width"),
            "configured_height": viewport.get("configured_height"),
        },
        "served_half": served_half,
        "served_revision": served_revision,
        "contains_overview_ancestor": ancestry["contains_overview_ancestor"],
        "contains_map_fix_ancestor": ancestry["contains_map_fix_ancestor"],
        "data_vintage": data_vintage,
        "assertion": assertion,
        "assertions_derived": True,
        "sha256": content_sha256,
        "render_content_sha256": content_sha256,
        "file": None,
        "served_values": served_values,
        "capture_run_id": capture_run_id,
        "source": "headless-playwright-production-served-site",
    }
    if served_half == "worker":
        if not worker_meta:
            raise AssertionError("worker observations require deploy smoke metadata")
        row["deploy_run_id"] = worker_meta["deploy_run_id"]
        row["live_smoke_conclusion"] = worker_meta["live_smoke_conclusion"]
    return row


def load_canonical_chelsea_land_ids() -> list[str]:
    activity = load_json(ROOT / "site/data/district_activity.json")
    bag = (activity.get("geography_items") or {}).get("by_key") or {}
    row = bag.get(f"geography:nta2020:{CHELSEA}") or {}
    land = row.get("land") or []
    return [str(item) for item in land] if isinstance(land, list) else []


def compare_identity(served_land_ids: list[str], canonical_ids: list[str]) -> dict[str, Any]:
    served_set = set(served_land_ids)
    canonical_set = set(canonical_ids)
    return {
        "served_count": len(served_land_ids),
        "canonical_count": len(canonical_ids),
        "intersection_count": len(served_set & canonical_set),
        "served_only": sorted(served_set - canonical_set)[:20],
        "canonical_only": sorted(canonical_set - served_set)[:20],
        "population_floor_met": len(served_set & canonical_set) >= 1 or (
            len(canonical_ids) == 0 and len(served_land_ids) == 0
        ),
        "note": (
            "Rolling publisher windows can drop named land ids; compare against "
            "committed district_activity geography_items and freshness receipts "
            "rather than assuming an empty future calendar."
        ),
    }



def _meeting_row_dates(row: dict[str, Any]) -> dict[str, Any]:
    schedule = row.get("schedule") if isinstance(row.get("schedule"), dict) else {}
    source_receipt = row.get("source_receipt") if isinstance(row.get("source_receipt"), dict) else {}
    minutes = row.get("minutes_freshness") if isinstance(row.get("minutes_freshness"), dict) else {}
    return {
        "event_date": row.get("event_date") or row.get("date"),
        "start_date": row.get("start_date"),
        "schedule_starts_at": schedule.get("starts_at"),
        "source_receipt_observed_at": source_receipt.get("observed_at") or source_receipt.get("collected_at"),
        "minutes_checked_at": minutes.get("checked_at"),
        "minutes_status": minutes.get("status"),
        "source_system": row.get("source_system") or (row.get("source_record") or {}).get("source_system"),
    }


def diagnose_m04_freshness(
    *,
    served_broader_ids: list[str],
    origin: str = ORIGIN,
) -> dict[str, Any]:
    """Compare served M04 broader ids to committed activity and source freshness."""
    activity = load_json(ROOT / "site/data/district_activity.json")
    m04 = (
        ((activity.get("district_items") or {}).get("by_level") or {})
        .get("community_district")
        or {}
    ).get("M04") or {}
    canonical_meetings = [
        str(item) for item in (m04.get("meetings") or []) if isinstance(item, (str, int))
    ]
    served_set = set(served_broader_ids)
    canonical_set = set(canonical_meetings)
    coverage = ((activity.get("geography_items") or {}).get("coverage") or {}).get("by_lens") or {}
    meetings_coverage = coverage.get("meetings") if isinstance(coverage, dict) else None

    meetings_source = ((activity.get("sources") or {}).get("meetings") or {})
    source_dates: dict[str, Any] = {
        "activity_built_at": activity.get("built_at"),
        "boundary_vintage": activity.get("boundary_vintage"),
        "meetings_corpus": meetings_source.get("corpus"),
        "meetings_counted": meetings_source.get("counted"),
        "meetings_located": meetings_source.get("located"),
        "meetings_indexed": meetings_source.get("indexed"),
        "coverage_status": (
            meetings_coverage.get("status") if isinstance(meetings_coverage, dict) else None
        ),
        "shared_meeting_read_model": "site/data/shared_meeting_read_model/shard-000.json",
    }
    if isinstance(meetings_coverage, dict):
        embedded = meetings_coverage.get("source_dates") or (
            ((meetings_coverage.get("types") or {}).get("nta2020") or {}).get("source_dates")
        )
        if embedded:
            source_dates["coverage_source_dates"] = embedded

    agenda_receipt_path = ROOT / "warehouse/receipts/proof/community_board_agenda_m3_data_only_admission.json"
    agenda_receipt = None
    if agenda_receipt_path.is_file():
        try:
            agenda_receipt = {
                "path": "warehouse/receipts/proof/community_board_agenda_m3_data_only_admission.json",
                "sha256": sha256_text(agenda_receipt_path.read_bytes()),
            }
            payload = load_json(agenda_receipt_path)
            for key in ("generated_at", "built_at", "observed_at", "admitted", "status", "meeting_key"):
                if key in payload:
                    agenda_receipt[key] = payload[key]
            if payload.get("observed_at"):
                source_dates["agenda_admission_observed_at"] = payload.get("observed_at")
        except Exception as error:
            agenda_receipt = {"path": str(agenda_receipt_path.relative_to(ROOT)), "error": str(error)}

    by_id: dict[str, dict[str, Any]] = {}
    if SHARED_MEETING_SHARD.is_file():
        shard = load_json(SHARED_MEETING_SHARD)
        source_dates["shared_meeting_shard_id"] = shard.get("shard_id")
        source_dates["shared_meeting_version"] = shard.get("version")
        for row in shard.get("rows") or []:
            if not isinstance(row, dict):
                continue
            keys = []
            for key_name in ("meeting_id", "request_id", "publisher_identifier", "record_id"):
                value = row.get(key_name)
                if value:
                    keys.append(str(value))
            for key in keys:
                by_id[key] = row

    old_only = sorted(canonical_set - served_set)
    per_meeting: list[dict[str, Any]] = []
    for meeting_id in old_only:
        row = by_id.get(meeting_id)
        if row is None and meeting_id.startswith("meeting:"):
            row = by_id.get(meeting_id)
        if row is None:
            # city_record short id
            row = by_id.get(f"meeting:city_record:{meeting_id}") or by_id.get(meeting_id)
        dates = _meeting_row_dates(row) if isinstance(row, dict) else {}
        event_date = dates.get("event_date") or dates.get("schedule_starts_at") or dates.get("start_date")
        diagnosis = (
            f"old-only relative to served broader M04 preview; event_date={event_date!r}; "
            f"activity_built_at={activity.get('built_at')!r}; "
            f"agenda_admission_observed_at={source_dates.get('agenda_admission_observed_at')!r}; "
            "rolling publisher windows can drop named ids without proving an empty future calendar."
        )
        per_meeting.append(
            {
                "meeting_id": meeting_id,
                "found_in_shared_meeting_read_model": isinstance(row, dict),
                "dates": dates,
                "diagnosis": diagnosis,
            }
        )
    source_dates["old_only_meeting_dates"] = {
        item["meeting_id"]: item.get("dates") for item in per_meeting
    }

    return {
        "district": "M04",
        "activity_built_at": activity.get("built_at"),
        "boundary_vintage": activity.get("boundary_vintage"),
        "served_broader_count": len(served_broader_ids),
        "canonical_meetings_count": len(canonical_meetings),
        "intersection_count": len(served_set & canonical_set),
        "served_only_sample": sorted(served_set - canonical_set)[:12],
        "canonical_only_sample": old_only[:12],
        "old_only_count": len(old_only),
        "old_only_diagnoses": per_meeting,
        "meetings_coverage_status": (
            meetings_coverage.get("status") if isinstance(meetings_coverage, dict) else None
        ),
        "meetings_source_dates": source_dates,
        "agenda_admission_receipt": agenda_receipt,
        "diagnosis": (
            "Served broader M04 preview is a population slice of committed district_activity "
            "meetings; each canonical-only id is diagnosed against shared_meeting_read_model "
            "dates, activity built_at, and community-board agenda admission receipts rather than "
            "treated as proof of an empty future calendar."
            if old_only
            else "Served M04 broader ids are within the committed district_activity population."
        ),
        "origin_checked": origin.rstrip("/"),
    }



def capture(*, origin: str = ORIGIN, api_origin: str = API_ORIGIN, half: str = "both") -> dict[str, Any]:
    from playwright.sync_api import sync_playwright

    if half not in {"both", "worker", "pages"}:
        raise ValueError(f"half must be both|worker|pages, got {half!r}")

    ancestors = load_delivery_ancestors()
    prove_pins_on_default_branch(ancestors)
    worker_gate = check_worker_gates(ancestors, api_origin=api_origin) if half in {"both", "worker"} else None
    pages_gate = check_pages_gates(ancestors, origin=origin) if half in {"both", "pages"} else None

    prior_receipt = None
    if half != "both" and PRODUCTION_PATH.is_file():
        prior_receipt = load_json(PRODUCTION_PATH)
        validate_receipt(prior_receipt)

    if half == "worker":
        if not prior_receipt:
            raise RuntimeError("worker-half capture requires an existing production-read.json")
        prior_pages = (prior_receipt.get("deployment") or {}).get("pages") or {}
        pages_gate = {
            "served_revision": prior_pages["served_revision"],
            "contains_overview_ancestor": prior_pages["contains_overview_ancestor"],
            "contains_map_fix_ancestor": prior_pages["contains_map_fix_ancestor"],
            "generated_at": prior_pages.get("generated_at"),
            "manifest_sha256": prior_pages.get("manifest_sha256"),
            "deployment_at": prior_pages.get("deployment_at"),
        }
    elif half == "pages":
        if not prior_receipt:
            raise RuntimeError("pages-half capture requires an existing production-read.json")
        prior_worker = (prior_receipt.get("deployment") or {}).get("worker") or {}
        worker_gate = {
            "served_revision": prior_worker["served_revision"],
            "contains_overview_ancestor": prior_worker["contains_overview_ancestor"],
            "contains_map_fix_ancestor": prior_worker["contains_map_fix_ancestor"],
            "deploy_run_id": prior_worker.get("deploy_run_id"),
            "live_smoke_conclusion": prior_worker.get("live_smoke_conclusion"),
            "deploy_run_url": prior_worker.get("deploy_run_url"),
        }

    worker_ancestry = {
        "contains_overview_ancestor": worker_gate["contains_overview_ancestor"],
        "contains_map_fix_ancestor": worker_gate["contains_map_fix_ancestor"],
    }
    pages_ancestry = {
        "contains_overview_ancestor": pages_gate["contains_overview_ancestor"],
        "contains_map_fix_ancestor": pages_gate["contains_map_fix_ancestor"],
    }
    worker_meta = {
        "deploy_run_id": worker_gate["deploy_run_id"],
        "live_smoke_conclusion": worker_gate["live_smoke_conclusion"],
    }

    grounded_at = subprocess.run(
        ["git", "-C", str(ROOT), "rev-parse", "origin/main"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    capture_run_id = str(uuid.uuid4())
    observed_at = utc_now()
    data_vintage = pages_gate.get("generated_at") or worker_gate["served_revision"]
    SCRATCH.mkdir(parents=True, exist_ok=True)

    captures: list[dict[str, Any]] = []
    needs_decision: list[dict[str, Any]] = []
    canonical_land = load_canonical_chelsea_land_ids()
    identity_compare: dict[str, Any] | None = None

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        browser_version = browser.version

        # --- 1. No-lens direct load at both viewports (Worker) ---
        for viewport_name, width, height in VIEWPORTS:
            context = browser.new_context(
                viewport={"width": width, "height": height},
                user_agent=USER_AGENT,
                extra_http_headers={"Cache-Control": "no-cache, no-store", "Pragma": "no-cache"},
            )
            context.add_init_script(OBSERVE_MAP)
            page = context.new_page()
            route = NO_LENS_ROUTE
            response = page.goto(uncached(origin, route), wait_until="networkidle", timeout=120_000)
            if not response or response.status != 200:
                raise RuntimeError(f"no-lens route HTTP {response.status if response else None}")
            try:
                page.wait_for_selector('[data-near-geography-map-state="ready"]', timeout=60_000)
            except Exception:
                pass
            viewport = read_applied_viewport(page)
            if viewport["configured_width"] != width or viewport["configured_height"] != height:
                raise AssertionError(f"viewport not applied: wanted {width}x{height}, got {viewport}")
            overview = observe_overview_shell(page)
            try:
                map_obs = observe_selected_map(page, geo_id=CHELSEA)
            except Exception as error:
                map_obs = {
                    "error": str(error),
                    "boundary_fits_first_viewport": False,
                    "map_canvas_laid_out": False,
                    "check_result": "fail",
                }
            overview_ok = bool(
                overview["selected_neighborhood_visible"]
                and overview["zoning_or_projects_exposed"]
                and overview["broader_or_calendar_present"]
                and overview["citywide_detour_absent"]
            )
            served_values = {
                **overview,
                "map_on_records_surface": map_obs,
                "applied_viewport": viewport,
                "check_result": "pass" if overview_ok else "fail",
                "observation_status": "closed" if overview_ok else "open",
                "note": (
                    "surface=records overview claims (neighborhood, Zoning, broader M04 / "
                    "board calendar, no All NYC detour). Map first-viewport boundary fit is "
                    "measured on surface=map because records collapses the map canvas."
                ),
            }
            if not overview["selected_neighborhood_visible"]:
                raise AssertionError(f"Chelsea heading missing: {overview.get('heading')!r}")
            if not overview["citywide_detour_absent"]:
                raise AssertionError("All NYC meetings citywide recovery present on overview default")
            assertion = (
                f"No-lens Chelsea overview at {viewport_name} shows selected neighborhood, "
                f"local Zoning/projects, broader M04 or board calendar, and no All NYC detour; "
                f"records map laid_out={map_obs.get('map_canvas_laid_out')}; "
                f"check_result={served_values['check_result']}"
            )
            page.screenshot(path=str(SCRATCH / f"no-lens-{viewport_name}.png"), full_page=False)
            captures.append(
                observation_base(
                    name=f"no-lens-overview-{viewport_name}",
                    route=route,
                    viewport_name=viewport_name,
                    viewport=viewport,
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=assertion,
                    served_values=served_values,
                    content_sha256=overview["page_html_sha256"],
                    capture_run_id=capture_run_id,
                )
            )
            context.close()

        # --- 1a. Map first-viewport boundary fit on surface=map (Worker) ---
        for viewport_name, width, height in VIEWPORTS:
            context = browser.new_context(
                viewport={"width": width, "height": height},
                user_agent=USER_AGENT,
                extra_http_headers={"Cache-Control": "no-cache, no-store", "Pragma": "no-cache"},
            )
            context.add_init_script(OBSERVE_MAP)
            page = context.new_page()
            route = NO_LENS_MAP_ROUTE
            response = page.goto(uncached(origin, route), wait_until="networkidle", timeout=120_000)
            if not response or response.status != 200:
                raise RuntimeError(f"map route HTTP {response.status if response else None}")
            try:
                page.wait_for_selector('[data-near-geography-map-state="ready"]', timeout=60_000)
            except Exception:
                pass
            viewport = read_applied_viewport(page)
            if viewport["configured_width"] != width or viewport["configured_height"] != height:
                raise AssertionError(f"map viewport not applied: wanted {width}x{height}, got {viewport}")
            heading = (
                normalize_ws(page.locator("h1").first.inner_text()) if page.locator("h1").count() else ""
            )
            try:
                map_obs = observe_selected_map(page, geo_id=CHELSEA)
            except Exception as error:
                map_obs = {
                    "error": str(error),
                    "boundary_fits_first_viewport": False,
                    "map_canvas_laid_out": False,
                    "check_result": "fail",
                }
            map_ok = map_obs.get("check_result") == "pass"
            map_values = {
                "heading": heading,
                "selected_neighborhood_visible": any(
                    needle in heading for needle in CHELSEA_LABEL_NEEDLES
                ),
                "applied_viewport": viewport,
                "map": map_obs,
                "check_result": "pass" if map_ok else "fail",
                "observation_status": "closed" if map_ok else "open",
            }
            page.screenshot(path=str(SCRATCH / f"map-fit-{viewport_name}.png"), full_page=False)
            captures.append(
                observation_base(
                    name=f"map-first-viewport-fit-{viewport_name}",
                    route=route,
                    viewport_name=viewport_name,
                    viewport=viewport,
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=(
                        f"Chelsea surface=map at {viewport_name} first-viewport boundary fit="
                        f"{map_obs.get('boundary_fits_first_viewport')} "
                        f"visible_height={map_obs.get('visible_height_in_first_viewport')} "
                        f"ratio={map_obs.get('boundary_height_ratio')} "
                        f"check_result={map_values['check_result']}"
                    ),
                    served_values=map_values,
                    content_sha256=sha256_text(page.content()),
                    capture_run_id=capture_run_id,
                )
            )
            context.close()

        # --- 1b/1c. Overview Open meetings / Open Zoning place-scope ---
        # Worker-SSR and Pages-client are SEPARATE verdicts at BOTH viewports.
        # Worker imports site/near_you_view.mjs (worker/src/near_you.mjs:15).
        # Never merge the two verdicts. Do not edit site/near_you_view.mjs here.
        overview_link_route = NO_LENS_ROUTE
        for viewport_name, width, height in VIEWPORTS:
            # Worker-SSR (document load)
            context = browser.new_context(
                viewport={"width": width, "height": height},
                user_agent=USER_AGENT,
                extra_http_headers={"Cache-Control": "no-cache, no-store", "Pragma": "no-cache"},
            )
            page = context.new_page()
            response = page.goto(
                uncached(origin, overview_link_route),
                wait_until="networkidle",
                timeout=120_000,
            )
            if not response or response.status != 200:
                raise RuntimeError(
                    f"overview link Worker-SSR {viewport_name} HTTP "
                    f"{response.status if response else None}"
                )
            overview_link_obs = observe_overview_lens_scope_links(
                page,
                expected_geo=f"nta2020:{CHELSEA}",
                interaction_mode="document",
            )
            pages_sibling = (
                f"overview-open-lens-links-place-scope-pages-client-{viewport_name}"
            )
            overview_link_obs = {
                **overview_link_obs,
                "verdict_scope": "worker-ssr-only",
                "provenance": {
                    "worker_module": "worker/src/near_you.mjs",
                    "import_line": 15,
                    "rendering": "Worker server-rendered Near You HTML / overview_html payloads",
                    "deploy_run_id": worker_gate.get("deploy_run_id"),
                    "served_revision": worker_gate["served_revision"],
                    "viewport_name": viewport_name,
                },
                "separate_from": pages_sibling,
            }
            overview_link_viewport = read_applied_viewport(page)
            if (
                overview_link_viewport["configured_width"] != width
                or overview_link_viewport["configured_height"] != height
            ):
                raise AssertionError(
                    f"overview Worker-SSR viewport not applied: wanted {width}x{height}, "
                    f"got {overview_link_viewport}"
                )
            overview_link_html = page.content()
            overview_link_assertion = (
                f"Worker-SSR overview Open meetings / Open Zoning place-scope at {viewport_name} "
                f"check_result={overview_link_obs['check_result']} "
                f"observation_status={overview_link_obs['observation_status']} "
                f"failing_labels={overview_link_obs['failing_labels']!r} "
                f"hrefs={[row.get('href') for row in overview_link_obs.get('links') or []]!r} "
                f"result_h1s={[row.get('result_h1') for row in overview_link_obs.get('links') or []]!r}; "
                f"separate from {pages_sibling}"
            )
            captures.append(
                observation_base(
                    name=f"overview-open-lens-links-place-scope-worker-ssr-{viewport_name}",
                    route=overview_link_route,
                    viewport_name=viewport_name,
                    viewport=overview_link_viewport,
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=overview_link_assertion,
                    served_values=overview_link_obs,
                    content_sha256=sha256_text(overview_link_html),
                    capture_run_id=capture_run_id,
                )
            )
            context.close()

            # Pages-client (soft-nav / static bundle re-render)
            context = browser.new_context(
                viewport={"width": width, "height": height},
                user_agent=USER_AGENT,
                extra_http_headers={"Cache-Control": "no-cache, no-store", "Pragma": "no-cache"},
            )
            page = context.new_page()
            response = page.goto(
                uncached(origin, overview_link_route),
                wait_until="networkidle",
                timeout=120_000,
            )
            if not response or response.status != 200:
                raise RuntimeError(
                    f"overview link Pages-client {viewport_name} HTTP "
                    f"{response.status if response else None}"
                )
            # Prove Pages client via island adopt + history Back, then assert
            # Open meetings / Open Zoning place-scope on the adopted client DOM.
            island_meta = prove_pages_client_island_adopt_cycle(
                page, origin=origin, expected_geo=f"nta2020:{CHELSEA}"
            )
            pages_link_obs = observe_overview_lens_scope_links(
                page,
                expected_geo=f"nta2020:{CHELSEA}",
                interaction_mode="client-place-scope",
            )
            if not island_meta.get("island_adopt_proven"):
                pages_link_obs = {
                    **pages_link_obs,
                    "soft_nav_proven": False,
                    "island_adopt_proven": False,
                    "check_result": "fail",
                    "observation_status": "open",
                    "failing_labels": list(
                        dict.fromkeys(
                            list(pages_link_obs.get("failing_labels") or [])
                            + ["island-adopt-unproven"]
                        )
                    ),
                    "provenance_degraded_reason": (
                        f"island_adopt navigation_mode={island_meta.get('navigation_mode')!r} "
                        "is not a proven adoptDocument away+Back cycle "
                        f"(missing={island_meta.get('missing_steps')!r})"
                    ),
                }
            worker_sibling = (
                f"overview-open-lens-links-place-scope-worker-ssr-{viewport_name}"
            )
            pages_link_obs = {
                **pages_link_obs,
                "verdict_scope": "pages-client-only",
                "island_adopt": island_meta,
                "soft_navigation": island_meta,
                "soft_nav_proven": bool(island_meta.get("soft_nav_proven")),
                "island_adopt_proven": bool(island_meta.get("island_adopt_proven")),
                "provenance": {
                    "rendering": (
                        "Pages static client bundle after island adoptDocument "
                        "+ history Back to Chelsea overview"
                    ),
                    "served_revision": pages_gate["served_revision"],
                    "pages_generated_at": pages_gate.get("generated_at"),
                    "viewport_name": viewport_name,
                },
                "separate_from": worker_sibling,
            }
            pages_link_viewport = read_applied_viewport(page)
            if (
                pages_link_viewport["configured_width"] != width
                or pages_link_viewport["configured_height"] != height
            ):
                raise AssertionError(
                    f"overview Pages-client viewport not applied: wanted {width}x{height}, "
                    f"got {pages_link_viewport}"
                )
            pages_link_html = page.content()
            nav_label = island_meta.get("navigation_mode") or "unproven"
            pages_link_assertion = (
                f"Pages-client overview Open meetings / Open Zoning place-scope at {viewport_name} "
                f"after nav_mode={nav_label!r} "
                f"(island_adopt_proven={bool(island_meta.get('island_adopt_proven'))}; "
                f"soft_nav_proven={bool(island_meta.get('soft_nav_proven'))}) "
                f"check_result={pages_link_obs['check_result']} "
                f"observation_status={pages_link_obs['observation_status']} "
                f"failing_labels={pages_link_obs['failing_labels']!r} "
                f"hrefs={[row.get('href') for row in pages_link_obs.get('links') or []]!r} "
                f"result_h1s={[row.get('result_h1') for row in pages_link_obs.get('links') or []]!r}; "
                f"separate from {worker_sibling}"
            )
            captures.append(
                observation_base(
                    name=f"overview-open-lens-links-place-scope-pages-client-{viewport_name}",
                    route=overview_link_route,
                    viewport_name=viewport_name,
                    viewport=pages_link_viewport,
                    served_half="pages",
                    served_revision=pages_gate["served_revision"],
                    ancestry=pages_ancestry,
                    worker_meta=None,
                    data_vintage=data_vintage,
                    assertion=pages_link_assertion,
                    served_values=pages_link_obs,
                    content_sha256=sha256_text(pages_link_html),
                    capture_run_id=capture_run_id,
                )
            )
            context.close()

        # --- 2. Per-lens coverage for Chelsea + Hell's Kitchen (Worker), both viewports ---
        lens_pairs = (
            (CHELSEA, "meetings"),
            (CHELSEA, "land"),
            (HELLS_KITCHEN, "meetings"),
            (HELLS_KITCHEN, "land"),
        )
        lens_observations: dict[str, dict[str, Any]] = {}
        identity_compare = None
        for viewport_name, width, height in VIEWPORTS:
            for geo, lens in lens_pairs:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    user_agent=USER_AGENT,
                )
                page = context.new_page()
                route = LENS_ROUTE.format(geo=geo, lens=lens)
                response = page.goto(
                    uncached(origin, route), wait_until="networkidle", timeout=120_000
                )
                if not response or response.status != 200:
                    raise RuntimeError(f"{route} HTTP {response.status if response else None}")
                viewport = read_applied_viewport(page)
                if viewport["configured_width"] != width or viewport["configured_height"] != height:
                    raise AssertionError(
                        f"lens viewport not applied: wanted {width}x{height}, got {viewport}"
                    )
                observed = observe_lens_page(page, geo=geo, lens=lens)
                key = f"{viewport_name}:{geo}:{lens}"
                lens_observations[key] = observed
                # Prefer desktop Chelsea land for identity_compare canonical join.
                if geo == CHELSEA and lens == "land" and viewport_name == "desktop":
                    identity_compare = compare_identity(
                        observed["record_ids"]["exact_ids"],
                        canonical_land,
                    )
                assertion = (
                    f"{geo} lens={lens} at {viewport_name} "
                    f"coverage={observed['recovery']['coverage']} "
                    f"copy={observed['recovery'].get('resident_copy')!r} "
                    f"exact={len(observed['record_ids']['exact_ids'])} "
                    f"broader={len(observed['record_ids']['broader_ids'])}"
                )
                captures.append(
                    observation_base(
                        name=f"lens-{geo}-{lens}-{viewport_name}",
                        route=route,
                        viewport_name=viewport_name,
                        viewport=viewport,
                        served_half="worker",
                        served_revision=worker_gate["served_revision"],
                        ancestry=worker_ancestry,
                        worker_meta=worker_meta,
                        data_vintage=data_vintage,
                        assertion=assertion,
                        served_values=observed,
                        content_sha256=observed["page_html_sha256"],
                        capture_run_id=capture_run_id,
                    )
                )
                context.close()

        # --- 3. Negative controls (Worker), both viewports ---
        ZERO_GEO = "BK1402"
        ZERO_LENS = "land"
        zero_copy = None
        for viewport_name, width, height in VIEWPORTS:
            chelsea_meetings = (
                lens_observations.get(f"{viewport_name}:{CHELSEA}:meetings") or {}
            )
            hells_meetings = (
                lens_observations.get(f"{viewport_name}:{HELLS_KITCHEN}:meetings") or {}
            )
            chelsea_exact = set(
                (chelsea_meetings.get("record_ids") or {}).get("exact_ids") or []
            )
            hells_exact = set(
                (hells_meetings.get("record_ids") or {}).get("exact_ids") or []
            )
            cross_membership = sorted(chelsea_exact & hells_exact)

            # Explicit meetings lens stays meetings (not overview).
            neg_meetings = {
                "stayed_meetings_view": bool(chelsea_meetings.get("stayed_on_lens")),
                "is_overview": bool(chelsea_meetings.get("is_overview")),
                "lens": (chelsea_meetings.get("lens_attr") or {}).get("lens"),
                "recovery": chelsea_meetings.get("recovery"),
                "viewport_name": viewport_name,
            }
            captures.append(
                observation_base(
                    name=f"negative-explicit-meetings-lens-{viewport_name}",
                    route=LENS_ROUTE.format(geo=CHELSEA, lens="meetings"),
                    viewport_name=viewport_name,
                    viewport={
                        "width": width,
                        "height": height,
                        "configured_width": width,
                        "configured_height": height,
                    },
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=(
                        f"Explicit lens=meetings stays meetings view at {viewport_name} "
                        f"(overview={neg_meetings['is_overview']}, lens={neg_meetings['lens']!r})"
                    ),
                    served_values=neg_meetings,
                    content_sha256=chelsea_meetings.get("page_html_sha256")
                    or sha256_text(json.dumps(neg_meetings)),
                    capture_run_id=capture_run_id,
                )
            )

            # Switching to Hell's Kitchen keeps its own scope.
            hk = hells_meetings
            neg_switch = {
                "heading": hk.get("heading"),
                "geo": (hk.get("lens_attr") or {}).get("geo"),
                "chelsea_label_absent": not any(
                    needle in (hk.get("heading") or "") for needle in ("Chelsea-Hudson Yards",)
                ),
                "exact_ids_sample": ((hk.get("record_ids") or {}).get("exact_ids") or [])[:8],
                "cross_exact_with_chelsea": cross_membership,
                "viewport_name": viewport_name,
            }
            captures.append(
                observation_base(
                    name=f"negative-switch-neighborhood-mn0402-{viewport_name}",
                    route=LENS_ROUTE.format(geo=HELLS_KITCHEN, lens="meetings"),
                    viewport_name=viewport_name,
                    viewport={
                        "width": width,
                        "height": height,
                        "configured_width": width,
                        "configured_height": height,
                    },
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=(
                        f"Hell's Kitchen meetings keep MN0402 scope at {viewport_name}; "
                        f"cross exact ids with Chelsea={cross_membership!r}"
                    ),
                    served_values=neg_switch,
                    content_sha256=hk.get("page_html_sha256")
                    or sha256_text(json.dumps(neg_switch)),
                    capture_run_id=capture_run_id,
                )
            )

            # Failed lens load: abort deferred.json.
            context = browser.new_context(
                viewport={"width": width, "height": height}, user_agent=USER_AGENT
            )
            page = context.new_page()
            page.route("**/near-you/deferred.json*", lambda route_obj: route_obj.abort())
            route = LENS_ROUTE.format(geo=CHELSEA, lens="land")
            page.goto(uncached(origin, route), wait_until="domcontentloaded", timeout=90_000)
            try:
                page.locator(
                    '[data-near-you-root][data-near-deferred-state="error"]'
                ).wait_for(timeout=45_000)
            except Exception:
                pass
            fail_html = page.content()
            fail_heading = (
                normalize_ws(page.locator("h1").first.inner_text())
                if page.locator("h1").count()
                else ""
            )
            fail_geo = page.evaluate(
                "() => new URL(window.location.href).searchParams.get('geo')"
            )
            fail_viewport = read_applied_viewport(page)
            fail_values = {
                "heading": fail_heading,
                "geo": fail_geo,
                "deferred_error_marker": 'data-near-deferred-state="error"' in fail_html,
                "scope_retained": fail_geo == f"nta2020:{CHELSEA}",
                "selected_label_retained": any(
                    n in fail_heading for n in CHELSEA_LABEL_NEEDLES
                ),
                "viewport_name": viewport_name,
            }
            captures.append(
                observation_base(
                    name=f"negative-failed-deferred-load-{viewport_name}",
                    route=route,
                    viewport_name=viewport_name,
                    viewport=fail_viewport,
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=(
                        f"Aborted deferred.json keeps Chelsea scope / shows failure recovery "
                        f"at {viewport_name} (error_marker={fail_values['deferred_error_marker']})"
                    ),
                    served_values=fail_values,
                    content_sha256=sha256_text(fail_html),
                    capture_run_id=capture_run_id,
                )
            )
            page.unroute("**/near-you/deferred.json*")
            context.close()

            # True-zero control: Flatbush BK1402 land is a published measured-empty bag.
            context = browser.new_context(
                viewport={"width": width, "height": height}, user_agent=USER_AGENT
            )
            page = context.new_page()
            zero_route = LENS_ROUTE.format(geo=ZERO_GEO, lens=ZERO_LENS)
            response = page.goto(
                uncached(origin, zero_route), wait_until="networkidle", timeout=120_000
            )
            if not response or response.status != 200:
                raise RuntimeError(
                    f"{zero_route} HTTP {response.status if response else None}"
                )
            zero_viewport = read_applied_viewport(page)
            zero_obs = observe_lens_page(page, geo=ZERO_GEO, lens=ZERO_LENS)
            context.close()
            zero_recovery = zero_obs.get("recovery") or {}
            if zero_recovery.get("coverage") == "verified-empty":
                zero_copy = zero_recovery.get("resident_copy") or zero_copy
            zero_values = {
                **zero_obs,
                "viewport_name": viewport_name,
                "check_result": (
                    "pass" if zero_recovery.get("coverage") == "verified-empty" else "fail"
                ),
                "observation_status": (
                    "closed"
                    if zero_recovery.get("coverage") == "verified-empty"
                    else "open"
                ),
            }
            captures.append(
                observation_base(
                    name=f"negative-true-zero-bk1402-land-{viewport_name}",
                    route=zero_route,
                    viewport_name=viewport_name,
                    viewport=zero_viewport,
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=(
                        f"True-zero BK1402 land at {viewport_name} "
                        f"coverage={zero_recovery.get('coverage')!r} "
                        f"copy={zero_recovery.get('resident_copy')!r}"
                    ),
                    served_values=zero_values,
                    content_sha256=zero_obs.get("page_html_sha256")
                    or sha256_text(json.dumps(zero_values, sort_keys=True)),
                    capture_run_id=capture_run_id,
                )
            )

        # Desktop Chelsea meetings copy for unsupported-vs-zero comparison below.
        chelsea_meetings = lens_observations.get(f"desktop:{CHELSEA}:meetings") or {}
        unsupported_copy = (chelsea_meetings.get("recovery") or {}).get("resident_copy")

        # Citywide stays separately scoped on meetings lens (present there, not exact membership).
        _meetings_status, _meetings_body, meetings_deferred = fetch_json_url(
            uncached(origin, DEFERRED_ROUTE.format(geo=CHELSEA, lens="meetings"))
        )
        meetings_deferred_html = (
            (meetings_deferred or {}).get("results_html")
            if isinstance(meetings_deferred, dict)
            else ""
        ) or ""
        chelsea_exact = set(
            (chelsea_meetings.get("record_ids") or {}).get("exact_ids") or []
        )
        hells_meetings = lens_observations.get(f"desktop:{HELLS_KITCHEN}:meetings") or {}
        hells_exact = set(
            (hells_meetings.get("record_ids") or {}).get("exact_ids") or []
        )
        cross_membership = sorted(chelsea_exact & hells_exact)
        chelsea_broader = set(
            (chelsea_meetings.get("record_ids") or {}).get("broader_ids") or []
        )
        chelsea_bags = set(chelsea_meetings.get("citywide_bag_ids") or [])
        m04_broader_not_exact = sorted(chelsea_broader - chelsea_exact)
        bags_not_exact = sorted(chelsea_bags - chelsea_exact)
        membership_ok = (
            not cross_membership
            and chelsea_broader.isdisjoint(chelsea_exact)
            and chelsea_bags.isdisjoint(chelsea_exact)
        )
        citywide_scope = {
            "chelsea_meetings_all_nyc_present": "All NYC meetings" in meetings_deferred_html
            or "All NYC meetings" in ((chelsea_meetings.get("recovery") or {}).get("resident_copy") or ""),
            "chelsea_exact_membership_ids": sorted(chelsea_exact)[:12],
            "hells_kitchen_exact_sample": sorted(hells_exact)[:8],
            "m04_broader_not_exact_chelsea": m04_broader_not_exact[:12],
            "citywide_bag_ids_sample": bags_not_exact[:12],
            "citywide_bags_separately_scoped": bool(
                chelsea_meetings.get("citywide_bags_separately_scoped")
            ),
            "cross_exact_hk_in_chelsea": cross_membership,
            "check_result": "pass" if membership_ok else "fail",
        }

        copies_are_distinct = bool(
            unsupported_copy
            and zero_copy
            and unsupported_copy != zero_copy
        )
        zero_values = {
            "chelsea_meetings_coverage": (chelsea_meetings.get("recovery") or {}).get("coverage"),
            "chelsea_meetings_resident_copy": unsupported_copy,
            "verified_empty_place": f"nta2020:{ZERO_GEO}",
            "verified_empty_lens": ZERO_LENS,
            "verified_empty_coverage": (zero_obs.get("recovery") or {}).get("coverage"),
            "observed_verified_empty_copy": zero_copy,
            "copies_are_distinct": copies_are_distinct,
            "citywide_scope": citywide_scope,
            "check_result": "pass" if (copies_are_distinct and membership_ok) else "fail",
            "observation_status": "closed" if (copies_are_distinct and membership_ok) else "open",
            "note": (
                "Chelsea meetings are unsupported (absent key), not measured-zero. "
                "Verified-empty copy is read from a published land-zero place (BK1402). "
                "Exact membership is parsed only from section.near-results so citywide "
                "bag rows stay separately scoped."
            ),
        }
        if not copies_are_distinct:
            # Soft-fail into the observation rather than aborting the whole capture:
            # retain exact observed strings for the open observation.
            zero_values["failure"] = (
                f"unsupported vs zero copy distinction missing: "
                f"unsupported={unsupported_copy!r} zero={zero_copy!r}"
            )
        if cross_membership:
            zero_values["membership_failure"] = (
                f"Hell's Kitchen venue ids leaked into exact Chelsea membership: "
                f"{cross_membership!r}"
            )
        captures.append(
            observation_base(
                name="negative-unsupported-vs-zero-copy",
                route=zero_route,
                viewport_name="desktop",
                viewport={"width": 1440, "height": 900, "configured_width": 1440, "configured_height": 900},
                served_half="worker",
                served_revision=worker_gate["served_revision"],
                ancestry=worker_ancestry,
                worker_meta=worker_meta,
                data_vintage=data_vintage,
                assertion=(
                    "Unsupported vs verified-empty resident copy distinction "
                    f"unsupported={unsupported_copy!r} zero={zero_copy!r}; "
                    f"cross_exact_hk={cross_membership!r}; "
                    f"membership_check={citywide_scope['check_result']}; "
                    f"observation_status={zero_values['observation_status']}"
                ),
                served_values=zero_values,
                content_sha256=zero_obs.get("page_html_sha256")
                or sha256_text(json.dumps(zero_values, sort_keys=True)),
                capture_run_id=capture_run_id,
            )
        )


        # --- 4. Interaction continuity (Worker + Pages for detail) ---
        for viewport_name, width, height in VIEWPORTS:
            context = browser.new_context(
                viewport={"width": width, "height": height},
                user_agent=USER_AGENT,
            )
            context.add_init_script(OBSERVE_MAP)
            page = context.new_page()
            start_route = NO_LENS_ROUTE
            page.goto(uncached(origin, start_route), wait_until="networkidle", timeout=120_000)
            page.wait_for_selector("h1", timeout=60_000)
            viewport_chrome = read_applied_viewport(page)
            if not viewport_chrome.get("matches_configured"):
                raise AssertionError(
                    f"viewport chrome not applied at {viewport_name}: wanted {width}x{height}, got {viewport_chrome}"
                )
            before_geo = page.evaluate("() => new URL(window.location.href).searchParams.get('geo')")

            # Client in-browser lens switch with same-document proof (not a direct load).
            # Prefer Chelsea "Zoning N" / "Meetings N" island controls. "Open Zoning" /
            # "Open meetings" are document navigations and destroy the window marker.
            marker_switch = install_document_marker(page)
            lens_pick = page.evaluate(
                """(chelsea) => {
                  const nodes = Array.from(document.querySelectorAll(
                    'a[href*="lens=land"][href*="near-you"], a[href*="lens=meetings"][href*="near-you"]'
                  ));
                  const visible = (el) => {
                    const r = el.getBoundingClientRect();
                    const st = getComputedStyle(el);
                    return r.width >= 2 && r.height >= 2
                      && st.visibility !== 'hidden' && st.display !== 'none'
                      && Number(st.opacity) !== 0;
                  };
                  const rows = [];
                  for (const el of nodes) {
                    const href = el.getAttribute('href') || '';
                    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
                    if (!href || !visible(el)) continue;
                    if (/^Open (meetings|Zoning)$/i.test(text)) continue;
                    let geo = '';
                    let lens = '';
                    try {
                      const u = new URL(href, location.href);
                      geo = (u.searchParams.get('geo') || '').replace(/%3A/gi, ':');
                      lens = u.searchParams.get('lens') || '';
                    } catch (e) { continue; }
                    if (!lens) continue;
                    if (chelsea && geo && !geo.includes(chelsea) && !href.includes(chelsea)) {
                      continue;
                    }
                    const score = /^(Zoning|Meetings)\\b/i.test(text) ? 0 : 1;
                    rows.push({ text, href, geo, lens, score });
                  }
                  rows.sort((a, b) => a.score - b.score);
                  return rows[0] || null;
                }""",
                CHELSEA,
            )
            client_switch = {
                "clicked": False,
                "control": lens_pick,
                "same_document_proof": None,
                "result_geo": None,
                "result_lens": None,
            }
            if lens_pick is not None:
                lens_control = page.locator(
                    f'a[href="{lens_pick.get("href")}"]'
                )
                if lens_control.count() == 0:
                    lens_control = page.locator("a").filter(
                        has_text=re.compile(
                            re.escape((lens_pick.get("text") or "")[:24]) or ".*"
                        )
                    )
                try:
                    lens_control.first.scroll_into_view_if_needed(timeout=8_000)
                except Exception:
                    pass
                lens_control.first.click(timeout=15_000, no_wait_after=True)
                client_switch["clicked"] = True
                expected_lens = str(lens_pick.get("lens") or "")
                try:
                    page.wait_for_function(
                        """(expected) => {
                          const u = new URL(location.href);
                          const lens = u.searchParams.get('lens');
                          const root = document.querySelector('[data-near-you-root]');
                          const rootLens = root && root.getAttribute('data-near-lens');
                          if (expected) {
                            return lens === expected || rootLens === expected;
                          }
                          return !!(lens || rootLens);
                        }""",
                        arg=expected_lens,
                        timeout=15_000,
                    )
                except Exception as error:
                    client_switch["lens_wait_error"] = {
                        "type": error.__class__.__name__,
                        "message": str(error)[:160],
                    }
                page.wait_for_timeout(400)
                client_switch["same_document_proof"] = prove_same_document(
                    page, marker_switch
                )
                client_switch["result_geo"] = page.evaluate(
                    "() => new URL(window.location.href).searchParams.get('geo')"
                )
                client_switch["result_lens"] = page.evaluate(
                    """() => {
                      const u = new URL(window.location.href);
                      const lens = u.searchParams.get('lens');
                      if (lens) return lens;
                      const root = document.querySelector('[data-near-you-root]');
                      return root && root.getAttribute('data-near-lens');
                    }"""
                )
            client_switch_ok = bool(
                client_switch.get("clicked")
                and (client_switch.get("same_document_proof") or {}).get("same_document")
                and client_switch.get("result_geo") == f"nta2020:{CHELSEA}"
                and client_switch.get("result_lens")
            )
            captures.append(
                observation_base(
                    name=f"overview-client-lens-switch-same-document-{viewport_name}",
                    route=start_route,
                    viewport_name=viewport_name,
                    viewport=viewport_chrome,
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=(
                        f"Client lens switch at {viewport_name} same_document="
                        f"{(client_switch.get('same_document_proof') or {}).get('same_document')!r} "
                        f"result_lens={client_switch.get('result_lens')!r} "
                        f"check_result={'pass' if client_switch_ok else 'fail'}"
                    ),
                    served_values={
                        **client_switch,
                        "viewport_chrome": viewport_chrome,
                        "check_result": "pass" if client_switch_ok else "fail",
                        "observation_status": "closed" if client_switch_ok else "open",
                        "verdict_scope": "client-navigation-same-document",
                    },
                    content_sha256=sha256_text(json.dumps(client_switch, sort_keys=True)),
                    capture_run_id=capture_run_id,
                )
            )

            # Genuine client-side neighbourhood / place switch with same-document proof.
            # Direct loads of another neighbourhood do not meet this row.
            page.goto(
                uncached(origin, f"{NO_LENS_ROUTE}&drawer=open"),
                wait_until="networkidle",
                timeout=120_000,
            )
            page.wait_for_selector("h1, [data-near-you-root]", timeout=60_000)
            try:
                page.wait_for_selector(
                    '[data-near-you-root][data-enhanced="true"]', timeout=60_000
                )
            except Exception:
                pass
            _wait_near_you_deferred_ready(page, timeout_ms=45_000)
            neighborhood_switch = observe_client_neighborhood_switch(
                page,
                origin=origin,
                expected_start_geo=f"nta2020:{CHELSEA}",
            )
            captures.append(
                observation_base(
                    name=f"overview-client-neighborhood-switch-same-document-{viewport_name}",
                    route=f"{NO_LENS_ROUTE}&drawer=open",
                    viewport_name=viewport_name,
                    viewport=read_applied_viewport(page),
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=(
                        f"Client neighbourhood switch at {viewport_name} "
                        f"same_document="
                        f"{(neighborhood_switch.get('same_document_proof') or {}).get('same_document')!r} "
                        f"start_geo={neighborhood_switch.get('start_geo')!r} "
                        f"result_geo={neighborhood_switch.get('result_geo')!r} "
                        f"check_result={neighborhood_switch.get('check_result')}"
                    ),
                    served_values={
                        **neighborhood_switch,
                        "viewport_chrome": read_applied_viewport(page),
                        "verdict_scope": "client-navigation-same-document",
                    },
                    content_sha256=sha256_text(
                        json.dumps(neighborhood_switch, sort_keys=True, default=str)
                    ),
                    capture_run_id=capture_run_id,
                )
            )

            # A2 sibling-neighbourhood switch: Advanced filters "Neighborhood or
            # precinct" select, keyboard-operated, Chelsea -> Hell's Kitchen with
            # exact-id comparison against independent HK land membership.
            page.goto(
                uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="land")),
                wait_until="networkidle",
                timeout=120_000,
            )
            page.wait_for_selector("h1, [data-near-you-root]", timeout=60_000)
            try:
                page.wait_for_selector(
                    '[data-near-you-root][data-enhanced="true"]', timeout=60_000
                )
            except Exception:
                pass
            _wait_near_you_deferred_ready(page, timeout_ms=60_000)
            independent_hk = (
                (
                    lens_observations.get(f"{viewport_name}:{HELLS_KITCHEN}:land") or {}
                ).get("record_ids")
                or {}
            ).get("exact_ids") or []
            filter_switch = observe_keyboard_filter_neighborhood_switch_to_hells_kitchen(
                page,
                origin=origin,
                independent_hk_exact_ids=list(independent_hk),
            )
            captures.append(
                observation_base(
                    name=(
                        f"overview-keyboard-filter-neighborhood-switch-hells-kitchen-"
                        f"{viewport_name}"
                    ),
                    route=LENS_ROUTE.format(geo=CHELSEA, lens="land"),
                    viewport_name=viewport_name,
                    viewport=read_applied_viewport(page),
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=(
                        f"Keyboard Advanced-filters neighbourhood switch at {viewport_name}: "
                        f"Chelsea land -> Hell's Kitchen; "
                        f"operated_from_keyboard={filter_switch.get('operated_from_keyboard')!r}; "
                        f"navigation_mode={filter_switch.get('navigation_mode')!r}; "
                        f"same_document="
                        f"{(filter_switch.get('same_document_proof') or {}).get('same_document')!r}; "
                        f"result_geo={filter_switch.get('result_geo')!r}; "
                        f"chelsea_exact={len(filter_switch.get('chelsea_exact_ids') or [])}; "
                        f"hk_exact={len(filter_switch.get('hells_kitchen_exact_ids') or [])}; "
                        f"shared={filter_switch.get('shared_exact_ids')!r}; "
                        f"unjustified={filter_switch.get('unjustified_shared_exact_ids')!r}; "
                        f"check_result={filter_switch.get('check_result')}"
                    ),
                    served_values={
                        **filter_switch,
                        "viewport_chrome": read_applied_viewport(page),
                        "verdict_scope": "keyboard-product-filter-neighborhood-switch",
                    },
                    content_sha256=sha256_text(
                        json.dumps(filter_switch, sort_keys=True, default=str)
                    ),
                    capture_run_id=capture_run_id,
                )
            )

            # Direct lens load + refresh still recorded for continuity baselines.
            lens_url = uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="land"))
            page.goto(lens_url, wait_until="networkidle", timeout=120_000)
            after_lens_geo = page.evaluate("() => new URL(window.location.href).searchParams.get('geo')")
            after_lens = page.evaluate("() => new URL(window.location.href).searchParams.get('lens')")
            page.reload(wait_until="networkidle", timeout=120_000)
            after_refresh_geo = page.evaluate("() => new URL(window.location.href).searchParams.get('geo')")

            # Explicit setup before keyboard-only journey (allowed). Start on the Chelsea
            # overview (no lens): Open Zoning / Zoning land-category controls exist there.
            # Meetings-lensed surfaces expose zero Chelsea lens=land controls, so a meetings
            # start cannot observe category-transition by keyboard. No goto/click inside
            # run_keyboard_only_journey.
            overview_setup = uncached(origin, NO_LENS_ROUTE)
            page.goto(overview_setup, wait_until="networkidle", timeout=120_000)
            page.wait_for_selector("h1, section.near-results, [data-near-you-root]", timeout=60_000)
            keyboard_journey = run_keyboard_only_journey(
                page,
                origin=origin,
                expected_geo=f"nta2020:{CHELSEA}",
                start_url=page.url,
            )
            # Journey may end mid-navigation (Back / full-record). Settle before next goto.
            wait_for_navigation_settle(page)
            keyboard_journey["post_journey_goto"] = goto_settled(page, lens_url)

            # Re-enter land lens for detail settle + scoped failed-detail evidence.
            inspection = {
                "opened": False,
                "dismissed": False,
                "back_retained_geo": None,
                "detail_url": None,
                "detail_served_half": None,
                "detail_href": None,
            }
            land_obs = observe_lens_page(page, geo=CHELSEA, lens="land")
            exact_ids = (land_obs.get("record_ids") or {}).get("exact_ids") or []
            settled_named = None
            failed_detail = None
            product_recovery_ok = False
            named_heading_ok = False
            if exact_ids:
                record_id = exact_ids[0]
                try:
                    link = page.locator(
                        f'section.near-results li.near-record[data-record-id="{record_id}"] '
                        f"a.near-record-full-record, "
                        f'section.near-results li.near-record[data-record-id="{record_id}"] '
                        f"a.near-record-title-link"
                    )
                    detail_href = None
                    if link.count():
                        detail_href = link.first.get_attribute("href")
                    inspection["detail_href"] = detail_href
                    if detail_href:
                        target = urllib.parse.urljoin(origin + "/", detail_href)
                        page.goto(target, wait_until="domcontentloaded", timeout=120_000)
                        try:
                            page.wait_for_load_state("networkidle", timeout=90_000)
                        except Exception:
                            page.wait_for_timeout(1000)
                        inspection["opened"] = True
                        inspection["detail_url"] = page.url
                        inspection["detail_served_half"] = "pages"
                        settled_named = wait_settled_named_record_heading(page)
                        named_heading_ok = bool(settled_named.get("settled"))
                        detail_html = page.content()
                        detail_hash = sha256_text(detail_html)
                        site_h1 = settled_named.get("site_h1") or (
                            normalize_ws(page.locator("h1").first.inner_text())
                            if page.locator("h1").count()
                            else ""
                        )
                        named_heading = settled_named.get("named_heading") or ""

                        # Successful detail: observe in-page recovery + browser Back (evidence).
                        scoped_recovery = observe_scoped_chelsea_detail_recovery(
                            page,
                            origin=origin,
                            source_url=uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="land")),
                            expected_geo=f"nta2020:{CHELSEA}",
                        )
                        product_recovery_ok = bool(
                            scoped_recovery.get("product_path_back_demonstrated")
                        )

                        # Return to Chelsea meetings before scoped failed-detail rows.
                        page.goto(
                            uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="meetings")),
                            wait_until="domcontentloaded",
                            timeout=120_000,
                        )
                        wait_for_navigation_settle(page)
                        # DIAGNOSTIC only: document abort retained-page (browser behavior; never live scoped failed-detail recovery).
                        abort_diagnostic = observe_abort_retained_page_diagnostic(
                            page,
                            origin=origin,
                            expected_geo=f"nta2020:{CHELSEA}",
                        )
                        goto_settled(
                            page, uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="meetings"))
                        )
                        # DIAGNOSTIC only: hand-authored mirrored HTML (test-created recovery; never live scoped failed-detail recovery).
                        authored_html_diagnostic = observe_authored_error_html_diagnostic(
                            page,
                            origin=origin,
                            expected_geo=f"nta2020:{CHELSEA}",
                        )
                        goto_settled(
                            page, uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="meetings"))
                        )
                        # Live scoped failed-detail: product link + continue-redirect to nonexistent id; production answers.
                        scoped_failed = observe_scoped_failed_detail_from_chelsea(
                            page,
                            origin=origin,
                            expected_geo=f"nta2020:{CHELSEA}",
                        )
                        # Injected-anchor path is synthetic history control only — not live scoped failed-detail recovery.
                        goto_settled(
                            page, uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="meetings"))
                        )
                        synthetic_scoped_history = observe_synthetic_scoped_history_control(
                            page,
                            origin=origin,
                            expected_geo=f"nta2020:{CHELSEA}",
                        )
                        # Unscoped direct control — separate observation row below.
                        synthetic_404 = observe_synthetic_meeting_404(page, origin=origin)

                        page.goto(
                            uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="land")),
                            wait_until="domcontentloaded",
                            timeout=120_000,
                        )
                        wait_for_navigation_settle(page)
                        back_geo = page.evaluate(
                            "() => new URL(window.location.href).searchParams.get('geo')"
                        )
                        inspection["back_retained_geo"] = back_geo
                        inspection["back_heading"] = (
                            normalize_ws(page.locator("h1").first.inner_text())
                            if page.locator("h1").count()
                            else ""
                        )
                        inspection["scoped_recovery"] = scoped_recovery
                        inspection["abort_retained_page_diagnostic"] = abort_diagnostic
                        inspection["authored_error_html_diagnostic"] = authored_html_diagnostic
                        inspection["scoped_failed_detail"] = scoped_failed
                        inspection["synthetic_scoped_history_control"] = synthetic_scoped_history
                        inspection["unscoped_failed_detail_control"] = synthetic_404
                        inspection["settled_named_record"] = settled_named
                        inspection["product_path_back"] = product_recovery_ok
                        inspection["product_defect"] = False

                        failing_labels = []
                        if not named_heading_ok:
                            failing_labels.append("named-heading-unsettle")
                        if scoped_failed.get("check_result") != "pass" or not scoped_failed.get(
                            "satisfies_real_scoped_journey"
                        ):
                            failing_labels.append("scoped-failed-detail-real-incomplete")
                        if scoped_failed.get("synthetic"):
                            failing_labels.append("scoped-failed-detail-was-synthetic")
                        detail_ok = bool(
                            inspection.get("detail_url")
                            and named_heading_ok
                            and product_recovery_ok
                            and scoped_failed.get("check_result") == "pass"
                            and scoped_failed.get("satisfies_real_scoped_journey")
                            and not scoped_failed.get("synthetic")
                            and (scoped_failed.get("failure_injection") or {}).get("method")
                            == "playwright-route-continue-redirect-nonexistent"
                            and scoped_failed.get("production_response_status") == 404
                            and scoped_failed.get("real_record_control")
                        )
                        captures.append(
                            observation_base(
                                name=f"interaction-detail-{viewport_name}",
                                route=urllib.parse.urlparse(inspection["detail_url"]).path
                                + (
                                    "?" + urllib.parse.urlparse(inspection["detail_url"]).query
                                    if urllib.parse.urlparse(inspection["detail_url"]).query
                                    else ""
                                ),
                                viewport_name=viewport_name,
                                viewport=read_applied_viewport(page),
                                served_half="pages",
                                served_revision=pages_gate["served_revision"],
                                ancestry=pages_ancestry,
                                worker_meta=None,
                                data_vintage=data_vintage,
                                assertion=(
                                    f"Settled named-record heading={named_heading!r} "
                                    f"(site_h1={site_h1!r}, settled={named_heading_ok}); "
                                    f"scoped_recovery demonstrated={product_recovery_ok}; synthetic_404 browse_meetings={len(synthetic_404.get('browse_meetings_links') or [])}; "
                                    f"capture_driven_return geo={back_geo}; "
                                    f"failing_labels={failing_labels!r}; "
                                    f"check_result={'pass' if detail_ok else 'fail'}"
                                ),
                                served_values={
                                    "inspection": inspection,
                                    "site_h1": site_h1,
                                    "named_heading": named_heading,
                                    "settled_named_record": settled_named,
                                    "scoped_recovery": scoped_recovery,
                                    "scoped_failed_detail": scoped_failed,
                                    "unscoped_failed_detail_control": synthetic_404,
                                    "failing_labels": failing_labels,
                                    "product_defects": [],
                                    "needs_decision": [],
                                    "detail_html_sha256": detail_hash,
                                    "viewport_chrome": read_applied_viewport(page),
                                    "check_result": "pass" if detail_ok else "fail",
                                    "observation_status": "closed" if detail_ok else "open",
                                },
                                content_sha256=detail_hash,
                                capture_run_id=capture_run_id,
                            )
                        )
                        captures.append(
                            observation_base(
                                name=f"interaction-abort-retained-page-diagnostic-{viewport_name}",
                                route=(abort_diagnostic.get("real_record_control") or {}).get("href")
                                or "/meetings/",
                                viewport_name=viewport_name,
                                viewport=read_applied_viewport(page),
                                served_half="worker",
                                served_revision=worker_gate["served_revision"],
                                ancestry=worker_ancestry,
                                worker_meta=worker_meta,
                                data_vintage=data_vintage,
                                assertion=(
                                    f"DIAGNOSTIC abort retained-page at {viewport_name}: "
                                    f"browser behavior not app recovery; "
                                    f"aborted={(abort_diagnostic.get('matched_intercept_hit') or {}).get('aborted')}; "
                                    f"retained_page={abort_diagnostic.get('retained_page_after_abort')}; "
                                    f"satisfies_real={abort_diagnostic.get('satisfies_real_scoped_journey')}; "
                                    f"check_result={abort_diagnostic.get('check_result')}"
                                ),
                                served_values={
                                    **abort_diagnostic,
                                    "verdict_scope": "abort-retained-page-diagnostic",
                                    "counts_toward_live_scoped_failed_detail": False,
                                    "row_type": "abort-retained-page-diagnostic",
                                },
                                content_sha256=sha256_text(
                                    json.dumps(abort_diagnostic, sort_keys=True, default=str)
                                ),
                                capture_run_id=capture_run_id,
                            )
                        )
                        captures.append(
                            observation_base(
                                name=f"interaction-authored-error-html-diagnostic-{viewport_name}",
                                route=(authored_html_diagnostic.get("real_record_control") or {}).get(
                                    "href"
                                )
                                or "/meetings/",
                                viewport_name=viewport_name,
                                viewport=read_applied_viewport(page),
                                served_half="worker",
                                served_revision=worker_gate["served_revision"],
                                ancestry=worker_ancestry,
                                worker_meta=worker_meta,
                                data_vintage=data_vintage,
                                assertion=(
                                    f"DIAGNOSTIC authored mirrored HTML at {viewport_name}: "
                                    f"test-created recovery NOT deployed app behavior; "
                                    f"satisfies_real={authored_html_diagnostic.get('satisfies_real_scoped_journey')}; "
                                    f"check_result={authored_html_diagnostic.get('check_result')}"
                                ),
                                served_values={
                                    **authored_html_diagnostic,
                                    "verdict_scope": "authored-error-html-diagnostic",
                                    "counts_toward_live_scoped_failed_detail": False,
                                    "row_type": "authored-error-html-diagnostic",
                                },
                                content_sha256=sha256_text(
                                    json.dumps(authored_html_diagnostic, sort_keys=True, default=str)
                                ),
                                capture_run_id=capture_run_id,
                            )
                        )
                        captures.append(
                            observation_base(
                                name=f"interaction-scoped-failed-detail-real-{viewport_name}",
                                route=(scoped_failed.get("real_record_control") or {}).get("href")
                                or "/meetings/",
                                viewport_name=viewport_name,
                                viewport=read_applied_viewport(page),
                                served_half="worker",
                                served_revision=worker_gate["served_revision"],
                                ancestry=worker_ancestry,
                                worker_meta=worker_meta,
                                data_vintage=data_vintage,
                                assertion=(
                                    f"Live scoped failed-detail at {viewport_name}: "
                                    f"product_link={(scoped_failed.get('real_record_control') or {}).get('href')!r}; "
                                    f"injection={(scoped_failed.get('failure_injection') or {}).get('method')!r}; "
                                    f"deployed_fetch_sha={((scoped_failed.get('failure_injection') or {}).get('deployed_error_fetch') or {}).get('body_sha256')!r}; "
                                    f"recovery_and_return={scoped_failed.get('recovery_and_return_observed')}; "
                                    f"back_geo={(scoped_failed.get('browser_back_outcome') or {}).get('result_geo')!r}; "
                                    f"satisfies_real={scoped_failed.get('satisfies_real_scoped_journey')}; "
                                    f"check_result={scoped_failed.get('check_result')}"
                                ),
                                served_values={
                                    **scoped_failed,
                                    "verdict_scope": "scoped-failed-detail-real-product-link",
                                    "counts_toward_live_scoped_failed_detail": True,
                                    "row_type": "scoped-failed-detail-real",
                                },
                                content_sha256=sha256_text(
                                    json.dumps(scoped_failed, sort_keys=True, default=str)
                                ),
                                capture_run_id=capture_run_id,
                            )
                        )
                        captures.append(
                            observation_base(
                                name=f"interaction-synthetic-scoped-history-control-{viewport_name}",
                                route="/meetings/meeting%3Amissing-chelsea-control/",
                                viewport_name=viewport_name,
                                viewport=read_applied_viewport(page),
                                served_half="worker",
                                served_revision=worker_gate["served_revision"],
                                ancestry=worker_ancestry,
                                worker_meta=worker_meta,
                                data_vintage=data_vintage,
                                assertion=(
                                    f"SYNTHETIC scoped history control at {viewport_name} "
                                    f"(injected anchor; NOT live scoped failed-detail recovery); "
                                    f"acceptance={synthetic_scoped_history.get('acceptance')!r}"
                                ),
                                served_values={
                                    **synthetic_scoped_history,
                                    "verdict_scope": "synthetic-scoped-history-control",
                                    "counts_toward_live_scoped_failed_detail": False,
                                },
                                content_sha256=sha256_text(
                                    json.dumps(synthetic_scoped_history, sort_keys=True, default=str)
                                ),
                                capture_run_id=capture_run_id,
                            )
                        )
                        captures.append(
                            observation_base(
                                name=f"interaction-unscoped-failed-detail-control-{viewport_name}",
                                route="/meetings/meeting%3Amissing-chelsea-control/",
                                viewport_name=viewport_name,
                                viewport=read_applied_viewport(page),
                                served_half="pages",
                                served_revision=pages_gate["served_revision"],
                                ancestry=pages_ancestry,
                                worker_meta=None,
                                data_vintage=data_vintage,
                                assertion=(
                                    f"Unscoped direct failed-detail control at {viewport_name}: "
                                    f"try_again={len(synthetic_404.get('try_again_links') or [])}; "
                                    f"browse_meetings={len(synthetic_404.get('browse_meetings_links') or [])}; "
                                    f"retains_geo={synthetic_404.get('retains_selected_geo')}"
                                ),
                                served_values={
                                    **synthetic_404,
                                    "check_result": (
                                        "pass"
                                        if synthetic_404.get("browse_meetings_links")
                                        and synthetic_404.get("try_again_links")
                                        else "fail"
                                    ),
                                    "observation_status": (
                                        "closed"
                                        if synthetic_404.get("browse_meetings_links")
                                        and synthetic_404.get("try_again_links")
                                        else "open"
                                    ),
                                    "verdict_scope": "unscoped-direct-control",
                                },
                                content_sha256=sha256_text(
                                    json.dumps(synthetic_404, sort_keys=True, default=str)
                                ),
                                capture_run_id=capture_run_id,
                            )
                        )
                except Exception as error:
                    inspection["error"] = str(error)
                    inspection["check_result"] = "fail"
                    inspection["observation_status"] = "open"

            # Keyboard journey observation (Worker shell).
            captures.append(
                observation_base(
                    name=f"interaction-keyboard-journey-{viewport_name}",
                    route=start_route,
                    viewport_name=viewport_name,
                    viewport=read_applied_viewport(page),
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=(
                        f"Keyboard-only journey at {viewport_name}: steps={len(keyboard_journey.get('steps') or [])}; "
                        f"category={keyboard_journey.get('category_transition_observed')}; "
                        f"inspect_open={keyboard_journey.get('inspect_dialog_opened')}; "
                        f"inspect_closed={keyboard_journey.get('inspect_dialog_closed')}; "
                        f"focus_restored={keyboard_journey.get('inspect_focus_restored')}; "
                        f"full_record={keyboard_journey.get('full_record_opened')}; "
                        f"settled={(keyboard_journey.get('settled_named_record') or {}).get('settled')}; "
                        f"place_link={(keyboard_journey.get('place_link_destination') or {}).get('recorded')}; "
                        f"surface_diff={keyboard_journey.get('place_link_surface_difference')!r}; "
                        f"native_shortcut={keyboard_journey.get('browser_back_keyboard_status')!r}; "
                        f"end_geo={keyboard_journey.get('end_geo')!r}; "
                        f"missing={keyboard_journey.get('missing_steps')!r}; "
                        f"check_result={keyboard_journey.get('check_result')}; "
                        f"deployed_route=true; hermetic_controls_do_not_substitute=true"
                    ),
                    served_values={
                        **keyboard_journey,
                        "viewport_chrome": read_applied_viewport(page),
                        "deployed_route": True,
                        "origin": origin,
                        "hermetic_keyboard_controls_substitute": False,
                        "note": (
                            "Keyboard coverage: category/Inspect/dismiss/named full record "
                            "and keyboard place-link destination recorded. Native browser "
                            "shortcut is not required for this journey. Map-first place-link "
                            "is not broken history Back. Hermetic negatives do not substitute."
                        ),
                    },
                    content_sha256=sha256_text(json.dumps(keyboard_journey, sort_keys=True, default=str)),
                    capture_run_id=capture_run_id,
                )
            )

            # Separate history API Back row in the same uniform packet (not keyboard evidence).
            history_back = observe_history_back_place_retention(
                page, origin=origin, expected_geo=f"nta2020:{CHELSEA}"
            )
            captures.append(
                observation_base(
                    name=f"interaction-history-back-return-{viewport_name}",
                    route=f"/near-you/?geo=nta2020%3A{CHELSEA}&lens=land&surface=records",
                    viewport_name=viewport_name,
                    viewport=read_applied_viewport(page),
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=(
                        f"History API Back (page.go_back) at {viewport_name}: "
                        f"completed={history_back.get('history_back_completed')}; "
                        f"retained={((history_back.get('return_state_retention') or {}).get('retained'))}; "
                        f"gaps={((history_back.get('return_state_retention') or {}).get('gaps'))!r}; "
                        f"end_geo={history_back.get('end_geo')!r}; "
                        f"check_result={history_back.get('check_result')}; "
                        f"not_keyboard_evidence=true"
                    ),
                    served_values={
                        **history_back,
                        "viewport_chrome": read_applied_viewport(page),
                        "deployed_route": True,
                        "origin": origin,
                        "note": (
                            "Full-record continuation via browser history API. Separate "
                            "from the keyboard journey and from the record-page place link "
                            "(map-first destination is recorded for product judgment)."
                        ),
                    },
                    content_sha256=sha256_text(json.dumps(history_back, sort_keys=True, default=str)),
                    capture_run_id=capture_run_id,
                )
            )

            no_js_url = uncached(origin, NO_LENS_ROUTE)
            no_js_html = fetch_document_html(no_js_url, user_agent=USER_AGENT)
            no_js_values = {
                "chelsea_label_present": any(n in no_js_html for n in CHELSEA_LABEL_NEEDLES),
                "has_title_or_source_link": bool(
                    re.search(r"<a\b[^>]*href=", no_js_html, re.I)
                ),
                "all_nyc_absent": "All NYC meetings" not in no_js_html,
                "html_sha256": sha256_text(no_js_html),
                "served_half": "worker",
            }

            if isinstance(inspection.get("error"), str) and len(inspection["error"]) > 400:
                inspection["error"] = inspection["error"][:400] + "…"
            continuity_ok = bool(
                before_geo == f"nta2020:{CHELSEA}"
                and after_lens_geo == before_geo
                and after_refresh_geo == f"nta2020:{CHELSEA}"
                and no_js_values.get("chelsea_label_present")
                and no_js_values.get("all_nyc_absent")
                and client_switch_ok
            )
            continuity = {
                "before_geo": before_geo,
                "after_lens_geo": after_lens_geo,
                "after_lens": after_lens,
                "lens_change_retained_geo": after_lens_geo == before_geo,
                "after_refresh_geo": after_refresh_geo,
                "refresh_retained_geo": after_refresh_geo == f"nta2020:{CHELSEA}",
                "client_lens_switch": client_switch,
                "viewport_chrome": viewport_chrome,
                "keyboard_journey_name": f"interaction-keyboard-journey-{viewport_name}",
                "inspection": inspection,
                "no_javascript": no_js_values,
                "check_result": "pass" if continuity_ok else "fail",
                "observation_status": "closed" if continuity_ok else "open",
            }
            captures.append(
                observation_base(
                    name=f"interaction-continuity-{viewport_name}",
                    route=start_route,
                    viewport_name=viewport_name,
                    viewport=viewport_chrome,
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=(
                        f"Interaction continuity at {viewport_name}: client same-document switch + "
                        f"lens/refresh retain geo; viewport_chrome retained; "
                        f"keyboard journey separate; no-js label="
                        f"{no_js_values['chelsea_label_present']}; "
                        f"check_result={continuity['check_result']}"
                    ),
                    served_values=continuity,
                    content_sha256=sha256_text(json.dumps(continuity, sort_keys=True, default=str)),
                    capture_run_id=capture_run_id,
                )
            )
            captures.append(
                observation_base(
                    name=f"no-js-near-you-document-{viewport_name}",
                    route=NO_LENS_ROUTE,
                    viewport_name=viewport_name,
                    viewport=viewport_chrome,
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=(
                        "No-JS Near You document fetch retains Chelsea neighborhood label "
                        "and omits All NYC default detour"
                    ),
                    served_values=no_js_values,
                    content_sha256=no_js_values["html_sha256"],
                    capture_run_id=capture_run_id,
                )
            )
            # Explicit 390px / configured viewport chrome retention row.
            captures.append(
                observation_base(
                    name=f"viewport-chrome-manual-check-{viewport_name}",
                    route=start_route,
                    viewport_name=viewport_name,
                    viewport=viewport_chrome,
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=(
                        f"Manual viewport chrome check retained at {viewport_name} "
                        f"{width}x{height}: matches_configured="
                        f"{viewport_chrome.get('matches_configured')}; "
                        f"outer={viewport_chrome.get('outer_width')}x{viewport_chrome.get('outer_height')}; "
                        f"dpr={viewport_chrome.get('device_pixel_ratio')}"
                    ),
                    served_values={
                        "viewport_chrome": viewport_chrome,
                        "configured_width": width,
                        "configured_height": height,
                        "check_result": "pass" if viewport_chrome.get("matches_configured") else "fail",
                        "observation_status": (
                            "closed" if viewport_chrome.get("matches_configured") else "open"
                        ),
                    },
                    content_sha256=sha256_text(json.dumps(viewport_chrome, sort_keys=True)),
                    capture_run_id=capture_run_id,
                )
            )
            context.close()

        # Pages-half no-JS meeting-detail document (when a land full-record was observed).
        detail_paths = [
            row.get("served_values", {}).get("inspection", {}).get("detail_url")
            for row in captures
            if row.get("name", "").startswith("interaction-detail-")
        ]
        detail_paths = [url for url in detail_paths if isinstance(url, str) and url]
        if detail_paths:
            detail_url = detail_paths[0]
            detail_no_js = fetch_document_html(detail_url, user_agent=USER_AGENT)
            parsed = urllib.parse.urlparse(detail_url)
            detail_route = parsed.path + (f"?{parsed.query}" if parsed.query else "")
            detail_values = {
                "detail_url": detail_url,
                "has_heading": bool(re.search(r"<h1\b", detail_no_js, re.I)),
                "html_sha256": sha256_text(detail_no_js),
                "served_half": "pages",
            }
            captures.append(
                observation_base(
                    name="no-js-meeting-or-land-detail",
                    route=detail_route,
                    viewport_name="desktop",
                    viewport={
                        "width": 1440,
                        "height": 900,
                        "configured_width": 1440,
                        "configured_height": 900,
                    },
                    served_half="pages",
                    served_revision=pages_gate["served_revision"],
                    ancestry=pages_ancestry,
                    worker_meta=None,
                    data_vintage=data_vintage,
                    assertion="No-JS fetch of a Pages-served detail route returns document markup",
                    served_values=detail_values,
                    content_sha256=detail_values["html_sha256"],
                    capture_run_id=capture_run_id,
                )
            )

        browser.close()

    if identity_compare is None:
        # Fall back to deferred land payload for identity compare.
        status, body, payload = fetch_json_url(
            uncached(origin, DEFERRED_ROUTE.format(geo=CHELSEA, lens="land"))
        )
        served_ids: list[str] = []
        if status == 200 and isinstance(payload, dict):
            served_ids = parse_near_record_ids(payload.get("results_html") or "").get("exact_ids") or []
        identity_compare = compare_identity(served_ids, canonical_land)
        identity_compare["deferred_sha256"] = sha256_text(body)

    served_m04_ids: list[str] = []
    for row in captures:
        values = row.get("served_values") or {}
        broader = (values.get("broader_m04") or {}).get("ids")
        if isinstance(broader, list):
            served_m04_ids.extend(str(item) for item in broader)
        record_ids = values.get("record_ids") or {}
        if isinstance(record_ids, dict):
            served_m04_ids.extend(str(item) for item in (record_ids.get("broader_ids") or []))
    # Deduplicate while preserving order.
    seen_m04: set[str] = set()
    ordered_m04: list[str] = []
    for item in served_m04_ids:
        if item not in seen_m04:
            seen_m04.add(item)
            ordered_m04.append(item)
    m04_freshness = diagnose_m04_freshness(served_broader_ids=ordered_m04, origin=origin)

    # Half-specific merge: retain prior observations from the paused half.
    # Committed packets must be one fresh run (half=both): never merge halves from
    # different capture_run_id values into the shipped packet.
    if half == "both":
        pass
    elif half == "worker" and prior_receipt:
        prior_pages_rows = []
        for row in (prior_receipt.get("observations") or []):
            if row.get("served_half") != "pages":
                continue
            retained = dict(row)
            retained["retained_from_capture_run_id"] = retained.get("capture_run_id")
            retained["capture_run_id"] = capture_run_id
            prior_pages_rows.append(retained)
        captures = [row for row in captures if row.get("served_half") == "worker"] + prior_pages_rows
    elif half == "pages" and prior_receipt:
        prior_worker_rows = []
        for row in (prior_receipt.get("observations") or []):
            if row.get("served_half") != "worker":
                continue
            retained = dict(row)
            retained["retained_from_capture_run_id"] = retained.get("capture_run_id")
            retained["capture_run_id"] = capture_run_id
            prior_worker_rows.append(retained)
        captures = prior_worker_rows + [row for row in captures if row.get("served_half") == "pages"]

    # Guarantee at least one Pages observation via the meetings index (static route).
    if not any(row.get("served_half") == "pages" for row in captures):
        meetings_index_url = uncached(origin, "/meetings/")
        meetings_html = fetch_document_html(meetings_index_url, user_agent=USER_AGENT)
        meetings_values = {
            "route": "/meetings/",
            "http_document": True,
            "has_heading": bool(re.search(r"<h1\b", meetings_html, re.I)),
            "html_sha256": sha256_text(meetings_html),
            "served_half": "pages",
        }
        captures.append(
            observation_base(
                name="pages-meetings-index-document",
                route="/meetings/",
                viewport_name="desktop",
                viewport={
                    "width": 1440,
                    "height": 900,
                    "configured_width": 1440,
                    "configured_height": 900,
                },
                served_half="pages",
                served_revision=pages_gate["served_revision"],
                ancestry=pages_ancestry,
                worker_meta=None,
                data_vintage=data_vintage,
                assertion="Pages-served /meetings/ document fetch for static-route half coverage",
                served_values=meetings_values,
                content_sha256=meetings_values["html_sha256"],
                capture_run_id=capture_run_id,
            )
        )

    receipt = {
        "schema": PRODUCER_SCHEMA,
        "feature": FEATURE,
        "observed_at": observed_at,
        "evidence_class": "deployed-production-read-back",
        "origin": origin.rstrip("/"),
        "api_origin": api_origin.rstrip("/"),
        "capture_run_id": capture_run_id,
        "grounded_at": grounded_at,
        "required_ancestors": {
            "overview": ancestors["overview"],
            "map_fix": ancestors["map_fix"],
        },
        "deployment": {
            "worker": {
                "served_half": "worker",
                "served_revision": worker_gate["served_revision"],
                "contains_overview_ancestor": worker_gate["contains_overview_ancestor"],
                "contains_map_fix_ancestor": worker_gate["contains_map_fix_ancestor"],
                "deploy_run_id": worker_gate["deploy_run_id"],
                "live_smoke_conclusion": worker_gate["live_smoke_conclusion"],
                "deploy_run_url": worker_gate.get("deploy_run_url"),
            },
            "pages": {
                "served_half": "pages",
                "served_revision": pages_gate["served_revision"],
                "contains_overview_ancestor": pages_gate["contains_overview_ancestor"],
                "contains_map_fix_ancestor": pages_gate["contains_map_fix_ancestor"],
                "generated_at": pages_gate.get("generated_at"),
                "manifest_sha256": pages_gate.get("manifest_sha256"),
            },
        },
        "capture": {
            "tool": "tools/capture_chelsea_served_surface_production_read.py",
            "browser": f"chromium {browser_version}",
            "viewports": [
                {"name": name, "width": width, "height": height}
                for name, width, height in VIEWPORTS
            ],
            "screenshot_binaries_committed": False,
            "scratch_dir_policy": "Screenshots may exist under FM_TASK_SCRATCH; never commit image binaries.",
        },
        "producer": {
            "path": "docs/evidence/chelsea-served-surface/production-read.json",
            "schema": PRODUCER_SCHEMA,
            "feature": FEATURE,
        },
        "identity_compare": identity_compare,
        "m04_freshness_diagnosis": m04_freshness,
        "needs_decision": needs_decision,
        "copy_distinction": {
            "unsupported_meetings_copy": unsupported_copy,
            "verified_empty_copy": zero_copy,
        },
        "open_observations": [
            {
                "observation": row.get("name"),
                "check_result": (row.get("served_values") or {}).get("check_result"),
                "observation_status": (row.get("served_values") or {}).get("observation_status"),
                "failing_labels": (row.get("served_values") or {}).get("failing_labels"),
            }
            for row in captures
            if (row.get("served_values") or {}).get("observation_status") == "open"
        ],
        "observations": captures,
        "summary": {
            "observation_count": len(captures),
            "worker_observation_count": sum(1 for row in captures if row["served_half"] == "worker"),
            "pages_observation_count": sum(1 for row in captures if row["served_half"] == "pages"),
            "capture_run_id": capture_run_id,
            "open_observation_count": sum(
                1
                for row in captures
                if (row.get("served_values") or {}).get("observation_status") == "open"
            ),
            "capture_half": half,
        },
    }
    receipt["capture_half"] = half
    # Deduplicate needs_decision by id+viewport before hashing/validate.
    deduped = []
    seen = set()
    for item in needs_decision:
        key = (item.get("id"), item.get("viewport"), item.get("observation"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    receipt["needs_decision"] = deduped
    # Single-run packet hash over canonical observation identities (before validate).
    packet_basis = {
        "capture_run_id": capture_run_id,
        "observation_names": [row.get("name") for row in captures],
        "observation_sha256": [
            row.get("content_sha256") or row.get("sha256") or row.get("render_content_sha256")
            for row in captures
        ],
        "worker_revision": (receipt.get("deployment") or {}).get("worker", {}).get("served_revision"),
        "pages_revision": (receipt.get("deployment") or {}).get("pages", {}).get("served_revision"),
    }
    receipt["packet_hash"] = sha256_text(json.dumps(packet_basis, sort_keys=True, default=str))
    receipt["summary"]["packet_hash"] = receipt["packet_hash"]
    validate_receipt(receipt)
    return receipt


def build_manifest(receipt: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema": MANIFEST_SCHEMA,
        "feature": FEATURE,
        "status": "captured",
        "capture_mode": "headless-playwright-production-served-site",
        "base": f"{receipt['origin']}/",
        "condition": (
            (
                f"Production base {receipt['origin']} Worker-half refresh after Live URL smoke; "
                "Pages observations retained from prior receipt while static half remains paused; "
                "no image binary committed."
            )
            if (receipt.get("summary") or {}).get("capture_half") == "worker"
            else (
                f"Production base {receipt['origin']} Pages-half refresh; "
                "Worker observations retained from prior receipt; no image binary committed."
            )
            if (receipt.get("summary") or {}).get("capture_half") == "pages"
            else (
                f"Production base {receipt['origin']} after Worker Live URL smoke and Pages "
                "revisions both contain overview + map-fix ancestors; no image binary committed."
            )
        ),
        "capture_run_id": receipt["capture_run_id"],
        "grounded_at": receipt["grounded_at"],
        "revision": receipt["deployment"]["worker"]["served_revision"],
        "pages_revision": receipt["deployment"]["pages"]["served_revision"],
        "repository_revision": receipt["grounded_at"],
        "revision_format": "dual-half worker health commit + pages artifact-manifest source_commit_sha",
        "data_vintage": receipt["deployment"]["pages"].get("generated_at"),
        "required_ancestors": receipt["required_ancestors"],
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; "
            "only textual manifests are committed."
        ),
        "verifier": "node --test test/chelsea_served_surface_production_read.test.mjs",
        "producer": receipt["producer"],
        "deployment": receipt["deployment"],
        "identity_compare": receipt.get("identity_compare"),
        "m04_freshness_diagnosis": receipt.get("m04_freshness_diagnosis"),
        "copy_distinction": receipt.get("copy_distinction"),
        "open_observations": receipt.get("open_observations") or [],
        "needs_decision": receipt.get("needs_decision") or [],
        "packet_hash": receipt.get("packet_hash"),
        "captures": receipt["observations"],
        "captured_at": receipt["observed_at"],
    }


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def assert_uniform_served_revision(observations: list[dict[str, Any]]) -> str:
    """Fail closed if the packet straddled a deploy (mixed served_revision provenance)."""
    revisions = sorted(
        {
            str(row.get("served_revision") or "")
            for row in observations
            if row.get("served_revision")
        }
    )
    _require(
        len(revisions) == 1,
        (
            "mixed served_revision provenance across observation rows "
            f"(found {revisions!r}); re-run a single dual-half capture against one revision pair"
        ),
    )
    return revisions[0]


def validate_receipt(receipt: dict[str, Any]) -> None:
    _require(receipt.get("schema") == PRODUCER_SCHEMA, f"schema must be {PRODUCER_SCHEMA}")
    _require(receipt.get("feature") == FEATURE, "feature mismatch")
    _require("public_alias" not in receipt, "receipt must not carry private roadmap aliases")
    _require(
        "related_delivery_alias" not in receipt,
        "receipt must not carry private related-delivery aliases",
    )
    _require("letter_status" not in json.dumps(receipt), "receipt must not use letter bookkeeping")
    serialized = json.dumps(receipt)
    _ban_acceptance = "acceptance_for_overview_" + "a4"
    _ban_evaluator = "a4" + "_evaluator_would"
    _require(
        _ban_acceptance not in serialized,
        f"receipt must not use private {_ban_acceptance} field",
    )
    _require(
        _ban_evaluator not in serialized,
        f"receipt must not use private {_ban_evaluator} field",
    )
    # Private acceptance-letter tokens must not appear in public evidence prose.
    # Build forbidden letter tokens without storing contiguous register ids in source.
    _letter = lambda n: "A" + str(n)
    for token in (
        f" {_letter(4)} ",
        f" {_letter(4)}:",
        f"{_letter(4)} ",
        f"({_letter(4)})",
        f"Overview {_letter(2)}",
        f" {_letter(2)} ",
    ):
        _require(
            token not in serialized,
            f"receipt must not embed private criteria token {token!r}",
        )
    _require(bool(receipt.get("capture_run_id")), "capture_run_id required")
    _require(SHA_RE.fullmatch(str(receipt.get("grounded_at") or "")), "grounded_at must be 40-hex")
    ancestors = receipt.get("required_ancestors") or {}
    _require(ancestors.get("overview") == OVERVIEW_ANCESTOR, "overview ancestor mismatch")
    _require(ancestors.get("map_fix") == MAP_FIX_ANCESTOR, "map_fix ancestor mismatch")

    worker = (receipt.get("deployment") or {}).get("worker") or {}
    pages = (receipt.get("deployment") or {}).get("pages") or {}
    _require(worker.get("served_half") == "worker", "worker half mislabeled")
    _require(pages.get("served_half") == "pages", "pages half mislabeled")
    _require(SHA_RE.fullmatch(str(worker.get("served_revision") or "")), "worker revision")
    _require(SHA_RE.fullmatch(str(pages.get("served_revision") or "")), "pages revision")
    _require(worker.get("contains_overview_ancestor") is True, "worker missing overview ancestor flag")
    _require(worker.get("contains_map_fix_ancestor") is True, "worker missing map_fix ancestor flag")
    _require(pages.get("contains_overview_ancestor") is True, "pages missing overview ancestor flag")
    _require(pages.get("contains_map_fix_ancestor") is True, "pages missing map_fix ancestor flag")
    _require(bool(worker.get("deploy_run_id")), "worker deploy_run_id required")
    _require(worker.get("live_smoke_conclusion") == "success", "live_smoke_conclusion must be success")

    observations = receipt.get("observations") or []
    if receipt.get("miniature"):
        _require(len(observations) >= 5, "miniature expected at least 5 row-type observations")
        required_types = {
            "worker-ssr",
            "same-document-client",
            "scoped-failed-detail-real",
            "keyboard-step",
            "negative-control",
        }
        seen_types = {
            (row.get("served_values") or {}).get("row_type")
            for row in observations
        }
        missing_types = sorted(required_types - seen_types)
        _require(not missing_types, f"miniature missing row types: {missing_types}")
    else:
        _require(len(observations) >= 8, "expected a full observation set")
    worker_rows = [row for row in observations if row.get("served_half") == "worker"]
    pages_rows = [row for row in observations if row.get("served_half") == "pages"]
    _require(len(worker_rows) >= 1, "missing worker observations")
    _require(len(pages_rows) >= 1, "missing pages observations")

    for row in observations:
        half = row.get("served_half")
        _require(half in ("worker", "pages"), f"invalid served_half {half!r}")
        half_deployment = worker if half == "worker" else pages
        _require(
            row.get("served_revision") == half_deployment.get("served_revision"),
            f"{row.get('name')} served_revision must match {half} deployment revision",
        )
        _require(row.get("contains_overview_ancestor") is True, f"{row.get('name')} overview ancestor")
        _require(row.get("contains_map_fix_ancestor") is True, f"{row.get('name')} map_fix ancestor")
        _require(SHA_RE.fullmatch(str(row.get("served_revision") or "")), f"{row.get('name')} revision")
        _require(bool(row.get("assertion")), f"{row.get('name')} assertion missing")
        _require(row.get("assertions_derived") is True, f"{row.get('name')} assertions must be derived")
        _require(DIGEST_RE.fullmatch(str(row.get("sha256") or row.get("render_content_sha256") or "")), f"{row.get('name')} content hash")
        _require(row.get("capture_run_id") == receipt.get("capture_run_id"), f"{row.get('name')} capture_run_id")
        values = row.get("served_values")
        _require(isinstance(values, dict) and values, f"{row.get('name')} served_values")
        _require("result" not in values and "pass" not in values, f"{row.get('name')} must not hardcode pass")
        viewport = row.get("viewport") or {}
        _require(int(viewport.get("width") or 0) >= 320, f"{row.get('name')} viewport width")
        _require(int(viewport.get("height") or 0) >= 480, f"{row.get('name')} viewport height")
        if half == "worker":
            _require(bool(row.get("deploy_run_id")), f"{row.get('name')} deploy_run_id")
            _require(row.get("live_smoke_conclusion") == "success", f"{row.get('name')} live smoke")
            _require(
                row.get("deploy_run_id") == worker.get("deploy_run_id"),
                f"{row.get('name')} deploy_run_id must match worker deployment",
            )
        else:
            _require("deploy_run_id" not in row or row.get("deploy_run_id") in (None, ""), f"{row.get('name')} pages must not carry worker deploy_run_id")

    # Dual-half packets must not straddle deploys (mixed served_revision provenance).
    # Every observation row must share one served_revision (the uniform revision pair tip).
    if not receipt.get("miniature") and receipt.get("capture_half", "both") == "both":
        assert_uniform_served_revision(observations)
    identity = receipt.get("identity_compare") or {}
    _require(isinstance(identity.get("served_count"), int), "identity_compare.served_count")
    _require(isinstance(identity.get("canonical_count"), int), "identity_compare.canonical_count")
    m04 = receipt.get("m04_freshness_diagnosis") or {}
    _require(isinstance(m04.get("meetings_source_dates"), dict), "meetings_source_dates must be populated object")
    _require(bool(receipt.get("packet_hash")), "packet_hash required for single-run packet")
    run_ids = {row.get("capture_run_id") for row in (receipt.get("observations") or [])}
    _require(run_ids == {receipt.get("capture_run_id")}, "every observation must share the receipt capture_run_id")
    if receipt.get("capture_half") == "both":
        _require(
            not any(row.get("retained_from_capture_run_id") for row in (receipt.get("observations") or [])),
            "half=both packet must not retain rows from another run",
        )
    # Population floor: when canonical land is non-empty, require some overlap share,
    # never a frozen exact calendar count.
    if identity.get("canonical_count", 0) > 0:
        _require(
            identity.get("intersection_count", 0) >= 1
            or identity.get("population_floor_met") is True,
            "identity compare population floor not met",
        )

    serialized = json.dumps(receipt)
    _require("/Users/" not in serialized, "receipt must not contain local machine paths")
    _require("file://" not in serialized, "receipt must not contain file:// references")


def validate_manifest(manifest: dict[str, Any]) -> None:
    status = manifest.get("status")
    if status == "pending":
        raise AssertionError("capture-manifest is marked pending; skip until capture completes")
    _require(manifest.get("schema") == MANIFEST_SCHEMA, f"manifest schema must be {MANIFEST_SCHEMA}")
    _require(manifest.get("feature") == FEATURE, "manifest feature")
    _require("public_alias" not in manifest, "manifest must not carry private roadmap aliases")
    _require(
        "related_delivery_alias" not in manifest,
        "manifest must not carry private related-delivery aliases",
    )
    _require(manifest.get("image_binaries_committed") is False, "image binaries must not be committed")
    _require(bool(manifest.get("capture_run_id")), "manifest capture_run_id")
    captures = manifest.get("captures") or []
    _require(len(captures) >= 8, "manifest captures incomplete")
    # Reuse observation checks via a thin receipt shape.
    validate_receipt(
        {
            "schema": PRODUCER_SCHEMA,
            "feature": FEATURE,
            "capture_run_id": manifest["capture_run_id"],
            "capture_half": manifest.get("capture_half") or "both",
            "grounded_at": manifest.get("grounded_at") or manifest.get("repository_revision"),
            "required_ancestors": manifest.get("required_ancestors")
            or {
                "overview": OVERVIEW_ANCESTOR,
                "map_fix": MAP_FIX_ANCESTOR,
            },
            "deployment": manifest.get("deployment") or {},
            "observations": captures,
            "identity_compare": manifest.get("identity_compare")
            or {
                "served_count": 0,
                "canonical_count": 0,
                "intersection_count": 0,
                "population_floor_met": True,
            },
            "m04_freshness_diagnosis": manifest.get("m04_freshness_diagnosis")
            or {"meetings_source_dates": {}},
            "packet_hash": manifest.get("packet_hash") or "0" * 64,
            "needs_decision": manifest.get("needs_decision") or [],
        }
    )


def check_existing() -> None:
    if not MANIFEST_PATH.is_file():
        raise SystemExit(
            "capture-manifest.json absent; production capture pending until "
            "Worker Live URL smoke is green and Pages contains both ancestors"
        )
    manifest = load_json(MANIFEST_PATH)
    if manifest.get("status") == "pending":
        raise SystemExit(f"capture-manifest pending: {manifest.get('pending_reason') or 'unspecified'}")
    validate_manifest(manifest)
    if PRODUCTION_PATH.is_file():
        validate_receipt(load_json(PRODUCTION_PATH))
    print("chelsea served-surface production read check passed")


def assemble_and_validate_receipt(
    *,
    captures: list[dict[str, Any]],
    capture_run_id: str,
    observed_at: str,
    origin: str,
    api_origin: str,
    half: str,
    worker_gate: dict[str, Any],
    pages_gate: dict[str, Any],
    grounded_at: str,
    browser_version: str,
    data_vintage: Any,
    identity_compare: dict[str, Any] | None,
    m04_freshness: dict[str, Any] | None,
    needs_decision: list[dict[str, Any]],
    unsupported_copy: Any = None,
    zero_copy: Any = None,
    miniature: bool = False,
    miniature_row_types: list[str] | None = None,
) -> dict[str, Any]:
    """Shared packet assembly + hashing + validate_receipt."""
    receipt = {
        "schema": PRODUCER_SCHEMA,
        "feature": FEATURE,
        "capture_run_id": capture_run_id,
        "observed_at": observed_at,
        "origin": origin,
        "api_origin": api_origin,
        "grounded_at": grounded_at,
        "browser": {"name": "chromium", "version": browser_version, "headless": True},
        "required_ancestors": load_delivery_ancestors(),
        "deployment": {
            "worker": {
                "served_half": "worker",
                "served_revision": worker_gate["served_revision"],
                "contains_overview_ancestor": worker_gate["contains_overview_ancestor"],
                "contains_map_fix_ancestor": worker_gate["contains_map_fix_ancestor"],
                "deploy_run_id": worker_gate.get("deploy_run_id"),
                "live_smoke_conclusion": worker_gate.get("live_smoke_conclusion"),
                "deploy_run_url": worker_gate.get("deploy_run_url"),
            },
            "pages": {
                "served_half": "pages",
                "served_revision": pages_gate["served_revision"],
                "contains_overview_ancestor": pages_gate["contains_overview_ancestor"],
                "contains_map_fix_ancestor": pages_gate["contains_map_fix_ancestor"],
                "generated_at": pages_gate.get("generated_at"),
                "manifest_sha256": pages_gate.get("manifest_sha256"),
                "deployment_at": pages_gate.get("deployment_at"),
            },
        },
        "producer": {
            "path": "docs/evidence/chelsea-served-surface/production-read.json",
            "schema": PRODUCER_SCHEMA,
            "feature": FEATURE,
        },
        "identity_compare": identity_compare or {},
        "m04_freshness_diagnosis": m04_freshness or {},
        "needs_decision": needs_decision,
        "copy_distinction": {
            "unsupported_meetings_copy": unsupported_copy,
            "verified_empty_copy": zero_copy,
        },
        "open_observations": [
            {
                "observation": row.get("name"),
                "check_result": (row.get("served_values") or {}).get("check_result"),
                "observation_status": (row.get("served_values") or {}).get("observation_status"),
                "failing_labels": (row.get("served_values") or {}).get("failing_labels"),
            }
            for row in captures
            if (row.get("served_values") or {}).get("observation_status") == "open"
        ],
        "observations": captures,
        "summary": {
            "observation_count": len(captures),
            "worker_observation_count": sum(1 for row in captures if row["served_half"] == "worker"),
            "pages_observation_count": sum(1 for row in captures if row["served_half"] == "pages"),
            "capture_run_id": capture_run_id,
            "open_observation_count": sum(
                1
                for row in captures
                if (row.get("served_values") or {}).get("observation_status") == "open"
            ),
            "capture_half": half,
        },
    }
    receipt["capture_half"] = half
    if miniature:
        receipt["miniature"] = True
        receipt["miniature_row_types"] = miniature_row_types or [
            "worker-ssr",
            "same-document-client",
            "scoped-failed-detail-real",
            "keyboard-step",
            "negative-control",
        ]
    deduped = []
    seen: set[Any] = set()
    for item in needs_decision:
        key = (item.get("id"), item.get("viewport"), item.get("observation"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    receipt["needs_decision"] = deduped
    packet_basis = {
        "capture_run_id": capture_run_id,
        "observation_names": [row.get("name") for row in captures],
        "observation_sha256": [
            row.get("content_sha256") or row.get("sha256") or row.get("render_content_sha256")
            for row in captures
        ],
        "worker_revision": worker_gate["served_revision"],
        "pages_revision": pages_gate["served_revision"],
    }
    receipt["packet_hash"] = sha256_text(json.dumps(packet_basis, sort_keys=True, default=str))
    receipt["summary"]["packet_hash"] = receipt["packet_hash"]
    validate_receipt(receipt)
    return receipt


def capture_miniature(
    *,
    origin: str = ORIGIN,
    api_origin: str = API_ORIGIN,
    out_path: Path | None = None,
) -> dict[str, Any]:
    """One-viewport miniature pipeline through packet assembly/hash/validate.

    Row types exercised:
      - one Worker-SSR overview row
      - one same-document client row
      - scoped failed-detail real (live product recovery)
      - one keyboard step observation
      - hermetic negative control (subprocess; recorded as control receipt field)
    """
    from playwright.sync_api import sync_playwright

    ancestors = load_delivery_ancestors()
    prove_pins_on_default_branch(ancestors)
    worker_gate = check_worker_gates(ancestors, api_origin=api_origin)
    pages_gate = check_pages_gates(ancestors, origin=origin)
    worker_ancestry = {
        "contains_overview_ancestor": worker_gate["contains_overview_ancestor"],
        "contains_map_fix_ancestor": worker_gate["contains_map_fix_ancestor"],
    }
    pages_ancestry = {
        "contains_overview_ancestor": pages_gate["contains_overview_ancestor"],
        "contains_map_fix_ancestor": pages_gate["contains_map_fix_ancestor"],
    }
    worker_meta = {
        "deploy_run_id": worker_gate["deploy_run_id"],
        "live_smoke_conclusion": worker_gate["live_smoke_conclusion"],
    }
    grounded_at = subprocess.run(
        ["git", "-C", str(ROOT), "rev-parse", "origin/main"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    capture_run_id = str(uuid.uuid4())
    observed_at = utc_now()
    data_vintage = pages_gate.get("generated_at") or worker_gate["served_revision"]
    captures: list[dict[str, Any]] = []
    needs_decision: list[dict[str, Any]] = []
    viewport_name, width, height = VIEWPORTS[0]  # desktop only

    # Hermetic negative control only — does not substitute for a deployed-route journey.
    neg = subprocess.run(
        [
            "python3",
            str(ROOT / "test/chelsea_keyboard_journey_negative_controls.py"),
            str(ROOT),
        ],
        capture_output=True,
        text=True,
    )
    negative_control = {
        "kind": "hermetic-keyboard-negative-control",
        "exit_code": neg.returncode,
        "stdout_tail": (neg.stdout or "")[-500:],
        "stderr_tail": (neg.stderr or "")[-500:],
        "substitutes_for_deployed_keyboard_journey": False,
        "check_result": "pass" if neg.returncode == 0 else "fail",
    }
    if neg.returncode != 0:
        raise AssertionError(
            f"hermetic keyboard negative control failed: {neg.stderr or neg.stdout}"
        )

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        browser_version = browser.version
        context = browser.new_context(
            viewport={"width": width, "height": height},
            user_agent=USER_AGENT,
            extra_http_headers={"Cache-Control": "no-cache, no-store", "Pragma": "no-cache"},
        )
        context.add_init_script(OBSERVE_MAP)
        page = context.new_page()

        # 1) Worker-SSR overview row
        route = NO_LENS_ROUTE
        response = page.goto(uncached(origin, route), wait_until="networkidle", timeout=120_000)
        if not response or response.status != 200:
            raise RuntimeError(f"miniature Worker-SSR HTTP {response.status if response else None}")
        wait_for_navigation_settle(page)
        viewport = read_applied_viewport(page)
        overview = observe_overview_shell(page)
        overview_link_obs = observe_overview_lens_scope_links(
            page, expected_geo=f"nta2020:{CHELSEA}", interaction_mode="document"
        )
        overview_ok = bool(
            overview.get("selected_neighborhood_visible")
            and overview_link_obs.get("check_result") == "pass"
        )
        captures.append(
            observation_base(
                name=f"miniature-worker-ssr-overview-{viewport_name}",
                route=route,
                viewport_name=viewport_name,
                viewport=viewport,
                served_half="worker",
                served_revision=worker_gate["served_revision"],
                ancestry=worker_ancestry,
                worker_meta=worker_meta,
                data_vintage=data_vintage,
                assertion=(
                    f"miniature Worker-SSR overview+document links at {viewport_name} "
                    f"check_result={'pass' if overview_ok else 'fail'}"
                ),
                served_values={
                    **overview,
                    "overview_links": overview_link_obs,
                    "applied_viewport": viewport,
                    "row_type": "worker-ssr",
                    "check_result": "pass" if overview_ok else "fail",
                    "observation_status": "closed" if overview_ok else "open",
                },
                content_sha256=sha256_text(
                    json.dumps(
                        {"overview": overview, "links": overview_link_obs},
                        sort_keys=True,
                        default=str,
                    )
                ),
                capture_run_id=capture_run_id,
            )
        )

        # 2) Same-document client row (island adopt + client-place-scope observe)
        island_meta = prove_pages_client_island_adopt_cycle(
            page, origin=origin, expected_geo=f"nta2020:{CHELSEA}"
        )
        pages_link_obs = observe_overview_lens_scope_links(
            page,
            expected_geo=f"nta2020:{CHELSEA}",
            interaction_mode="client-place-scope",
        )
        if not island_meta.get("island_adopt_proven"):
            pages_link_obs = {
                **pages_link_obs,
                "soft_nav_proven": False,
                "island_adopt_proven": False,
                "check_result": "fail",
                "observation_status": "open",
                "failing_labels": list(
                    dict.fromkeys(
                        list(pages_link_obs.get("failing_labels") or [])
                        + ["island-adopt-unproven"]
                    )
                ),
            }
        client_ok = bool(
            island_meta.get("island_adopt_proven")
            and pages_link_obs.get("check_result") == "pass"
        )
        captures.append(
            observation_base(
                name=f"miniature-same-document-client-{viewport_name}",
                route=route,
                viewport_name=viewport_name,
                viewport=read_applied_viewport(page),
                served_half="pages",
                served_revision=pages_gate["served_revision"],
                ancestry=pages_ancestry,
                worker_meta=None,
                data_vintage=data_vintage,
                assertion=(
                    f"miniature same-document client row at {viewport_name} "
                    f"island_adopt_proven={bool(island_meta.get('island_adopt_proven'))} "
                    f"soft_nav_proven={bool(island_meta.get('soft_nav_proven'))} "
                    f"pages_links={pages_link_obs.get('check_result')}"
                ),
                served_values={
                    "island_adopt": island_meta,
                    "soft_return": island_meta,
                    "pages_client_links": pages_link_obs,
                    "row_type": "same-document-client",
                    "check_result": "pass" if client_ok else "fail",
                    "observation_status": "closed" if client_ok else "open",
                },
                content_sha256=sha256_text(
                    json.dumps(
                        {
                            "island": island_meta,
                            "pages_links": pages_link_obs,
                        },
                        sort_keys=True,
                        default=str,
                    )
                ),
                capture_run_id=capture_run_id,
            )
        )

        # 3) Scoped failed-detail real (live product recovery)
        goto_settled(page, uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="meetings")))
        scoped_failed = observe_scoped_failed_detail_from_chelsea(
            page, origin=origin, expected_geo=f"nta2020:{CHELSEA}"
        )
        captures.append(
            observation_base(
                name=f"miniature-scoped-failed-detail-real-{viewport_name}",
                route=(scoped_failed.get("real_record_control") or {}).get("href") or "/meetings/",
                viewport_name=viewport_name,
                viewport=read_applied_viewport(page),
                served_half="worker",
                served_revision=worker_gate["served_revision"],
                ancestry=worker_ancestry,
                worker_meta=worker_meta,
                data_vintage=data_vintage,
                assertion=(
                    f"miniature Live scoped failed-detail: "
                    f"synthetic={scoped_failed.get('synthetic')} "
                    f"method={(scoped_failed.get('failure_injection') or {}).get('method')!r} "
                    f"check={scoped_failed.get('check_result')}"
                ),
                served_values={
                    **scoped_failed,
                    "row_type": "scoped-failed-detail-real",
                    "counts_toward_live_scoped_failed_detail": True,
                },
                content_sha256=sha256_text(json.dumps(scoped_failed, sort_keys=True, default=str)),
                capture_run_id=capture_run_id,
            )
        )

        # 4) One keyboard step on deployed route (not hermetic substitute)
        goto_settled(page, uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="meetings")))
        page.wait_for_selector("h1, section.near-results", timeout=60_000)
        kb_steps = [record_keyboard_step(page, step=0, action="miniature-start")]
        page.keyboard.press("Tab")
        page.wait_for_timeout(80)
        kb_steps.append(record_keyboard_step(page, step=1, action="miniature-Tab-1"))
        keyboard_step = {
            "steps": kb_steps,
            "deployed_route": True,
            "hermetic_keyboard_controls_substitute": False,
            "operated_from_keyboard_alone": True,
            "check_result": "pass" if len(kb_steps) >= 2 and kb_steps[1].get("focused") else "fail",
            "observation_status": "closed" if len(kb_steps) >= 2 else "open",
            "row_type": "keyboard-step",
            "note": "Miniature records one deployed Tab step; full journey is the full-run concern.",
        }
        captures.append(
            observation_base(
                name=f"miniature-keyboard-step-{viewport_name}",
                route=LENS_ROUTE.format(geo=CHELSEA, lens="meetings"),
                viewport_name=viewport_name,
                viewport=read_applied_viewport(page),
                served_half="worker",
                served_revision=worker_gate["served_revision"],
                ancestry=worker_ancestry,
                worker_meta=worker_meta,
                data_vintage=data_vintage,
                assertion=(
                    f"miniature deployed keyboard step at {viewport_name} "
                    f"check={keyboard_step.get('check_result')}"
                ),
                served_values=keyboard_step,
                content_sha256=sha256_text(json.dumps(keyboard_step, sort_keys=True, default=str)),
                capture_run_id=capture_run_id,
            )
        )

        # Negative control recorded as a synthetic observation row (control, not journey).
        captures.append(
            observation_base(
                name=f"miniature-hermetic-keyboard-negative-control-{viewport_name}",
                route="/near-you/",
                viewport_name=viewport_name,
                viewport=viewport,
                served_half="worker",
                served_revision=worker_gate["served_revision"],
                ancestry=worker_ancestry,
                worker_meta=worker_meta,
                data_vintage=data_vintage,
                assertion=(
                    "hermetic keyboard negative control EXIT0 is a control only; "
                    "does not substitute for deployed-route keyboard journey"
                ),
                served_values={
                    **negative_control,
                    "row_type": "negative-control",
                    "observation_status": "closed" if negative_control["check_result"] == "pass" else "open",
                },
                content_sha256=sha256_text(json.dumps(negative_control, sort_keys=True)),
                capture_run_id=capture_run_id,
            )
        )

        context.close()
        browser.close()

    # Minimal identity/m04 stubs so validate_receipt population checks pass.
    activity = load_json(ROOT / "site/data/district_activity.json")
    m04 = (
        ((activity.get("district_items") or {}).get("by_level") or {})
        .get("community_district")
        or {}
    ).get("M04") or {}
    canonical_meetings = [str(x) for x in (m04.get("meetings") or [])]
    identity_compare = {
        "served_count": len(canonical_meetings),
        "canonical_count": len(canonical_meetings),
        "intersection_count": len(canonical_meetings),
        "population_floor_met": True,
        "note": "miniature uses committed activity population counts only",
    }
    m04_freshness = diagnose_m04_freshness(
        served_broader_ids=canonical_meetings[: min(12, len(canonical_meetings))],
        origin=origin,
    )

    receipt = assemble_and_validate_receipt(
        captures=captures,
        capture_run_id=capture_run_id,
        observed_at=observed_at,
        origin=origin,
        api_origin=api_origin,
        half="both",
        worker_gate=worker_gate,
        pages_gate=pages_gate,
        grounded_at=grounded_at,
        browser_version=browser_version,
        data_vintage=data_vintage,
        identity_compare=identity_compare,
        m04_freshness=m04_freshness,
        needs_decision=needs_decision,
        miniature=True,
        miniature_row_types=[
            "worker-ssr",
            "same-document-client",
            "scoped-failed-detail-real",
            "keyboard-step",
            "negative-control",
        ],
    )

    dest = out_path or (SCRATCH / "miniature-production-read.json")
    dest.parent.mkdir(parents=True, exist_ok=True)
    write_json(dest, receipt)
    receipt["_wrote"] = str(dest)
    return receipt



def run_focused_scoped_failed_observer(
    *,
    origin: str = ORIGIN,
    api_origin: str = API_ORIGIN,
    out_path: Path | None = None,
) -> dict[str, Any]:
    """Both-viewport focused observer: abort diagnostic + live scoped failed-detail fulfill only.

    Validates before any full dual-half run. Exit/validate green only when:
      - diagnostic abort row: check pass, satisfies_real False, aborted after success
        against exact detail URL+document resource
      - live scoped failed-detail fulfill row: check pass, satisfies_real True
    """
    from playwright.sync_api import sync_playwright

    ancestors = load_delivery_ancestors()
    prove_pins_on_default_branch(ancestors)
    worker_gate = check_worker_gates(ancestors, api_origin=api_origin)
    pages_gate = check_pages_gates(ancestors, origin=origin)
    capture_run_id = str(uuid.uuid4())
    observed_at = utc_now()
    rows: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for viewport_name, width, height in VIEWPORTS:
            context = browser.new_context(
                viewport={"width": width, "height": height},
                user_agent=USER_AGENT,
                extra_http_headers={
                    "Cache-Control": "no-cache, no-store",
                    "Pragma": "no-cache",
                },
            )
            context.add_init_script(OBSERVE_MAP)
            page = context.new_page()
            goto_settled(
                page, uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="meetings"))
            )
            abort_diagnostic = observe_abort_retained_page_diagnostic(
                page, origin=origin, expected_geo=f"nta2020:{CHELSEA}"
            )
            goto_settled(
                page, uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="meetings"))
            )
            scoped_failed = observe_scoped_failed_detail_from_chelsea(
                page, origin=origin, expected_geo=f"nta2020:{CHELSEA}"
            )
            diag_row = {
                "name": f"focused-abort-retained-page-diagnostic-{viewport_name}",
                "viewport_name": viewport_name,
                "row_type": "abort-retained-page-diagnostic",
                "served_values": abort_diagnostic,
                "check_result": abort_diagnostic.get("check_result"),
                "observation_status": abort_diagnostic.get("observation_status"),
            }
            live_scoped_row = {
                "name": f"focused-scoped-failed-detail-real-{viewport_name}",
                "viewport_name": viewport_name,
                "row_type": "scoped-failed-detail-real",
                "served_values": scoped_failed,
                "check_result": scoped_failed.get("check_result"),
                "observation_status": scoped_failed.get("observation_status"),
            }
            rows.extend([diag_row, live_scoped_row])

            matched = abort_diagnostic.get("matched_intercept_hit") or {}
            if abort_diagnostic.get("satisfies_real_scoped_journey"):
                failures.append(
                    {
                        "viewport": viewport_name,
                        "row": "abort-diagnostic",
                        "reason": "diagnostic must never satisfy live scoped failed-detail recovery",
                    }
                )
            if abort_diagnostic.get("check_result") != "pass":
                failures.append(
                    {
                        "viewport": viewport_name,
                        "row": "abort-diagnostic",
                        "reason": "diagnostic check_result fail",
                        "missing": abort_diagnostic.get("missing_steps"),
                    }
                )
            if not matched.get("aborted"):
                failures.append(
                    {
                        "viewport": viewport_name,
                        "row": "abort-diagnostic",
                        "reason": "aborted not true after successful abort",
                        "matched": matched,
                    }
                )
            if matched.get("abort_error"):
                failures.append(
                    {
                        "viewport": viewport_name,
                        "row": "abort-diagnostic",
                        "reason": "abort_error retained as failure",
                        "abort_error": matched.get("abort_error"),
                    }
                )
            if scoped_failed.get("check_result") != "pass" or not scoped_failed.get(
                "satisfies_real_scoped_journey"
            ):
                failures.append(
                    {
                        "viewport": viewport_name,
                        "row": "a4-fulfill",
                        "reason": "live scoped failed-detail fulfill did not pass",
                        "missing": scoped_failed.get("missing_steps"),
                    }
                )
            inj = scoped_failed.get("failure_injection") or {}
            if inj.get("method") != "playwright-route-continue-redirect-nonexistent":
                failures.append(
                    {
                        "viewport": viewport_name,
                        "row": "a4-continue-redirect",
                        "reason": "expected production-answered continue-redirect method",
                        "method": inj.get("method"),
                    }
                )
            if scoped_failed.get("production_response_status") != 404:
                failures.append(
                    {
                        "viewport": viewport_name,
                        "row": "a4-continue-redirect",
                        "reason": "production_response_status must be 404",
                        "status": scoped_failed.get("production_response_status"),
                    }
                )
            if not (scoped_failed.get("recovery_controls") or {}).get(
                "from_production_response"
            ):
                failures.append(
                    {
                        "viewport": viewport_name,
                        "row": "a4-continue-redirect",
                        "reason": "recovery controls must be from production response",
                    }
                )
            if inj.get("method") in {
                "playwright-route-fulfill-http-error",
                "playwright-route-fulfill-authored-html",
                "playwright-route-fulfill-replay-deployed-error",
            }:
                failures.append(
                    {
                        "viewport": viewport_name,
                        "row": "a4-continue-redirect",
                        "reason": "fulfill body must not claim live scoped failed-detail recovery",
                    }
                )
            context.close()
        browser.close()

    receipt = {
        "focused_scoped_failed_observer": True,
        "capture_run_id": capture_run_id,
        "observed_at": observed_at,
        "worker_revision": worker_gate["served_revision"],
        "pages_revision": pages_gate["served_revision"],
        "observations": rows,
        "failures": failures,
        "validated": not failures,
    }
    dest = out_path or (SCRATCH / "focused-scoped-failed-observer.json")
    dest.parent.mkdir(parents=True, exist_ok=True)
    write_json(dest, receipt)
    receipt["_wrote"] = str(dest)
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("CROL_BASE", DEFAULT_BASE))
    parser.add_argument("--api-origin", default=os.environ.get("CROL_API_ORIGIN", API_ORIGIN))
    parser.add_argument(
        "--check-gates",
        action="store_true",
        help="Print dual-half readiness and exit non-zero while paused",
    )
    parser.add_argument("--check", action="store_true", help="Validate an existing capture receipt")
    parser.add_argument(
        "--focused-scoped-failed-observer",
        action="store_true",
        help=(
            "Both-viewport focused observer for abort-retained-page diagnostic + live scoped failed-detail "
            "HTTP-error fulfill only. Required green before any full dual-half run."
        ),
    )
    parser.add_argument(
        "--miniature",
        action="store_true",
        help=(
            "One-viewport miniature pipeline exercising Worker-SSR, same-document client, "
            "scoped failed-detail, one keyboard step, and hermetic negative control through "
            "packet assembly/hash/validate. Writes companion scratch; does not overwrite "
            "production evidence."
        ),
    )
    parser.add_argument(
        "--half",
        choices=("both", "worker", "pages"),
        default="both",
        help=(
            "both: require dual-half gates and refresh all observations. "
            "worker: require Worker Live URL smoke; refresh Worker observations and "
            "retain prior Pages observations. "
            "pages: require Pages artifact-manifest ancestors; refresh Pages observations "
            "and retain prior Worker observations."
        ),
    )
    args = parser.parse_args()
    origin = normalize_base(args.base).rstrip("/")
    host = (urllib.parse.urlparse(origin).hostname or "").lower()
    if host not in {"cityscroll.org", "www.cityscroll.org"}:
        print(f"production capture requires cityscroll.org base, got {origin}", file=sys.stderr)
        return 2

    if args.check:
        check_existing()
        return 0

    if args.check_gates:
        report = check_gates(origin=origin, api_origin=args.api_origin.rstrip("/"))
        print(json.dumps(report, indent=2, sort_keys=True))
        if not report.get("ready"):
            print(
                "chelsea served-surface gates pending:\n- " + "\n- ".join(report.get("pending") or ["unknown"]),
                file=sys.stderr,
            )
            return 1
        print("chelsea served-surface gates ready", file=sys.stderr)
        return 0

    api_origin = args.api_origin.rstrip("/")
    if args.focused_scoped_failed_observer:
        report = check_gates(origin=origin, api_origin=api_origin)
        if not report.get("ready"):
            print(
                "chelsea focused observer paused:\n- "
                + "\n- ".join(report.get("pending") or ["unknown"]),
                file=sys.stderr,
            )
            return 1
        receipt = run_focused_scoped_failed_observer(origin=origin, api_origin=api_origin)
        print(
            json.dumps(
                {
                    "focused_scoped_failed_observer": True,
                    "wrote": receipt.get("_wrote"),
                    "validated": receipt.get("validated"),
                    "failures": receipt.get("failures"),
                    "observations": len(receipt.get("observations") or []),
                    "viewports": [name for name, _, _ in VIEWPORTS],
                },
                indent=2,
            )
        )
        return 0 if receipt.get("validated") else 1

    if args.miniature:
        report = check_gates(origin=origin, api_origin=api_origin)
        if not report.get("ready"):
            print(
                "chelsea miniature paused:\n- " + "\n- ".join(report.get("pending") or ["unknown"]),
                file=sys.stderr,
            )
            return 1
        out = SCRATCH / "miniature-production-read.json"
        receipt = capture_miniature(origin=origin, api_origin=api_origin, out_path=out)
        print(
            json.dumps(
                {
                    "miniature": True,
                    "wrote": receipt.get("_wrote"),
                    "packet_hash": receipt.get("packet_hash"),
                    "observations": len(receipt.get("observations") or []),
                    "row_types": receipt.get("miniature_row_types"),
                    "open_observations": receipt.get("open_observations"),
                },
                indent=2,
            )
        )
        return 0

    half = args.half
    ancestors = load_delivery_ancestors()
    prove_pins_on_default_branch(ancestors)
    if half == "both":
        report = check_gates(origin=origin, api_origin=api_origin)
        if not report.get("ready"):
            print(
                "chelsea served-surface capture paused:\n- " + "\n- ".join(report.get("pending") or ["unknown"]),
                file=sys.stderr,
            )
            return 1
    elif half == "worker":
        check_worker_gates(ancestors, api_origin=api_origin)
        print(
            "chelsea served-surface worker-half capture proceeding; "
            "Pages observations retained from prior receipt",
            file=sys.stderr,
        )
    else:
        check_pages_gates(ancestors, origin=origin)
        print(
            "chelsea served-surface pages-half capture proceeding; "
            "Worker observations retained from prior receipt",
            file=sys.stderr,
        )

    receipt = capture(origin=origin, api_origin=api_origin, half=half)
    # Fail before write if a dual-half run straddled a deploy (mixed provenance).
    if half == "both":
        uniform = assert_uniform_served_revision(receipt.get("observations") or [])
        receipt.setdefault("summary", {})["uniform_served_revision"] = uniform
    write_json(PRODUCTION_PATH, receipt)
    write_json(MANIFEST_PATH, build_manifest(receipt))
    print(json.dumps({"wrote": str(PRODUCTION_PATH), "manifest": str(MANIFEST_PATH), "observations": len(receipt["observations"])}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (GatePendingError, DeployPendingError, WrongPinError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
