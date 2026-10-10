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

Do not invent capture-manifest values. ``--check-gates`` prints readiness and
exits non-zero while either half is paused. Screenshot binaries stay under
$FM_TASK_SCRATCH; only textual receipts are committed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
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


def read_applied_viewport(page) -> dict[str, int]:
    measured = page.evaluate(
        """() => ({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
        })"""
    )
    vp = page.viewport_size or {}
    return {
        "width": int(measured.get("innerWidth") or vp.get("width") or 0),
        "height": int(measured.get("innerHeight") or vp.get("height") or 0),
        "configured_width": int(vp.get("width") or 0),
        "configured_height": int(vp.get("height") or 0),
    }


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


def observe_overview_lens_scope_links(page, *, expected_geo: str = f"nta2020:{CHELSEA}") -> dict[str, Any]:
    """Record overview 'Open meetings' / 'Open Zoning' hrefs and click outcomes.

    A known served regression drops geo+surface from these overview links and
    widens to citywide. This observation records exact hrefs and the resulting
    h1 after navigation. Status is derived from the live read; when the links
    drop place scope the observation stays FAILING and the affected continuity checks
    remain open until a later deploy that retains geo is re-observed.
    """
    page.wait_for_selector(
        '[data-near-overview="true"], .near-overview, h1',
        timeout=90_000,
    )
    start_url = page.url
    start_heading = (
        normalize_ws(page.locator("h1").first.inner_text()) if page.locator("h1").count() else ""
    )
    link_rows = page.evaluate(
        """() => {
          const root = document.querySelector('[data-near-overview="true"], .near-overview')
            || document.body;
          const wanted = [
            { label: 'Open meetings', match: /^Open meetings$/i },
            { label: 'Open Zoning', match: /^Open Zoning$/i },
          ];
          return wanted.map(({ label, match }) => {
            const anchors = Array.from(root.querySelectorAll('a[href]')).filter((a) => {
              const text = (a.textContent || '').replace(/\\s+/g, ' ').trim();
              const href = a.getAttribute('href') || '';
              return match.test(text) && /near-you/i.test(href);
            });
            const hit = anchors[0] || null;
            if (!hit) {
              return { label, found: false, href: null, abs_href: null };
            }
            return {
              label,
              found: true,
              href: hit.getAttribute('href') || null,
              abs_href: hit.href || null,
              text: (hit.textContent || '').replace(/\\s+/g, ' ').trim(),
            };
          });
        }"""
    )

    def href_retains_place(href: str | None) -> bool:
        if not isinstance(href, str) or not href:
            return False
        parsed = urllib.parse.urlparse(urllib.parse.urljoin(ORIGIN + "/", href))
        params = urllib.parse.parse_qs(parsed.query)
        geo_values = params.get("geo") or []
        surface_values = params.get("surface") or []
        geo_ok = any(
            expected_geo in value or CHELSEA in value for value in geo_values
        )
        surface_ok = any(value == "records" for value in surface_values) if surface_values else False
        # Surface may be implied by the current surface; geo retention is the gate.
        return geo_ok

    clicks: list[dict[str, Any]] = []
    for row in link_rows or []:
        label = str((row or {}).get("label") or "")
        href = (row or {}).get("href")
        abs_href = (row or {}).get("abs_href") or href
        found = bool((row or {}).get("found"))
        retains = href_retains_place(href) or href_retains_place(abs_href)
        click_result: dict[str, Any] = {
            "label": label,
            "found": found,
            "href": href,
            "abs_href": abs_href,
            "href_retains_geo": retains,
            "clicked": False,
            "result_url": None,
            "result_geo": None,
            "result_h1": None,
            "result_retains_chelsea_label": None,
            "widened_to_citywide": None,
        }
        if found and abs_href:
            # Navigate from a fresh overview load so each click starts at Chelsea.
            page.goto(start_url, wait_until="networkidle", timeout=120_000)
            page.wait_for_selector("h1", timeout=60_000)
            locator = page.locator(
                f'a[href]:text-is("{label}")'
            )
            # Prefer an overview-scoped near-you link when several share the label.
            candidates = page.locator("a[href]")
            target = None
            count = candidates.count()
            for index in range(count):
                node = candidates.nth(index)
                text = normalize_ws(node.inner_text())
                node_href = node.get_attribute("href") or ""
                if text == label and "near-you" in node_href and "community-boards" not in node_href:
                    target = node
                    break
            if target is None and locator.count():
                target = locator.first
            if target is not None:
                with page.expect_navigation(wait_until="networkidle", timeout=90_000):
                    target.click()
                click_result["clicked"] = True
                click_result["result_url"] = page.url
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
        # Derive per-link status from the observed href + click outcome.
        link_ok = bool(
            found
            and retains
            and click_result.get("clicked")
            and click_result.get("result_geo") == expected_geo
            and click_result.get("result_retains_chelsea_label")
        )
        click_result["check_result"] = "pass" if link_ok else "fail"
        clicks.append(click_result)

    failing_labels = [row["label"] for row in clicks if row.get("check_result") == "fail"]
    overall_pass = bool(clicks) and not failing_labels and all(row.get("found") for row in clicks)
    return {
        "start_url": start_url,
        "start_heading": start_heading,
        "expected_geo": expected_geo,
        "links": clicks,
        "failing_labels": failing_labels,
        "check_result": "pass" if overall_pass else "fail",
        "observation_status": "closed" if overall_pass else "open",
        "regression_note": (
            "Overview Open meetings / Open Zoning links must retain the selected "
            "neighborhood geo (and surface) so the resident stays on Chelsea. "
            "A failing observation keeps the related continuity observations open until "
            "a later deploy that retains place scope is re-observed."
        ),
    }


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
    source_dates = None
    if isinstance(meetings_coverage, dict):
        source_dates = meetings_coverage.get("source_dates") or (
            ((meetings_coverage.get("types") or {}).get("nta2020") or {}).get("source_dates")
        )
    # Prefer existing proof receipts over inventing emptiness.
    agenda_receipt_path = ROOT / "warehouse/receipts/proof/community_board_agenda_m3_data_only_admission.json"
    agenda_receipt = None
    if agenda_receipt_path.is_file():
        try:
            agenda_receipt = {
                "path": "warehouse/receipts/proof/community_board_agenda_m3_data_only_admission.json",
                "sha256": sha256_text(agenda_receipt_path.read_bytes()),
            }
            payload = load_json(agenda_receipt_path)
            for key in ("generated_at", "built_at", "observed_at", "admitted", "status"):
                if key in payload:
                    agenda_receipt[key] = payload[key]
        except Exception as error:
            agenda_receipt = {"path": str(agenda_receipt_path.relative_to(ROOT)), "error": str(error)}

    old_only = sorted(canonical_set - served_set)
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
        "meetings_coverage_status": (
            meetings_coverage.get("status") if isinstance(meetings_coverage, dict) else None
        ),
        "meetings_source_dates": source_dates,
        "agenda_admission_receipt": agenda_receipt,
        "diagnosis": (
            "Served broader M04 preview is a population slice of committed district_activity "
            "meetings; canonical-only ids are diagnosed against activity built_at / meetings "
            "coverage source_dates and community-board agenda admission receipts rather than "
            "treated as proof of an empty future calendar."
            if old_only
            else "Served M04 broader ids are within the committed district_activity population."
        ),
        "origin_checked": origin.rstrip("/"),
    }


