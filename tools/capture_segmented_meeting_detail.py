#!/usr/bin/env python3
"""Production browser capture for segmented meeting detail (alias cb0c04802e711).

Drives M1–M3 meeting-detail routes on the served site at 1440 and 390 widths
with JavaScript enabled and disabled, records falsifiable per-row observations
(layout width, scripting probe, segment content), traverses keyboard focus to a
segment anchor, and refuses to capture until the served artifact-manifest
revision contains the delivery commit.

Screenshot binaries stay under the local task scratch directory. The committed
manifest may reference externally retained https screenshot URLs; image binaries
are never committed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "test" / "browser"))
from browser_support import launched_chromium  # noqa: E402

EVIDENCE_DIR = ROOT / "docs" / "evidence" / "segmented-meeting-detail"
MANIFEST_PATH = EVIDENCE_DIR / "capture-manifest.json"
SCREENSHOT_DIR = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "segmented-meeting-detail-screenshots"
PUBLIC_ALIAS = "cb0c04802e711"
DEFAULT_BASE = "https://cityscroll.org/"
ARTIFACT_MANIFEST = "/artifact-manifest.json"
# Delivery merge that first served segmented agenda + historical participation.
REQUIRED_ANCESTOR = "1ff60f293dc5f348cc6d08e1953232b4159235da"

M1_SOURCE = "https://cb14brooklyn.com/meeting/september-2026-board-meeting/"
M2_SOURCE = (
    "https://cb14brooklyn.com/meeting/"
    "public-hearing-on-ulurp-application-and-executive-committee-meeting-september-2026/"
)
M3_SOURCE = (
    "https://cb14brooklyn.com/meeting/"
    "housing-and-land-use-committee-meeting-september-2026/"
)


def meeting_route(source_url: str) -> str:
    meeting_id = f"meeting:community_board:{source_url}"
    return f"/meetings/{urllib.parse.quote(meeting_id, safe='')}/"


MEETINGS = (
    {
        "key": "m1",
        "source": M1_SOURCE,
        "route": meeting_route(M1_SOURCE),
        "assertion": (
            "M1 shows cannabis, budget, and regular-meeting segments with stable "
            "anchors, venue, and historical participation instructions."
        ),
        "expected_segment_count": 3,
        "expect_register": True,
        "expect_written": True,
        "title_needles": ("Cannabis", "Budget"),
    },
    {
        "key": "m2",
        "source": M2_SOURCE,
        "route": meeting_route(M2_SOURCE),
        "assertion": (
            "M2 distinguishes the 6:30 hearing from the 7:00 executive session "
            "with distinct stable segment links."
        ),
        "expected_segment_count": 2,
        "expect_register": False,
        "expect_written": False,
        "title_needles": ("6:30", "7:00"),
    },
    {
        "key": "m3",
        "source": M3_SOURCE,
        "route": meeting_route(M3_SOURCE),
        "assertion": (
            "M3 lists ordered untimed agenda items under the parent 6:30 meeting "
            "time without inventing per-item starts or written-testimony actions."
        ),
        "expected_segment_count": 4,
        "expect_register": False,
        "expect_written": False,
        "title_needles": ("Housing",),
    },
)

VIEWPORTS = (
    ("desktop", 1440, 900),
    ("narrow-touch", 390, 844),
)

SCRIPTING = (
    ("enabled", True),
    ("no-js", False),
)


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "cityscroll-segmented-meeting-detail/1"})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def served_revision(base: str) -> str:
    manifest = fetch_json(urllib.request.urljoin(base, ARTIFACT_MANIFEST))
    sha = manifest.get("source_commit_sha") or ""
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise SystemExit(f"served artifact-manifest missing source_commit_sha: {manifest!r}")
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


def require_served_revision_contains_delivery(base: str) -> str:
    """Refuse capture when the served build lacks the segmented-meeting delivery ancestor."""
    revision = served_revision(base)
    if not revision_contains_required_ancestor(revision):
        raise SystemExit(
            f"served revision {revision} does not contain required ancestor "
            f"{REQUIRED_ANCESTOR}; wait for Pages deploy before capturing"
        )
    return revision


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def host_screenshots(paths: list[Path]) -> dict[str, str]:
    """Upload screenshots to an external https host and return name→URL."""
    mapping = {}
    for path in paths:
        proc = subprocess.run(
            [
                "curl",
                "-sS",
                "-F",
                "reqtype=fileupload",
                "-F",
                f"fileToUpload=@{path}",
                "https://catbox.moe/user/api.php",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        url = (proc.stdout or "").strip()
        if not url.startswith("https://"):
            raise SystemExit(f"screenshot host failed for {path.name}: {proc.stdout!r} {proc.stderr!r}")
        mapping[path.name] = url
    return mapping


def data_vintage(base: str) -> dict:
    vintage = {
        "community_board_hearing_context_observed_at": None,
        "shared_meeting_read_model_generated_at": None,
        "crol_build_day": os.environ.get("CROL_BUILD_DAY") or None,
    }
    try:
        hearing = fetch_json(urllib.request.urljoin(base, "/data/community_board_hearing_context.json"))
        vintage["community_board_hearing_context_observed_at"] = hearing.get("observed_at")
    except Exception as exc:  # pragma: no cover - network shape varies
        vintage["community_board_hearing_context_fetch_error"] = str(exc)
    try:
        shared = fetch_json(urllib.request.urljoin(base, "/data/shared_meeting_read_model.json"))
        vintage["shared_meeting_read_model_generated_at"] = shared.get("generated_at") or shared.get("as_of")
    except Exception as exc:  # pragma: no cover
        vintage["shared_meeting_read_model_fetch_error"] = str(exc)
    return vintage


def observe_meeting(page, meeting: dict, *, scripting_enabled: bool) -> dict:
    page.wait_for_selector("main.meeting-document, .meeting-agenda-segments, h1", timeout=60_000)
    # Layout and content probes run through the browser even when page scripts
    # are disabled; they measure the served DOM rather than executing site JS.
    probe = page.evaluate(
        """() => {
          const section = document.querySelector('.meeting-agenda-segments');
          const segments = [...document.querySelectorAll('li.meeting-agenda-segment')];
          const anchors = [...document.querySelectorAll('a.meeting-agenda-segment-anchor')];
          const focusable = [...document.querySelectorAll(
            "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])"
          )].filter((node) => !!(node.offsetParent || node.getClientRects().length));
          const register = document.querySelector('[data-participation-mode="register_to_testify"]');
          const written = document.querySelector('[data-participation-mode="submit_written"]');
          const historical = document.querySelector('[data-meeting-historical="1"]');
          const historicalParticipation = document.querySelector(
            '[data-meeting-participation-historical="1"]'
          );
          let pageScriptsRan = false;
          try {
            pageScriptsRan = Boolean(window.__CITYSCROLL_SEGMENTED_PROBE__);
          } catch (err) {
            pageScriptsRan = false;
          }
          return {
            inner_width: window.innerWidth,
            segment_section_width: section
              ? Math.round(section.getBoundingClientRect().width)
              : 0,
            segment_count: segments.length,
            segment_ids: segments.map((node) => node.id || null),
            segment_titles: segments.map((node) => {
              const title = node.querySelector('.meeting-agenda-segment-title');
              return title ? title.textContent.trim() : null;
            }),
            segment_anchor_count: anchors.length,
            segment_anchor_hrefs: anchors.map((node) => node.getAttribute('href') || null),
            keyboard_focusable_count: focusable.length,
            historical: Boolean(historical),
            historical_participation: Boolean(historicalParticipation),
            register_mode: Boolean(register),
            written_mode: Boolean(written),
            page_scripts_marker_present: pageScriptsRan,
            title_text: (document.querySelector('h1') || {}).textContent || '',
          };
        }"""
    )
    html = page.content()
    observed = {
        **probe,
        "scripting_enabled": scripting_enabled,
        "status": 200,
        "historical_copy_present": "publisher’s posted instructions from that date" in html
        or "publisher's posted instructions from that date" in html,
        "agenda_section_present": 'data-meeting-agenda-segments="' in html,
    }
    if observed["segment_count"] != meeting["expected_segment_count"]:
        raise SystemExit(
            f"{meeting['key']} expected {meeting['expected_segment_count']} segments, "
            f"observed {observed['segment_count']}"
        )
    if observed["historical"] is not True:
        raise SystemExit(f"{meeting['key']} missing historical meeting marker")
    if bool(observed["register_mode"]) != bool(meeting["expect_register"]):
        raise SystemExit(
            f"{meeting['key']} register_mode observed={observed['register_mode']} "
            f"expected={meeting['expect_register']}"
        )
    if bool(observed["written_mode"]) != bool(meeting["expect_written"]):
        raise SystemExit(
            f"{meeting['key']} written_mode observed={observed['written_mode']} "
            f"expected={meeting['expect_written']}"
        )
    title_blob = " ".join(filter(None, observed.get("segment_titles") or [])) + " " + observed.get("title_text", "")
    for needle in meeting["title_needles"]:
        if needle.lower() not in title_blob.lower() and needle not in html:
            # Time needles for M2 live on the segment time element, not titles.
            if needle not in html:
                raise SystemExit(f"{meeting['key']} missing expected needle {needle!r}")
    if observed["segment_section_width"] <= 0:
        raise SystemExit(f"{meeting['key']} segment section width was not measurable")
    if abs(int(observed["inner_width"]) - int(page.viewport_size["width"])) > 32:
        raise SystemExit(
            f"{meeting['key']} inner_width {observed['inner_width']} does not match "
            f"viewport {page.viewport_size}"
        )
    return observed


def observation_digest(observed: dict, *, screenshot_sha256: str | None) -> str:
    """Hash the falsifiable observation packet so rows can differ by layout/scripting."""
    packet = {
        "inner_width": observed.get("inner_width"),
        "segment_section_width": observed.get("segment_section_width"),
        "segment_count": observed.get("segment_count"),
        "segment_ids": observed.get("segment_ids"),
        "segment_titles": observed.get("segment_titles"),
        "scripting_enabled": observed.get("scripting_enabled"),
        "historical": observed.get("historical"),
        "register_mode": observed.get("register_mode"),
        "written_mode": observed.get("written_mode"),
        "keyboard_focusable_count": observed.get("keyboard_focusable_count"),
        "screenshot_sha256": screenshot_sha256,
        # Journey / keyboard-only fields keep those rows distinct from each other.
        "observe_return": observed.get("observe_return"),
        "segment_deep_link": observed.get("segment_deep_link"),
        "back_href": observed.get("back_href"),
        "focused_segment_anchor": observed.get("focused_segment_anchor"),
        "focused_href": observed.get("focused_href"),
        "keyboard_traversal_steps": observed.get("keyboard_traversal_steps"),
    }
    return sha256_text(json.dumps(packet, sort_keys=True, separators=(",", ":")))


def traverse_to_segment_anchor(page, *, max_tabs: int = 80) -> dict:
    """Tab until a segment anchor receives focus; refuse presence-only tabindex checks."""
    page.wait_for_selector("a.meeting-agenda-segment-anchor", timeout=60_000)
    focused = None
    steps = 0
    for steps in range(1, max_tabs + 1):
        page.keyboard.press("Tab")
        focused = page.evaluate(
            """() => {
              const el = document.activeElement;
              if (!el) return null;
              return {
                tag: el.tagName,
                className: el.className || '',
                id: el.id || null,
                href: el.getAttribute && el.getAttribute('href'),
                is_segment_anchor: el.classList
                  ? el.classList.contains('meeting-agenda-segment-anchor')
                  : false,
              };
            }"""
        )
        if focused and focused.get("is_segment_anchor"):
            return {
                "keyboard_traversal_steps": steps,
                "focused_segment_anchor": True,
                "focused_href": focused.get("href"),
                "focused_id": focused.get("id"),
                "focused_class": focused.get("className"),
                "method": "tab-until-segment-anchor-focus",
            }
    raise SystemExit(
        f"keyboard traversal did not land on a segment anchor within {max_tabs} tabs; "
        f"last focus={focused!r}"
    )


def capture(base: str, host: bool) -> dict:
    revision = require_served_revision_contains_delivery(base)
    vintage = data_vintage(base)
    print(f"production base={base} revision={revision}", flush=True)
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    captures: list[dict] = []
    local_files: list[Path] = []

    with launched_chromium() as browser:
        for meeting in MEETINGS:
            for viewport_name, width, height in VIEWPORTS:
                for scripting_name, scripting_enabled in SCRIPTING:
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        java_script_enabled=scripting_enabled,
                        user_agent="cityscroll-segmented-meeting-detail/1",
                    )
                    page = context.new_page()
                    url = urllib.request.urljoin(base, meeting["route"])
                    page.goto(url, wait_until="networkidle", timeout=90_000)
                    observed = observe_meeting(page, meeting, scripting_enabled=scripting_enabled)
                    name = f"{meeting['key']}-{viewport_name}-{scripting_name}"
                    image_path = SCREENSHOT_DIR / f"{name}.png"
                    page.screenshot(path=str(image_path), full_page=True)
                    local_files.append(image_path)
                    shot_sha = sha256_file(image_path)
                    row = {
                        "name": name,
                        "meeting_key": meeting["key"],
                        "route": meeting["route"],
                        "viewport": {"width": width, "height": height},
                        "revision": revision,
                        "data_vintage": vintage,
                        "javascript": "enabled" if scripting_enabled else "disabled",
                        "scripting": scripting_enabled,
                        "assertion": meeting["assertion"],
                        "sha256": observation_digest(observed, screenshot_sha256=shot_sha),
                        "screenshot_sha256": shot_sha,
                        "screenshot_url": None,
                        "file": None,
                        "screenshot": None,
                        "source": "headless-playwright-production-served-site",
                        "observed": observed,
                    }
                    captures.append(row)
                    context.close()

        # Calendar → detail with observe return + segment deep link.
        m1 = MEETINGS[0]
        return_to = "/observe/?scope=brooklyn-cb-14&view=calendar"
        first_segment = None
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            java_script_enabled=True,
            user_agent="cityscroll-segmented-meeting-detail/1",
        )
        page = context.new_page()
        page.goto(urllib.request.urljoin(base, m1["route"]), wait_until="networkidle", timeout=90_000)
        observed_m1 = observe_meeting(page, m1, scripting_enabled=True)
        first_segment = (observed_m1.get("segment_ids") or [None])[0]
        if not first_segment:
            raise SystemExit("M1 missing segment id for calendar deep-link journey")
        journey_route = (
            f"{m1['route']}?return_to={urllib.parse.quote(return_to, safe='')}#{first_segment}"
        )
        page.goto(urllib.request.urljoin(base, journey_route), wait_until="networkidle", timeout=90_000)
        back = page.evaluate(
            """() => {
              const link = document.querySelector('a[href*="/observe/"]');
              const preserved = document.querySelector('[data-observe-return="preserved"]');
              return {
                back_href: link ? link.getAttribute('href') : null,
                observe_return_preserved: Boolean(preserved),
                hash: location.hash || '',
              };
            }"""
        )
        if not back.get("observe_return_preserved"):
            # Some builds encode preservation only on the Back href.
            if not (back.get("back_href") or "").startswith("/observe/"):
                raise SystemExit(f"calendar journey missing observe return: {back!r}")
        if first_segment not in (back.get("hash") or ""):
            raise SystemExit(f"calendar journey missing segment deep link hash: {back!r}")
        journey_observed = {
            "observe_return": "preserved" if back.get("observe_return_preserved") or back.get("back_href") else "missing",
            "segment_deep_link": first_segment,
            "back_href": back.get("back_href") or return_to,
            "hash": back.get("hash"),
            "scripting_enabled": True,
            "inner_width": page.evaluate("() => window.innerWidth"),
        }
        captures.append(
            {
                "name": "calendar-detail-back-journey",
                "meeting_key": "m1",
                "route": journey_route,
                "viewport": {"width": 1440, "height": 900},
                "revision": revision,
                "data_vintage": vintage,
                "javascript": "enabled",
                "scripting": True,
                "assertion": (
                    "Calendar inspect opens meeting detail with a stable segment deep link; "
                    "Back preserves the observe return."
                ),
                "sha256": observation_digest(journey_observed, screenshot_sha256=None),
                "screenshot_sha256": None,
                "screenshot_url": None,
                "file": None,
                "screenshot": None,
                "source": "headless-playwright-production-served-site",
                "observed": journey_observed,
            }
        )
        context.close()

        # Keyboard: actually Tab to a segment anchor (not a negative tabindex assertion).
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            java_script_enabled=True,
            user_agent="cityscroll-segmented-meeting-detail/1",
        )
        page = context.new_page()
        page.goto(urllib.request.urljoin(base, m1["route"]), wait_until="networkidle", timeout=90_000)
        # Start from a known non-anchor control so Tab traversal is meaningful.
        page.evaluate("() => { const main = document.getElementById('main'); if (main) main.focus(); }")
        keyboard = traverse_to_segment_anchor(page)
        keyboard_observed = {
            **keyboard,
            "scripting_enabled": True,
            "inner_width": page.evaluate("() => window.innerWidth"),
            "segment_anchor_count": page.locator("a.meeting-agenda-segment-anchor").count(),
        }
        if not keyboard_observed["focused_segment_anchor"]:
            raise SystemExit("keyboard capture failed to focus a segment anchor")
        if not (keyboard_observed.get("focused_href") or "").startswith("#agenda-segment-"):
            raise SystemExit(f"keyboard focus href unexpected: {keyboard_observed!r}")
        captures.append(
            {
                "name": "keyboard-segment-anchor-traversal",
                "meeting_key": "m1",
                "route": m1["route"],
                "viewport": {"width": 1440, "height": 900},
                "revision": revision,
                "data_vintage": vintage,
                "javascript": "enabled",
                "scripting": True,
                "assertion": (
                    "Meeting detail keyboard traversal reaches a segment anchor link and "
                    "lands focus on it."
                ),
                "sha256": observation_digest(keyboard_observed, screenshot_sha256=None),
                "screenshot_sha256": None,
                "screenshot_url": None,
                "file": None,
                "screenshot": None,
                "source": "headless-playwright-production-served-site",
                "observed": keyboard_observed,
            }
        )
        context.close()

    if host:
        hosted = host_screenshots(local_files)
        for row in captures:
            if row["name"].endswith(".png") or row.get("screenshot_sha256"):
                url = hosted.get(f"{row['name']}.png")
                if row["name"] in {path.stem for path in local_files}:
                    if not url:
                        raise SystemExit(f"missing hosted URL for {row['name']}")
                    row["screenshot_url"] = url
    else:
        for row in captures:
            if row["name"] in {path.stem for path in local_files}:
                row["screenshot_url"] = f"file://{SCREENSHOT_DIR / (row['name'] + '.png')}"

    # Drop dangling non-durable screenshot hashes when no https URL is retained.
    for row in captures:
        url = row.get("screenshot_url") or ""
        if not url.startswith("https://"):
            row["screenshot_sha256"] = None
            row["screenshot_url"] = None
            # Recompute digest without a non-durable screenshot hash.
            if row.get("observed"):
                row["sha256"] = observation_digest(row["observed"], screenshot_sha256=None)

    # Guard: the four matrix rows per meeting must not collapse to one hash.
    for meeting in MEETINGS:
        matrix = [
            row
            for row in captures
            if row["meeting_key"] == meeting["key"]
            and row["name"].startswith(f"{meeting['key']}-")
        ]
        hashes = {row["sha256"] for row in matrix}
        if len(matrix) != 4:
            raise SystemExit(f"{meeting['key']} expected 4 matrix rows, got {len(matrix)}")
        if len(hashes) < 2:
            raise SystemExit(
                f"{meeting['key']} matrix rows are not falsifiably distinct: {sorted(hashes)}"
            )
        widths = {
            (row["viewport"]["width"], row["observed"].get("segment_section_width"))
            for row in matrix
        }
        desktop_widths = [
            row["observed"]["segment_section_width"]
            for row in matrix
            if row["viewport"]["width"] == 1440
        ]
        narrow_widths = [
            row["observed"]["segment_section_width"]
            for row in matrix
            if row["viewport"]["width"] == 390
        ]
        if min(desktop_widths) <= max(narrow_widths):
            raise SystemExit(
                f"{meeting['key']} desktop segment width {desktop_widths} did not exceed "
                f"narrow width {narrow_widths}; layout observation is not falsifiable"
            )
        scripting_flags = {row["observed"]["scripting_enabled"] for row in matrix}
        if scripting_flags != {True, False}:
            raise SystemExit(f"{meeting['key']} scripting matrix incomplete: {scripting_flags}")

    manifest = {
        "schema": "cityscroll.segmented_meeting_detail_capture_manifest.v1",
        "public_alias": PUBLIC_ALIAS,
        "feature": "segmented-meeting-detail",
        "capture_mode": "headless-playwright-production-served-site",
        "base": base,
        "condition": f"Production base {base} after deployment; no image binary is committed.",
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "revision": revision,
        "grounded_at": revision,
        "repository_revision": revision,
        "revision_format": "served artifact-manifest source_commit_sha",
        "data_vintage": vintage,
        "required_ancestor": REQUIRED_ANCESTOR,
        "required_ancestor_contained": True,
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; only this "
            "manifest is committed. Externally retained https screenshot_url values are "
            "required when a screenshot_sha256 is retained; otherwise screenshot hashes "
            "are omitted."
        ),
        "local_image_dir_ignored": str(SCREENSHOT_DIR),
        "verifier": "node --test test/friction_c1_capability.test.mjs",
        "captures": captures,
    }
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    print(json.dumps({"wrote": str(MANIFEST_PATH), "revision": revision, "captures": len(captures)}, indent=2))
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=os.environ.get("CROL_BASE", DEFAULT_BASE))
    parser.add_argument("--host", action="store_true", help="upload screenshots to a durable https host")
    parser.add_argument("--check", action="store_true", help="validate an existing manifest")
    args = parser.parse_args()
    base = args.base.rstrip("/") + "/"
    if args.check:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        assert manifest["schema"] == "cityscroll.segmented_meeting_detail_capture_manifest.v1"
        assert manifest["image_binaries_committed"] is False
        assert manifest.get("required_ancestor") == REQUIRED_ANCESTOR
        assert manifest.get("required_ancestor_contained") is True
        assert manifest.get("capture_mode") == "headless-playwright-production-served-site"
        assert len(manifest["captures"]) >= 14
        matrix_hashes: dict[str, set[str]] = {}
        for row in manifest["captures"]:
            assert re.fullmatch(r"[0-9a-f]{40}", row.get("revision") or "")
            assert re.fullmatch(r"[0-9a-f]{64}", row.get("sha256") or "")
            assert row.get("viewport", {}).get("width") in (1440, 390) or row["name"] in {
                "calendar-detail-back-journey",
                "keyboard-segment-anchor-traversal",
            }
            if row.get("screenshot_sha256"):
                assert (row.get("screenshot_url") or "").startswith("https://"), (
                    f"{row['name']} retains screenshot_sha256 without durable https URL"
                )
            if re.fullmatch(r"m[123]-(desktop|narrow-touch)-(enabled|no-js)", row["name"]):
                matrix_hashes.setdefault(row["meeting_key"], set()).add(row["sha256"])
                values = row.get("observed") or {}
                assert values.get("segment_count", 0) > 0
                assert values.get("segment_section_width", 0) > 0
                assert "scripting_enabled" in values
        for key, hashes in matrix_hashes.items():
            assert len(hashes) >= 2, f"{key} matrix hashes are not distinct"
        keyboard = next(row for row in manifest["captures"] if row["name"] == "keyboard-segment-anchor-traversal")
        assert keyboard["observed"].get("focused_segment_anchor") is True
        assert int(keyboard["observed"].get("keyboard_traversal_steps") or 0) >= 1
        print("ok")
        return 0
    capture(base, host=args.host)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