def capture(*, origin: str = ORIGIN, api_origin: str = API_ORIGIN) -> dict[str, Any]:
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
    SCRATCH.mkdir(parents=True, exist_ok=True)

    captures: list[dict[str, Any]] = []
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

        # --- 1b. Overview Open meetings / Open Zoning place-scope regression ---
        # Recorded as a FAILING observation when hrefs drop geo (current deploy).
        # Do not edit site/near_you_view.mjs here; leave observations open until a
        # later deploy that retains place scope is named for re-observation.
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            user_agent=USER_AGENT,
            extra_http_headers={"Cache-Control": "no-cache, no-store", "Pragma": "no-cache"},
        )
        page = context.new_page()
        overview_link_route = NO_LENS_ROUTE
        response = page.goto(
            uncached(origin, overview_link_route),
            wait_until="networkidle",
            timeout=120_000,
        )
        if not response or response.status != 200:
            raise RuntimeError(
                f"overview link probe HTTP {response.status if response else None}"
            )
        overview_link_obs = observe_overview_lens_scope_links(
            page, expected_geo=f"nta2020:{CHELSEA}"
        )
        overview_link_viewport = read_applied_viewport(page)
        overview_link_html = page.content()
        overview_link_assertion = (
            "Overview Open meetings / Open Zoning place-scope continuity "
            f"check_result={overview_link_obs['check_result']} "
            f"observation_status={overview_link_obs['observation_status']} "
            f"failing_labels={overview_link_obs['failing_labels']!r} "
            f"hrefs={[row.get('href') for row in overview_link_obs.get('links') or []]!r} "
            f"result_h1s={[row.get('result_h1') for row in overview_link_obs.get('links') or []]!r}"
        )
        captures.append(
            observation_base(
                name="overview-open-lens-links-place-scope",
                route=overview_link_route,
                viewport_name="desktop",
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

        # --- 2. Per-lens coverage for Chelsea + Hell's Kitchen (Worker) ---
        lens_pairs = (
            (CHELSEA, "meetings"),
            (CHELSEA, "land"),
            (HELLS_KITCHEN, "meetings"),
            (HELLS_KITCHEN, "land"),
        )
        lens_observations: dict[str, dict[str, Any]] = {}
        for geo, lens in lens_pairs:
            context = browser.new_context(
                viewport={"width": 1440, "height": 900},
                user_agent=USER_AGENT,
            )
            page = context.new_page()
            route = LENS_ROUTE.format(geo=geo, lens=lens)
            response = page.goto(uncached(origin, route), wait_until="networkidle", timeout=120_000)
            if not response or response.status != 200:
                raise RuntimeError(f"{route} HTTP {response.status if response else None}")
            viewport = read_applied_viewport(page)
            observed = observe_lens_page(page, geo=geo, lens=lens)
            key = f"{geo}:{lens}"
            lens_observations[key] = observed
            assertion = (
                f"{geo} lens={lens} coverage={observed['recovery']['coverage']} "
                f"copy={observed['recovery'].get('resident_copy')!r} "
                f"exact={len(observed['record_ids']['exact_ids'])} "
                f"broader={len(observed['record_ids']['broader_ids'])}"
            )
            captures.append(
                observation_base(
                    name=f"lens-{geo}-{lens}-desktop",
                    route=route,
                    viewport_name="desktop",
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
            if geo == CHELSEA and lens == "land":
                identity_compare = compare_identity(
                    observed["record_ids"]["exact_ids"],
                    canonical_land,
                )
            context.close()

        chelsea_meetings = lens_observations.get(f"{CHELSEA}:meetings") or {}
        hells_meetings = lens_observations.get(f"{HELLS_KITCHEN}:meetings") or {}
        chelsea_exact = set((chelsea_meetings.get("record_ids") or {}).get("exact_ids") or [])
        hells_exact = set((hells_meetings.get("record_ids") or {}).get("exact_ids") or [])
        cross_membership = sorted(chelsea_exact & hells_exact)
        unsupported_copy = (chelsea_meetings.get("recovery") or {}).get("resident_copy")
        zero_copy = None
        for key, obs in lens_observations.items():
            rec = obs.get("recovery") or {}
            if rec.get("coverage") == "verified-empty" and rec.get("resident_copy"):
                zero_copy = rec["resident_copy"]
                break

        # --- 3. Negative controls (Worker) ---
        # Explicit meetings lens stays meetings (not overview).
        meetings_ctrl = chelsea_meetings
        neg_meetings = {
            "stayed_meetings_view": bool(meetings_ctrl.get("stayed_on_lens")),
            "is_overview": bool(meetings_ctrl.get("is_overview")),
            "lens": (meetings_ctrl.get("lens_attr") or {}).get("lens"),
            "recovery": meetings_ctrl.get("recovery"),
        }
        captures.append(
            observation_base(
                name="negative-explicit-meetings-lens",
                route=LENS_ROUTE.format(geo=CHELSEA, lens="meetings"),
                viewport_name="desktop",
                viewport={"width": 1440, "height": 900, "configured_width": 1440, "configured_height": 900},
                served_half="worker",
                served_revision=worker_gate["served_revision"],
                ancestry=worker_ancestry,
                worker_meta=worker_meta,
                data_vintage=data_vintage,
                assertion=(
                    "Explicit lens=meetings stays meetings view "
                    f"(overview={neg_meetings['is_overview']}, lens={neg_meetings['lens']!r})"
                ),
                served_values=neg_meetings,
                content_sha256=meetings_ctrl.get("page_html_sha256") or sha256_text(json.dumps(neg_meetings)),
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
        }
        captures.append(
            observation_base(
                name="negative-switch-neighborhood-mn0402",
                route=LENS_ROUTE.format(geo=HELLS_KITCHEN, lens="meetings"),
                viewport_name="desktop",
                viewport={"width": 1440, "height": 900, "configured_width": 1440, "configured_height": 900},
                served_half="worker",
                served_revision=worker_gate["served_revision"],
                ancestry=worker_ancestry,
                worker_meta=worker_meta,
                data_vintage=data_vintage,
                assertion=(
                    "Hell's Kitchen meetings keep MN0402 scope; "
                    f"cross exact ids with Chelsea={cross_membership!r}"
                ),
                served_values=neg_switch,
                content_sha256=hk.get("page_html_sha256") or sha256_text(json.dumps(neg_switch)),
                capture_run_id=capture_run_id,
            )
        )

        # Failed lens load: abort deferred.json.
        context = browser.new_context(viewport={"width": 1440, "height": 900}, user_agent=USER_AGENT)
        page = context.new_page()
        page.route("**/near-you/deferred.json*", lambda route_obj: route_obj.abort())
        route = LENS_ROUTE.format(geo=CHELSEA, lens="land")
        page.goto(uncached(origin, route), wait_until="domcontentloaded", timeout=90_000)
        try:
            page.locator('[data-near-you-root][data-near-deferred-state="error"]').wait_for(timeout=45_000)
        except Exception:
            pass
        fail_html = page.content()
        fail_heading = normalize_ws(page.locator("h1").first.inner_text()) if page.locator("h1").count() else ""
        fail_geo = page.evaluate("() => new URL(window.location.href).searchParams.get('geo')")
        fail_values = {
            "heading": fail_heading,
            "geo": fail_geo,
            "deferred_error_marker": 'data-near-deferred-state="error"' in fail_html,
            "scope_retained": fail_geo == f"nta2020:{CHELSEA}",
            "selected_label_retained": any(n in fail_heading for n in CHELSEA_LABEL_NEEDLES),
        }
        captures.append(
            observation_base(
                name="negative-failed-deferred-load",
                route=route,
                viewport_name="desktop",
                viewport={"width": 1440, "height": 900, "configured_width": 1440, "configured_height": 900},
                served_half="worker",
                served_revision=worker_gate["served_revision"],
                ancestry=worker_ancestry,
                worker_meta=worker_meta,
                data_vintage=data_vintage,
                assertion=(
                    "Aborted deferred.json keeps Chelsea scope / shows failure recovery "
                    f"(error_marker={fail_values['deferred_error_marker']})"
                ),
                served_values=fail_values,
                content_sha256=sha256_text(fail_html),
                capture_run_id=capture_run_id,
            )
        )
        page.unroute("**/near-you/deferred.json*")
        context.close()

        # True-zero control: Flatbush BK1402 land is a published measured-empty bag.
        ZERO_GEO = "BK1402"
        ZERO_LENS = "land"
        context = browser.new_context(viewport={"width": 1440, "height": 900}, user_agent=USER_AGENT)
        page = context.new_page()
        zero_route = LENS_ROUTE.format(geo=ZERO_GEO, lens=ZERO_LENS)
        response = page.goto(uncached(origin, zero_route), wait_until="networkidle", timeout=120_000)
        if not response or response.status != 200:
            raise RuntimeError(f"{zero_route} HTTP {response.status if response else None}")
        zero_obs = observe_lens_page(page, geo=ZERO_GEO, lens=ZERO_LENS)
        context.close()
        if (zero_obs.get("recovery") or {}).get("coverage") == "verified-empty":
            zero_copy = (zero_obs.get("recovery") or {}).get("resident_copy") or zero_copy

        # Citywide stays separately scoped on meetings lens (present there, not exact membership).
        _meetings_status, _meetings_body, meetings_deferred = fetch_json_url(
            uncached(origin, DEFERRED_ROUTE.format(geo=CHELSEA, lens="meetings"))
        )
        meetings_deferred_html = (
            (meetings_deferred or {}).get("results_html")
            if isinstance(meetings_deferred, dict)
            else ""
        ) or ""
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
            before_geo = page.evaluate("() => new URL(window.location.href).searchParams.get('geo')")

            # Category/lens change retains geo.
            lens_url = uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="land"))
            page.goto(lens_url, wait_until="networkidle", timeout=120_000)
            after_lens_geo = page.evaluate("() => new URL(window.location.href).searchParams.get('geo')")
            after_lens = page.evaluate("() => new URL(window.location.href).searchParams.get('lens')")

            # Refresh retains geo.
            page.reload(wait_until="networkidle", timeout=120_000)
            after_refresh_geo = page.evaluate("() => new URL(window.location.href).searchParams.get('geo')")

            # Keyboard focusable controls.
            focusable = page.eval_on_selector_all(
                "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])",
                "nodes => nodes.filter(n => !!(n.offsetParent || n.getClientRects().length)).length",
            )
            try:
                page.keyboard.press("Tab")
                focused_tag = page.evaluate("() => document.activeElement && document.activeElement.tagName")
            except Exception:
                focused_tag = None

            # Record inspection / full-record Back when a land row exists.
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
            if exact_ids:
                record_id = exact_ids[0]
                try:
                    # Prefer inspect control when present; else full-record link.
                    inspect = page.locator(
                        f'section.near-results li.near-record[data-record-id="{record_id}"] button, '
                        f'section.near-results li.near-record[data-record-id="{record_id}"] [data-near-inspect]'
                    )
                    if inspect.count():
                        inspect.first.scroll_into_view_if_needed(timeout=10_000)
                        inspect.first.click(timeout=10_000)
                        page.wait_for_timeout(400)
                        inspection["opened"] = True
                        # Dismiss via Escape / close.
                        page.keyboard.press("Escape")
                        page.wait_for_timeout(300)
                        inspection["dismissed"] = True
                        # Intermediate dismissed state: inspect panel gone or inactive.
                        inspection["dismiss_intermediate"] = page.evaluate(
                            """() => {
                              const open = document.querySelector(
                                '[data-near-inspect-open="true"], dialog[open], .near-inspect[aria-hidden="false"]'
                              );
                              return { inspect_still_open: !!open };
                            }"""
                        )
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
                        # Prefer direct navigation from the observed href so a
                        # covered/overflowing title link still proves the route.
                        target = urllib.parse.urljoin(origin + "/", detail_href)
                        page.goto(target, wait_until="networkidle", timeout=120_000)
                        inspection["opened"] = True
                        inspection["detail_url"] = page.url
                        # Browse/zoning and meeting detail documents are Pages-served.
                        inspection["detail_served_half"] = "pages"
                        detail_html = page.content()
                        detail_hash = sha256_text(detail_html)
                        detail_heading = (
                            normalize_ws(page.locator("h1").first.inner_text())
                            if page.locator("h1").count()
                            else ""
                        )
                        # Failed-detail recovery: navigate to a nonsense detail.
                        bogus = urllib.request.urljoin(
                            origin, "/meetings/meeting%3Amissing-chelsea-control/"
                        )
                        bogus_response = page.goto(
                            bogus, wait_until="domcontentloaded", timeout=60_000
                        )
                        failed_detail = {
                            "url": page.url,
                            "http_status": (
                                bogus_response.status if bogus_response else None
                            ),
                            "status_heading": normalize_ws(
                                page.locator("h1").first.inner_text()
                                if page.locator("h1").count()
                                else page.content()[:200]
                            ),
                            "http_ok": bool(
                                bogus_response and 200 <= bogus_response.status < 400
                            ),
                        }
                        # Back to selected place.
                        page.goto(
                            uncached(origin, LENS_ROUTE.format(geo=CHELSEA, lens="land")),
                            wait_until="networkidle",
                            timeout=120_000,
                        )
                        back_geo = page.evaluate(
                            "() => new URL(window.location.href).searchParams.get('geo')"
                        )
                        back_heading = (
                            normalize_ws(page.locator("h1").first.inner_text())
                            if page.locator("h1").count()
                            else ""
                        )
                        inspection["back_retained_geo"] = back_geo
                        inspection["back_heading"] = back_heading
                        inspection["failed_detail"] = failed_detail
                        detail_ok = bool(
                            inspection.get("detail_url")
                            and back_geo == f"nta2020:{CHELSEA}"
                            and failed_detail.get("http_ok") is False
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
                                    f"Full-record detail open + failed-detail recovery + Back retains geo "
                                    f"({back_geo}); detail_h1={detail_heading!r}; "
                                    f"check_result={'pass' if detail_ok else 'fail'}"
                                ),
                                served_values={
                                    "inspection": inspection,
                                    "detail_heading": detail_heading,
                                    "detail_html_sha256": detail_hash,
                                    "check_result": "pass" if detail_ok else "fail",
                                    "observation_status": "closed" if detail_ok else "open",
                                },
                                content_sha256=detail_hash,
                                capture_run_id=capture_run_id,
                            )
                        )
                except Exception as error:
                    inspection["error"] = str(error)
                    inspection["check_result"] = "fail"
                    inspection["observation_status"] = "open"

            # No-JavaScript document fetch for the Near You shell (Worker-served).
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
                and int(focusable or 0) >= 1
                and no_js_values.get("chelsea_label_present")
                and no_js_values.get("all_nyc_absent")
            )
            continuity = {
                "before_geo": before_geo,
                "after_lens_geo": after_lens_geo,
                "after_lens": after_lens,
                "lens_change_retained_geo": after_lens_geo == before_geo,
                "after_refresh_geo": after_refresh_geo,
                "refresh_retained_geo": after_refresh_geo == f"nta2020:{CHELSEA}",
                "keyboard_focusable_count": int(focusable or 0),
                "keyboard_focused_tag": focused_tag,
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
                    viewport=read_applied_viewport(page),
                    served_half="worker",
                    served_revision=worker_gate["served_revision"],
                    ancestry=worker_ancestry,
                    worker_meta=worker_meta,
                    data_vintage=data_vintage,
                    assertion=(
                        f"Interaction continuity at {viewport_name}: lens/refresh retain geo; "
                        f"keyboard focusable={focusable}; no-js label="
                        f"{no_js_values['chelsea_label_present']}; "
                        f"check_result={continuity['check_result']}"
                    ),
                    served_values=continuity,
                    content_sha256=sha256_text(json.dumps(continuity, sort_keys=True)),
                    capture_run_id=capture_run_id,
                )
            )
            # Worker-half no-JS observation for the Near You document shell.
            captures.append(
                observation_base(
                    name=f"no-js-near-you-document-{viewport_name}",
                    route=NO_LENS_ROUTE,
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
                        "No-JS Near You document fetch retains Chelsea neighborhood label "
                        "and omits All NYC default detour"
                    ),
                    served_values=no_js_values,
                    content_sha256=no_js_values["html_sha256"],
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
        },
    }
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
            f"Production base {receipt['origin']} after Worker Live URL smoke and Pages "
            "revisions both contain overview + map-fix ancestors; no image binary committed."
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
        "captures": receipt["observations"],
        "captured_at": receipt["observed_at"],
    }


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def validate_receipt(receipt: dict[str, Any]) -> None:
    _require(receipt.get("schema") == PRODUCER_SCHEMA, f"schema must be {PRODUCER_SCHEMA}")
    _require(receipt.get("feature") == FEATURE, "feature mismatch")
    _require("public_alias" not in receipt, "receipt must not carry private roadmap aliases")
    _require(
        "related_delivery_alias" not in receipt,
        "receipt must not carry private related-delivery aliases",
    )
    _require("letter_status" not in json.dumps(receipt), "receipt must not use letter bookkeeping")
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

    identity = receipt.get("identity_compare") or {}
    _require(isinstance(identity.get("served_count"), int), "identity_compare.served_count")
    _require(isinstance(identity.get("canonical_count"), int), "identity_compare.canonical_count")
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

    # Full capture refuses until both halves are ready.
    report = check_gates(origin=origin, api_origin=args.api_origin.rstrip("/"))
    if not report.get("ready"):
        print(
            "chelsea served-surface capture paused:\n- " + "\n- ".join(report.get("pending") or ["unknown"]),
            file=sys.stderr,
        )
        return 1

    receipt = capture(origin=origin, api_origin=args.api_origin.rstrip("/"))
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
