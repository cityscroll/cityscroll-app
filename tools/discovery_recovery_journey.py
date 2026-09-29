"""The discovery-recovery scenario of the default-local-home capture tool.

Five journey families, each driven through real links in headless Chromium at
390x844 and 1440x900 with the real stylesheet:

- root -> a record collection -> one of its records;
- a typed Midwood address -> its local Records -> inspect -> dismiss -> the full
  meeting -> Back -> continue;
- an unsupported neighborhood (Sheepshead Bay) -> its All NYC escape -> a record;
- the citywide preview -> the whole citywide collection -> a full record;
- a suggested neighborhood -> its local Records list -> a full record.

Every step records what the page showed: DOM text, hrefs, the selected scope,
record IDs, rendered counts, focus and scroll before and after navigation, the
destination's own record identity, and the route read-model generation each
Worker response names. Assertions are never stored as bare verdicts: the
validator re-derives every assertion, outcome and pending state from those raw
observations and refuses a manifest whose stored values do not re-derive.

Two modes keep the network apart from offline proof:

- ``--local`` starts ``tools/serve_near_you_capture.mjs`` (the real Worker
  handler and the Pages edge handler) over the frozen district-activity blob with
  a pinned clock, and additionally drives the recovery cases through the local
  fault controls and in-browser geolocation fixtures. It retains a textual proof
  bound to a capture revision on the default branch and to the bytes of the
  inputs it measured.
- The served mode reads the deployed site. It pins the recorded landed commit,
  requires both the Pages artifact revision and the Worker health revision to
  contain it, requires one read-model generation throughout, and compares all of
  them again at the end. It injects no faults, and a missing positive record is
  recorded as a pending obligation, never as a pass.

Render proof is a content hash plus the ignored local image path; no image
binary is ever written into the repository.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, unquote, urljoin, urlsplit

ROOT = Path(__file__).resolve().parents[1]

SCENARIO = "discovery-recovery"
PUBLIC_ALIAS = "c94563a6bbaf3"
MANIFEST_SCHEMA = "cityscroll.recovered_discovery_journeys.v1"
DELIVERY_SCHEMA = "cityscroll.capture_delivery.v1"
EVIDENCE_DIR = ROOT / "docs" / "evidence" / "discovery-recovery-journey"
LOCAL_MANIFEST_PATH = EVIDENCE_DIR / "local-capture-manifest.json"
SERVED_MANIFEST_PATH = EVIDENCE_DIR / "capture-manifest.json"
DELIVERY_PATH = EVIDENCE_DIR / "delivery.json"
IMAGE_DIR = Path(".artifacts") / "discovery-recovery-journey"
LOCAL_MODE = "headless-playwright-local-fixture-server"
SERVED_MODE = "headless-playwright-production-served-site"
PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
WORKER_HEALTH_URL = "https://api.cityscroll.org/health"
READ_MODEL_VERSION_HEADER = "x-cityscroll-read-model-version"
USER_AGENT = "cityscroll-journey-capture/1"
DEFAULT_BRANCH_REF = "origin/main"
WORKER_PATHS = frozenset({"/", "/near-you", "/near-you/", "/near-you/deferred.json"})

VIEWPORTS = (("phone", 390, 844), ("desktop", 1440, 900))
FAMILIES = (
    "root-category-record",
    "typed-place-record",
    "unsupported-place-escape",
    "citywide-bucket-record",
    "suggested-place-record",
)
# Local only: faults come from the capture server's per-request controls and
# in-browser fixtures, never from production.
RECOVERY_CASES = (
    "location-denied",
    "location-timeout",
    "explicit-zero",
    "failed-section",
    "missing-coverage",
    "detail-failure",
)

# Frozen offline controls: the published district-activity snapshot these
# journeys were specified against, served by blob id with a pinned clock.
FROZEN_CLOCK = "2026-09-28T16:00:00.000Z"
FROZEN_ACTIVITY = {
    "path": "site/data/district_activity.json",
    "revision": "d886b385d647f4534df985f5922749a9414fab26",
    "blob": "5deaa202fe578e09b58380d43755419dbb85ec60",
}
FROZEN_GENERATION = f"capture-{FROZEN_ACTIVITY['blob'][:12]}"
SEPT23_ID = (
    "meeting:community_board:https://cb14brooklyn.com/meeting/"
    "housing-and-land-use-committee-meeting-september-2026/"
)
FROZEN_CONTROLS = {
    "midwood_record_ids": sorted([
        SEPT23_ID,
        "meeting:community_board:https://cb14brooklyn.com/meeting/"
        "public-hearing-on-ulurp-application-and-executive-committee-meeting-september-2026/",
    ]),
    "midwood_record": SEPT23_ID,
    "citywide_total": 20,
    "suggestions": [["MN0102", 26], ["MN0402", 12], ["MN0101", 9]],
}

MIDWOOD_ADDRESS = "810 East 16th Street"
MIDWOOD_GEO = "nta2020:BK1403"
UNSUPPORTED_GEO = "nta2020:BK1503"
ZERO_GEO = "nta2020:BX0101"
UNCOVERED_GEO = "nta2020:QN0103"
ASTORIA = {"latitude": 40.7644, "longitude": -73.9235}
PLACE_PARAMS = ("geo", "boro", "cd", "council", "neighborhood", "scope", "location_scope")
UNSUPPORTED_COPY = "We can’t filter these meetings to this neighborhood yet."
ZERO_COPY = "No mapped meetings match these filters."
UNAVAILABLE_COPY = "These meetings could not load."
DENIED = "Location permission was not granted. Choose an area from the list."
TIMED_OUT = "Location timed out. Try again or choose an area from the list."
CITYWIDE_FAULT = "citywide:meetings=reject"
FIXTURE_FAIL_HEADER = "x-near-you-fixture-fail"
SCROLL_TOLERANCE_PX = 4

# Declared inputs of the local proof: the harness and the owners of the rendered
# journeys. Their bytes are recorded and must be unchanged when the proof is
# checked; data identity is carried by the capture revision and the frozen blob.
MEASURED_INPUTS = (
    "tools/capture_default_local_home_journey.py",
    "tools/discovery_recovery_journey.py",
    "tools/serve_near_you_capture.mjs",
    "worker/src/near_you.mjs",
    "site/near_you_view.mjs",
    "site/app/map.mjs",
)
PAGES_DATA_PATHS = ("site/data",)
RECAPTURE_COMMAND = "python3 tools/capture_default_local_home_journey.py --scenario discovery-recovery --local"

PENDING_EXIT = 3


class JourneyEvidenceError(Exception):
    """A specific refusal (or pending state) of discovery-recovery evidence."""

    PENDING_CODES = frozenset({"absent-served-capture", "deploy-pending", "pending-obligation"})

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message

    @property
    def pending(self) -> bool:
        return self.code in self.PENDING_CODES


def refuse(code: str, message: str) -> None:
    raise JourneyEvidenceError(code, message)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


# --- Repository oracle -------------------------------------------------------


class GitOracle:
    """The repository facts the validator depends on; tests substitute a fake."""

    def __init__(self, cwd: Path = ROOT):
        self.cwd = cwd

    def _git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "-C", str(self.cwd), *args], capture_output=True, text=True, check=False)

    def resolve(self, ref: str) -> str | None:
        result = self._git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}")
        sha = result.stdout.strip()
        return sha if result.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", sha) else None

    def is_ancestor(self, ancestor: str, descendant: str) -> bool:
        if not re.fullmatch(r"[0-9a-f]{40}", str(ancestor or "")):
            return False
        return self._git("merge-base", "--is-ancestor", ancestor, descendant).returncode == 0

    def file_sha256(self, path: str) -> str | None:
        target = (self.cwd / path).resolve()
        try:
            target.relative_to(self.cwd.resolve())
            return sha256_bytes(target.read_bytes())
        except (OSError, ValueError):
            return None

    def merge_base(self, ref: str = DEFAULT_BRANCH_REF) -> str | None:
        result = self._git("merge-base", "HEAD", ref)
        sha = result.stdout.strip()
        return sha if result.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", sha) else None

    def tree_matches(self, revision: str, paths: tuple[str, ...]) -> bool:
        """True when the working tree equals ``revision`` for ``paths`` (tracked and untracked)."""
        diff = self._git("diff", "--quiet", revision, "--", *paths).returncode == 0
        untracked = self._git("ls-files", "--others", "--exclude-standard", "--", *paths).stdout.strip() == ""
        return diff and untracked


# --- Pure derivation ---------------------------------------------------------


def _norm(text) -> str:
    return " ".join(str(text or "").replace("◆", " ").split())


def _int(text) -> int | None:
    match = re.fullmatch(r"\s*(\d[\d,]*)\s*", str(text if text is not None else ""))
    return int(match.group(1).replace(",", "")) if match else None


def _query(url) -> dict[str, list[str]]:
    return parse_qs(urlsplit(str(url or "")).query)


def _path(url) -> str:
    return urlsplit(str(url or "")).path


def record_id_from_href(href) -> str | None:
    path = _path(href)
    if not path.startswith("/meetings/"):
        return None
    return unquote(path[len("/meetings/"):].rstrip("/")) or None


def count_from_label(text) -> int | None:
    """The count a link label names, read from its rendered text: 'Place (26 meetings)'."""
    match = re.search(r"\((\d[\d,]*) [^()]+\)\s*$", _norm(text))
    return int(match.group(1).replace(",", "")) if match else None


def expected_record(obs: dict) -> str | None:
    return obs.get("record_id") or record_id_from_href(obs.get("record_href"))


def _destination_ok(step: dict | None, expected_id) -> bool:
    """The destination is the record the link named, and any subject anchor it carried exists."""
    if not step or not expected_id:
        return False
    if step.get("record_id") != expected_id or step.get("status") != 200 or step.get("near_you_shell"):
        return False
    return not step.get("fragment") or step.get("anchor_present") is True


def _back_ok(departure: dict | None, returned: dict | None, record_id) -> bool:
    if not departure or not returned or not record_id:
        return False
    return (
        returned.get("url") == departure.get("url")
        and returned.get("focus_record_id") == record_id
        and "near-record-full-record" in str(returned.get("focus_class") or "")
        and abs(int(returned.get("scroll_y", -10_000)) - int(departure.get("scroll_y", 10_000))) <= SCROLL_TOLERANCE_PX
    )


def _inspect_ok(obs: dict) -> bool:
    inspect = obs.get("inspect") or {}
    title = _norm(obs.get("record_title"))
    return (
        inspect.get("control_tag") == "button"
        and inspect.get("dialog_open") is True
        and title != ""
        and title in _norm(inspect.get("dialog_text"))
        and inspect.get("focus_record_id") == obs.get("record_id")
        and "near-record-inspect" in str(inspect.get("focus_class") or "")
    )


def _no_place(url) -> bool:
    params = _query(url)
    return not any(name in params for name in PLACE_PARAMS)


def _collection_ok(collection: dict, href) -> bool:
    return (
        collection.get("status") == 200 and collection.get("marker") == "browse"
        and _path(collection.get("url")) == _path(href)
    )


def derive_assertions(row: dict, mode: str) -> dict[str, bool]:
    """Every assertion for one row, derived only from its recorded observations."""
    obs = row.get("observations") or {}
    page = row.get("page") or {}
    viewport = row.get("viewport") or {}
    measured = page.get("viewport") or {}
    out = {
        "viewport_applied": measured.get("width") == viewport.get("width") and measured.get("height") == viewport.get("height"),
        "real_stylesheet_applied": int(page.get("stylesheet_rules") or 0) > 0 and bool(page.get("stylesheets")),
        "no_horizontal_overflow": int(page.get("overflow_x", 1_000)) <= 1,
    }
    journey = row.get("journey")
    local = mode == LOCAL_MODE
    if journey == "root-category-record":
        family = obs.get("family_link") or {}
        returned = obs.get("returned") or {}
        out.update({
            "six_record_families_offered": len([link for link in obs.get("entry_links") or [] if link.get("family")]) == 6,
            "family_link_is_native": family.get("tag") == "a" and bool(family.get("href")),
            "collection_reached": _collection_ok(obs.get("collection") or {}, family.get("href")),
            "destination_is_listed_record": _destination_ok(obs.get("destination"), expected_record(obs)),
            "destination_heading_matches": _norm((obs.get("destination") or {}).get("heading")) == _norm(obs.get("record_title")) != "",
            "back_returns_to_collection": (
                returned.get("url") == (obs.get("collection") or {}).get("url") and returned.get("record_link_present") is True
            ),
        })
    elif journey == "typed-place-record":
        scope = obs.get("scope") or {}
        listed = obs.get("listed_ids") or []
        count = _int(scope.get("results_count"))
        out.update({
            "typed_place_selected": _query(scope.get("url")).get("geo") == [MIDWOOD_GEO] and scope.get("surface") == "records",
            "count_read_from_page_covers_list": count is not None and count >= len(listed) > 0,
            "record_is_listed": obs.get("record_id") in listed,
            "inspect_is_button_and_dismiss_returns_focus": _inspect_ok(obs),
            "full_record_is_link": (obs.get("full_link") or {}).get("tag") == "a",
            "destination_is_record": _destination_ok(obs.get("destination"), obs.get("record_id")),
            "back_restores_scope_focus_scroll": _back_ok(obs.get("departure"), obs.get("returned"), obs.get("record_id")),
            "continue_inspects_again": obs.get("continued") is True,
        })
        if local:
            out["frozen_midwood_records"] = (
                sorted(listed) == FROZEN_CONTROLS["midwood_record_ids"] and obs.get("record_id") == FROZEN_CONTROLS["midwood_record"]
            )
    elif journey == "unsupported-place-escape":
        escape = obs.get("escape") or {}
        out.update({
            "unsupported_copy_shown": _norm(obs.get("recovery_message")) == UNSUPPORTED_COPY,
            "unsupported_count_is_not_zero": obs.get("results_count") is None and "results_count" in obs,
            "escape_is_visible_native_link": escape.get("tag") == "a" and escape.get("visible") is True and not escape.get("in_closed_details"),
            "escape_clears_place": _no_place(escape.get("href")) and _path(escape.get("href")) == "/browse/meetings/",
            "escape_reaches_all_nyc_collection": (
                _collection_ok(obs.get("collection") or {}, escape.get("href")) and _no_place((obs.get("collection") or {}).get("url"))
            ),
            "destination_is_listed_record": _destination_ok(obs.get("destination"), expected_record(obs)),
        })
        if local:
            out["frozen_unsupported_place"] = _query((obs.get("scope") or {}).get("url")).get("geo") == [UNSUPPORTED_GEO]
    elif journey == "citywide-bucket-record":
        preview = obs.get("preview_ids") or []
        total = _int(obs.get("total_text"))
        bucket = obs.get("bucket") or {}
        listed = bucket.get("listed_ids") or []
        view_all = _query(obs.get("view_all_href"))
        out.update({
            "preview_bounded": 1 <= len(preview) <= 3 and len(set(preview)) == len(preview),
            "view_all_opens_citywide_records": (
                view_all.get("scope") == ["citywide"] and view_all.get("surface") == ["records"]
                and "geo" not in view_all and "neighborhood" not in view_all
            ),
            "rendered_total_matches_destination_count": total is not None and total == _int(bucket.get("results_count")),
            "preview_records_in_destination": bool(preview) and all(record in listed for record in preview),
            "record_is_listed": obs.get("record_id") in listed,
            "inspect_is_button_and_dismiss_returns_focus": _inspect_ok(obs),
            "destination_is_record": _destination_ok(obs.get("destination"), obs.get("record_id")),
            "back_restores_scope_focus_scroll": _back_ok(obs.get("departure"), obs.get("returned"), obs.get("record_id")),
        })
        if local:
            out["frozen_citywide_total"] = total == FROZEN_CONTROLS["citywide_total"]
    elif journey == "suggested-place-record":
        links = obs.get("links") or []
        destinations = obs.get("destinations") or []
        chosen = obs.get("chosen") or {}
        named = [count_from_label(link.get("text")) for link in links]
        chosen_place = next((place for place in destinations if place.get("id") == chosen.get("id")), {})
        out.update({
            "suggestions_bounded": 1 <= len(links) <= 3,
            "labels_name_their_counts": bool(links) and all(
                count is not None and count > 0 and str(count) == str(link.get("data_count"))
                for count, link in zip(named, links)
            ),
            "counts_descend": None not in named and named == sorted(named, reverse=True),
            "every_suggestion_opens_its_records": len(destinations) == len(links) > 0 and all(
                _query(place.get("url")).get("geo") == [f"nta2020:{link.get('id')}"] and place.get("surface") == "records"
                for link, place in zip(links, destinations)
            ),
            "every_named_count_matches_its_destination": len(destinations) == len(links) > 0 and all(
                count is not None and count == _int(place.get("results_count"))
                for count, place in zip(named, destinations)
            ),
            "record_is_listed": bool(chosen_place) and obs.get("record_id") in (chosen_place.get("listed_ids") or []),
            "inspect_is_button_and_dismiss_returns_focus": _inspect_ok(obs),
            "destination_is_record": _destination_ok(obs.get("destination"), obs.get("record_id")),
            "back_restores_scope_focus_scroll": _back_ok(obs.get("departure"), obs.get("returned"), obs.get("record_id")),
        })
        if local:
            out["frozen_suggestions"] = [[str(link.get("id")), count] for link, count in zip(links, named)] == FROZEN_CONTROLS["suggestions"]
    elif journey in ("location-denied", "location-timeout"):
        state = obs.get("state") or {}
        actions = [action.get("action") for action in state.get("actions") or []]
        denied = journey == "location-denied"
        out.update({
            "status_explains": _norm(state.get("status")).startswith(DENIED if denied else TIMED_OUT),
            "at_most_two_actions": 1 <= len(actions) <= 2,
            "scope_kept": bool(state.get("url")) and state.get("url") == obs.get("url_before"),
        })
        if denied:
            browse = obs.get("browse") or {}
            out.update({
                "offers_address_and_browse": actions == ["enter_address", "browse_all"],
                "enter_address_focuses_input": obs.get("focused_after_enter_address") == "near-geo-search-input",
                "browse_all_activated": _path(browse.get("url")) == "/browse/" and browse.get("marker") == "browse-landing",
            })
        else:
            after = _query((obs.get("after_retry") or {}).get("url"))
            out.update({
                "offers_retry_and_address": actions == ["retry", "enter_address"],
                "retry_activated_second_request": obs.get("location_requests") == 2,
                "retry_reached_records": after.get("surface") == ["records"] and bool(after.get("geo")),
            })
    elif journey in ("explicit-zero", "missing-coverage"):
        escape = obs.get("escape") or {}
        collection = obs.get("collection") or {}
        zero = journey == "explicit-zero"
        out.update({
            "state_copy_shown": _norm(obs.get("recovery_message")) == (ZERO_COPY if zero else UNAVAILABLE_COPY),
            "count_state_is_distinct": "results_count" in obs and (
                obs.get("results_count") == "0" if zero else obs.get("results_count") is None
            ),
            "useful_state_kept": bool(obs.get("citywide_preview_ids")),
            "all_nyc_activated": (
                escape.get("tag") == "a" and _collection_ok(collection, escape.get("href"))
                and _path(collection.get("url")) == "/browse/meetings/" and _no_place(collection.get("url"))
            ),
        })
        if local:
            out["frozen_place"] = _query((obs.get("scope") or {}).get("url")).get("geo") == [ZERO_GEO if zero else UNCOVERED_GEO]
        if not zero:
            out["retry_offered"] = bool(obs.get("retry_href"))
    elif journey == "failed-section":
        failed = obs.get("failed") or {}
        after = obs.get("after_retry") or {}
        failed_citywide = failed.get("citywide") or {}
        out.update({
            "fault_was_injected": int(obs.get("faulted_reads") or 0) >= 1,
            "local_records_survive": bool(failed.get("local")) and failed.get("local") == after.get("local"),
            "failed_section_is_unavailable_not_zero": (
                failed_citywide.get("state") == "unavailable" and failed_citywide.get("count_label") == "Count unavailable"
                and not failed_citywide.get("ids")
            ),
            "retry_restores_section_in_place": (
                (after.get("citywide") or {}).get("state") == "ready" and bool((after.get("citywide") or {}).get("ids"))
                and bool(after.get("url")) and after.get("url") == failed.get("url")
            ),
        })
        if local:
            out["frozen_midwood_records"] = sorted(failed.get("local") or []) == FROZEN_CONTROLS["midwood_record_ids"]
    elif journey == "detail-failure":
        out.update({
            "detail_failure_observed": obs.get("failed_status") == 503,
            "back_restores_scope_focus_scroll": _back_ok(obs.get("departure"), obs.get("returned"), obs.get("record_id")),
            "inspect_offers_full_record_again": (
                bool(obs.get("inspection_open_href"))
                and _path(obs.get("inspection_open_href")) == _path((obs.get("full_link") or {}).get("href"))
            ),
            "recovered_destination_is_record": _destination_ok(obs.get("destination"), obs.get("record_id")),
            "record_page_kept_behind_new_tab": obs.get("opened_in_new_tab") is True and obs.get("origin_kept") is True,
        })
    else:
        out["known_journey"] = False
    return out


# A pending obligation is legitimate only when the observation it cites shows
# the missing positive; anything else is a failure dressed as a wait.
PENDING_EVIDENCE: dict[str, Callable[[dict], bool]] = {
    "no-collection-record": lambda obs: (obs.get("collection") or {}).get("record_links") == 0,
    "no-meeting-record": lambda obs: "record_id" in obs and obs["record_id"] is None and (
        all(place.get("meeting_record") is None for place in obs.get("destinations") or [])
    ),
    "place-now-supported": lambda obs: obs.get("recovery_message") is None and obs.get("results_count") is not None,
    "no-citywide-record": lambda obs: obs.get("preview_ids") == [],
    "no-suggested-place": lambda obs: obs.get("links") == [],
}


def derive_outcome(row: dict, mode: str) -> str:
    if row.get("error"):
        return "fail"
    obligation = row.get("pending_obligation")
    if obligation:
        evidence = PENDING_EVIDENCE.get(obligation)
        legitimate = mode == SERVED_MODE and evidence is not None and evidence(row.get("observations") or {})
        return "pending" if legitimate else "fail"
    assertions = derive_assertions(row, mode)
    return "pass" if assertions and all(value is True for value in assertions.values()) else "fail"


def derive_findings(rows: list[dict]) -> list[dict]:
    """Observed defects on pages a journey only passes through (Browse and record
    documents): reported beside the result, never folded into a Near You verdict."""
    findings = []
    for row in rows:
        obs = row.get("observations") or {}
        for surface in ("collection", "destination", "browse"):
            step = obs.get(surface) or {}
            if int(step.get("overflow_x") or 0) > 1:
                findings.append({
                    "row": row.get("name"),
                    "surface": surface,
                    "path": _path(step.get("url")),
                    "horizontal_overflow_px": int(step["overflow_x"]),
                })
    return findings


def derive_result(rows: list[dict], mode: str) -> str:
    outcomes = [derive_outcome(row, mode) for row in rows]
    if not outcomes or "fail" in outcomes:
        return "fail"
    return "pending" if "pending" in outcomes else "pass"


# --- Validator ---------------------------------------------------------------


def required_rows(mode: str) -> list[str]:
    journeys = list(FAMILIES) + (list(RECOVERY_CASES) if mode == LOCAL_MODE else [])
    return [f"{journey}-{name}" for journey in journeys for name, _width, _height in VIEWPORTS]


def observed_generations(rows: list[dict]) -> tuple[set, list[str]]:
    """Generations named by Worker responses, and served Worker pages that named none."""
    named: set = set()
    unnamed: list[str] = []
    for row in rows:
        for response in row.get("responses") or []:
            if not response.get("worker"):
                continue
            if response.get("read_model_version"):
                named.add(response["read_model_version"])
            elif int(response.get("status") or 0) < 500:
                unnamed.append(str(response.get("path")))
    return named, unnamed


def validate_rows(manifest: dict, mode: str) -> str:
    rows = manifest.get("captures")
    if not isinstance(rows, list) or not rows:
        refuse("missing-data", "the manifest records no journey observations")
    names = [row.get("name") for row in rows]
    if len(set(names)) != len(names):
        refuse("duplicate-row", "a journey row is recorded twice")
    widths = {name: (width, height) for name, width, height in VIEWPORTS}
    for expected in required_rows(mode):
        if expected not in names:
            refuse("missing-viewport", f"{expected} is absent: that journey was not observed at the {expected.rsplit('-', 1)[-1]} viewport")
    for row in rows:
        name = row.get("name")
        viewport = row.get("viewport") or {}
        if (viewport.get("width"), viewport.get("height")) != widths.get(viewport.get("name")):
            refuse("missing-viewport", f"{name}: declared viewport {viewport} is not one of the named viewports")
        if name != f"{row.get('journey')}-{viewport.get('name')}":
            refuse("missing-viewport", f"{name}: row name does not match its journey and viewport")
        if row.get("capture_run_id") != manifest.get("capture_run_id"):
            refuse("mixed-generation", f"{name}: row belongs to another capture run")
        render = row.get("render") or {}
        if not re.fullmatch(r"[0-9a-f]{64}", str(render.get("sha256") or "")):
            refuse("absent-capture-file", f"{name}: render content hash is absent")
        if render.get("committed") is not False or "file" in row:
            refuse("image-committed", f"{name}: render proof must stay outside the repository")
        derived = derive_assertions(row, mode)
        if row.get("assertions") != derived:
            refuse("assertion-mismatch", f"{name}: stored assertions do not re-derive from the observations")
        outcome = derive_outcome(row, mode)
        if row.get("outcome") != outcome:
            refuse("outcome-mismatch", f"{name}: stored outcome {row.get('outcome')!r} re-derives as {outcome!r}")
        if outcome == "fail":
            obs = row.get("observations") or {}
            destination = obs.get("destination") or {}
            if destination.get("fragment") and destination.get("anchor_present") is not True:
                refuse("missing-anchor", f"{name}: destination lacks the #{destination['fragment']} anchor its link named")
            if destination and expected_record(obs) and destination.get("record_id") != expected_record(obs):
                refuse("nonexistent-record", f"{name}: destination {destination.get('record_id')!r} is not the linked record {expected_record(obs)!r}")
            if row.get("error"):
                refuse("journey-error", f"{name}: {row['error']}")
            if row.get("pending_obligation"):
                refuse("assertion-failed", f"{name}: {row['pending_obligation']} is not a legitimate pending state here")
            refuse("assertion-failed", f"{name}: {sorted(key for key, value in derived.items() if value is not True)}")
    if manifest.get("findings") != derive_findings(rows):
        refuse("findings-mismatch", "stored findings do not re-derive from the observations")
    result = derive_result(rows, mode)
    if manifest.get("result") != result:
        refuse("result-mismatch", f"stored result {manifest.get('result')!r} re-derives as {result!r}")
    return result


def validate_generation(manifest: dict, mode: str) -> None:
    named, unnamed = observed_generations(manifest.get("captures") or [])
    if len(named) > 1:
        refuse("mixed-generation", f"Worker responses name more than one read-model generation: {sorted(named)}")
    identity = manifest.get("identity") or {}
    before, after = identity.get("before") or {}, identity.get("after") or {}
    if not before or before != after:
        refuse("mixed-generation", "identity observed after the run differs from the identity observed before it")
    if not named:
        if mode == SERVED_MODE:
            refuse("deploy-pending", "no Worker response named its read-model generation; the generation header is not served yet")
        refuse("mixed-generation", "no Worker response named its read-model generation")
    if unnamed:
        refuse("mixed-generation", f"some Worker pages named no read-model generation: {unnamed[:3]}")
    generation = next(iter(named))
    if before.get("data_generation") != generation:
        refuse("mixed-generation", f"observed generation {generation!r} differs from the recorded {before.get('data_generation')!r}")
    if mode == LOCAL_MODE and generation != FROZEN_GENERATION:
        refuse("mixed-generation", f"local generation {generation!r} is not the frozen activity {FROZEN_GENERATION!r}")


def validate_local_provenance(manifest: dict, git: GitOracle) -> None:
    provenance = manifest.get("provenance") or {}
    revision = str(provenance.get("capture_revision") or "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        refuse("wrong-pin", "capture revision is not a full commit")
    head = git.resolve("HEAD")
    if not head or not git.is_ancestor(revision, head):
        refuse("wrong-pin", f"capture revision {revision} is not an ancestor of the checked tree")
    main = git.resolve(DEFAULT_BRANCH_REF)
    if main and not git.is_ancestor(revision, main):
        refuse("wrong-pin", f"capture revision {revision} is a branch-only commit, not on the default branch")
    inputs = provenance.get("measured_inputs") or []
    if sorted(str(item.get("path")) for item in inputs) != sorted(MEASURED_INPUTS):
        refuse("stale-inputs", "measured inputs do not match the declared input set")
    changed = [item["path"] for item in inputs if git.file_sha256(item["path"]) != item.get("sha256")]
    if changed:
        refuse("stale-inputs", f"measured inputs changed after capture: {changed}; recapture with {RECAPTURE_COMMAND}")
    if provenance.get("frozen_activity") != FROZEN_ACTIVITY or provenance.get("clock") != FROZEN_CLOCK:
        refuse("wrong-pin", "the local proof is not bound to the frozen activity blob and pinned clock")
    if re.search(r"https?://(127\.0\.0\.1|localhost)", json.dumps(manifest)):
        refuse("wrong-surface", "the local proof retains a loopback origin; observations must be site-relative")


def load_delivery(path: Path = DELIVERY_PATH) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        refuse("wrong-pin", f"recorded delivery is absent at {path.name}")
    except json.JSONDecodeError:
        refuse("wrong-pin", "recorded delivery is not valid JSON")
    if not isinstance(payload, dict) or payload.get("schema") != DELIVERY_SCHEMA or payload.get("public_alias") != PUBLIC_ALIAS:
        refuse("wrong-pin", "recorded delivery has the wrong schema or alias")
    if sorted(payload.get("surfaces") or []) != ["pages", "worker"]:
        refuse("wrong-pin", "recorded delivery must name both the pages and worker surfaces")
    if not re.fullmatch(r"[0-9a-f]{40}", str(payload.get("landed_commit") or "")):
        refuse("wrong-pin", "recorded delivery landed_commit is not a full commit")
    return payload


def require_landed(pin: str, git: GitOracle) -> None:
    main = git.resolve(DEFAULT_BRANCH_REF)
    if not main:
        refuse("wrong-pin", f"{DEFAULT_BRANCH_REF} is unavailable; the pin {pin} cannot be proved landed")
    if pin != main and not git.is_ancestor(pin, main):
        refuse("wrong-pin", f"pin {pin} is not on the default branch (a pre-squash or branch-only commit)")


def require_served_contains(identity: dict, pin: str, git: GitOracle) -> None:
    for surface in ("pages_revision", "worker_revision"):
        served = str(identity.get(surface) or "")
        if not re.fullmatch(r"[0-9a-f]{40}", served):
            refuse("deploy-pending", f"served {surface} is not a full commit: {served!r}")
        if served != pin and not git.is_ancestor(pin, served):
            refuse("deploy-pending", f"served {surface} {served} does not contain the landed commit {pin}")


def validate_served_provenance(manifest: dict, git: GitOracle, delivery: dict) -> None:
    pin = delivery["landed_commit"]
    if manifest.get("required_ancestor") != pin:
        refuse("wrong-pin", "manifest pin differs from the recorded delivery")
    require_landed(pin, git)
    identity = (manifest.get("identity") or {}).get("before") or {}
    require_served_contains(identity, pin, git)
    for key in ("pages_artifact_hash", "pages_data_receipt_sha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", str(identity.get(key) or "")):
            refuse("missing-data", f"served identity lacks {key}")
    serialized = json.dumps(manifest)
    if "127.0.0.1" in serialized or "localhost" in serialized:
        refuse("wrong-surface", "a served manifest contains a loopback observation")


def validate_manifest(manifest: dict, *, mode: str, git: GitOracle | None = None, delivery: dict | None = None) -> str:
    """Validate a retained manifest; return its re-derived result or raise a specific refusal."""
    git = git or GitOracle()
    if manifest.get("schema") != MANIFEST_SCHEMA or manifest.get("scenario") != SCENARIO:
        refuse("wrong-schema", "not a discovery-recovery capture manifest")
    if manifest.get("capture_mode") != mode:
        refuse("wrong-surface", f"manifest mode {manifest.get('capture_mode')!r} is not {mode!r}")
    if manifest.get("image_binaries_committed") is not False:
        refuse("image-committed", "render proof must stay outside the repository")
    if not isinstance(manifest.get("captures"), list) or not manifest["captures"]:
        refuse("missing-data", "the manifest records no journey observations")
    if mode == LOCAL_MODE:
        validate_local_provenance(manifest, git)
    else:
        validate_served_provenance(manifest, git, delivery or load_delivery())
    validate_generation(manifest, mode)
    return validate_rows(manifest, mode)


# --- Browser observation -----------------------------------------------------

PAGE_JS = """() => {
  const root = document.querySelector('[data-near-you-root]');
  let rules = 0;
  const sheets = [];
  for (const sheet of document.styleSheets) {
    try { rules += sheet.cssRules.length; if (sheet.href) sheets.push(new URL(sheet.href).pathname); } catch { /* cross-origin */ }
  }
  return {
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight },
    stylesheets: sheets,
    stylesheet_rules: rules,
    overflow_x: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    heading: (document.querySelector('h1')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    surface: root?.dataset.nearSurface || null,
    deferred_state: root?.dataset.nearDeferredState || null,
    results_count: document.querySelector('.near-results')?.getAttribute('data-results-count') ?? null,
    scroll_y: Math.round(scrollY),
  };
}"""

LOCAL_LIST_JS = """() => [...document.querySelectorAll('.near-results li.near-record')]
  .filter((node) => !node.closest('.near-broader-districts'))
  .map((node) => node.dataset.recordId)"""

RETURN_STATE_JS = """() => {
  const active = document.activeElement;
  return {
    url: location.href,
    heading: (document.querySelector('h1')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    surface: document.querySelector('[data-near-you-root]')?.dataset.nearSurface || null,
    scroll_y: Math.round(scrollY),
    focus_record_id: active?.closest('[data-record-id]')?.dataset.recordId || null,
    focus_class: (active && typeof active.className === 'string' && active.className) || active?.tagName || null,
  };
}"""

DESTINATION_JS = """() => {
  const hash = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';
  return {
    url: location.href,
    record_id: document.querySelector('main[data-meeting-id]')?.getAttribute('data-meeting-id') || null,
    heading: (document.querySelector('main h1, h1')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    near_you_shell: Boolean(document.querySelector('[data-near-you-root]')),
    fragment: hash || null,
    anchor_present: hash ? Boolean(document.getElementById(hash)) : null,
    overflow_x: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  };
}"""

SECTIONS_JS = """() => {
  const bag = document.querySelector('[data-bag="citywide"]');
  return {
    url: location.href,
    local: [...document.querySelectorAll('.near-results li.near-record')]
      .filter((node) => !node.closest('.near-broader-districts')).map((node) => node.dataset.recordId).sort(),
    citywide: bag ? {
      state: bag.getAttribute('data-near-section-state') || 'ready',
      ids: [...bag.querySelectorAll('li.near-record')].map((node) => node.dataset.recordId),
      count_label: (bag.querySelector(':scope > h2 > [aria-label]')?.getAttribute('aria-label')
        || bag.querySelector(':scope > h2 > strong')?.textContent || '').trim(),
    } : null,
  };
}"""

ENTRY_STATE_JS = """() => {
  const group = document.querySelector('[data-near-entry-recovery]');
  const visible = (node) => { const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  return {
    url: location.href,
    status: (document.querySelector('[data-map-status]')?.textContent || '').trim(),
    actions: group ? [...group.querySelectorAll('[data-near-entry-recovery-action]')].filter(visible).map((node) => ({
      action: node.dataset.nearEntryRecoveryAction, tag: node.tagName.toLowerCase(),
      label: node.textContent.trim(), href: node.getAttribute('href'),
    })) : [],
  };
}"""

LINK_JS = """(node) => {
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return {
    tag: node.tagName.toLowerCase(),
    text: node.textContent.replace(/\\s+/g, ' ').trim(),
    href: node.getAttribute('href'),
    visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
    in_closed_details: Boolean(node.closest('details:not([open])')),
  };
}"""

FOCUS_RESTORED_JS = """([card, y]) => { const node = document.querySelector(card);
  return Boolean(node && node.contains(document.activeElement)) && Math.abs(scrollY - y) <= 4; }"""

GEOLOCATION_STUB = """
(() => {
  const plan = %s;
  window.__locationRequests = 0;
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition(success, error) {
        const step = plan[Math.min(window.__locationRequests, plan.length - 1)];
        window.__locationRequests += 1;
        if (step.kind === "grant") setTimeout(() => success({ coords: step.coords }), 0);
        else if (step.kind === "deny") setTimeout(() => error?.({ code: 1, message: "fixture denial" }), 0);
        else setTimeout(() => error?.({ code: 3, message: "fixture timeout" }), 0);
      },
    },
  });
})();
"""


# Near You asks for location once per session on a fresh load with no place
# chosen. These journeys press Use my location themselves, so each context
# starts as a session that already asked.
LOCATION_ALREADY_ASKED = (
    "try { sessionStorage.setItem('near-you:location-asked', '1'); } catch {}"
)


class PendingObligation(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class RunContext:
    base: str
    mode: str
    run_id: str
    image_dir: Path


class Journey:
    """One browser context at one named viewport, recording every same-origin page response."""

    def __init__(self, browser, run: RunContext, viewport: tuple[str, int, int], *, geolocation=None):  # noqa: ANN001
        self.run = run
        _name, width, height = viewport
        self.touch = width < 500
        self.context = browser.new_context(
            viewport={"width": width, "height": height}, has_touch=self.touch, user_agent=USER_AGENT,
        )
        self.context.add_init_script(LOCATION_ALREADY_ASKED)
        if geolocation is not None:
            self.context.add_init_script(GEOLOCATION_STUB % json.dumps(geolocation))
        self.page = self.context.new_page()
        self.responses: list[dict] = []
        self.page.on("response", self._record_response)
        self.label = ""
        self.principal: dict | None = None

    def _record_response(self, response) -> None:  # noqa: ANN001
        url = urlsplit(response.url)
        if url.netloc != urlsplit(self.run.base).netloc:
            return
        worker = url.path in WORKER_PATHS
        if not worker and not url.path.startswith(("/meetings/", "/browse/")):
            return
        self.responses.append({
            "path": url.path + (f"?{url.query}" if url.query else ""),
            "status": response.status,
            "worker": worker,
            "read_model_version": response.headers.get(READ_MODEL_VERSION_HEADER) if worker else None,
        })

    def close(self) -> None:
        self.context.close()

    def goto(self, path: str) -> int:
        response = self.page.goto(urljoin(self.run.base, path.lstrip("/")), wait_until="domcontentloaded", timeout=90_000)
        return response.status if response else 0

    def activate(self, locator) -> None:  # noqa: ANN001
        """Touch taps at the phone width; keyboard activation at the desktop width."""
        locator.scroll_into_view_if_needed()
        if self.touch:
            locator.tap()
        else:
            locator.focus()
            locator.press("Enter")

    def navigate_response(self, locator):  # noqa: ANN001, ANN201
        with self.page.expect_navigation(wait_until="domcontentloaded", timeout=90_000) as navigation:
            self.activate(locator)
        return navigation.value

    def navigate(self, locator) -> int:  # noqa: ANN001
        response = self.navigate_response(locator)
        return response.status if response else 0

    def settle(self) -> None:
        self.page.wait_for_function(
            "() => ['ready', 'error', 'partial'].includes(document.querySelector('[data-near-you-root]')?.dataset.nearDeferredState)",
            timeout=60_000,
        )

    def measure(self) -> dict:
        return self.page.evaluate(PAGE_JS)

    def destination(self, status: int, page=None) -> dict:  # noqa: ANN001
        target = page or self.page
        target.wait_for_selector("h1", timeout=60_000)
        return {**target.evaluate(DESTINATION_JS), "status": status}

    def mark_principal(self) -> None:
        """Measure and render the journey's principal Near You state."""
        self.principal = {"page": self.measure(), "render": self.render(self.label)}

    def settled_collection(self) -> None:
        # Browse documents hydrate and re-render their list after load; read
        # links only once the application has settled.
        self.page.wait_for_load_state("networkidle", timeout=60_000)
        self.page.wait_for_function("() => document.body?.dataset.appReady === 'true' || !document.body?.dataset.appRoute", timeout=60_000)

    def render(self, label: str) -> dict:
        for attempt in range(3):
            try:
                png = self.page.screenshot(full_page=False, type="png", animations="disabled")
                break
            except Exception:  # noqa: BLE001 - a compositor hiccup; the third failure propagates
                if attempt == 2:
                    raise
                self.page.wait_for_timeout(500)
        image = self.run.image_dir / f"{label}.png"
        image.write_bytes(png)
        if not image.exists() or sha256_bytes(image.read_bytes()) != sha256_bytes(png):
            refuse("absent-capture-file", f"{label}: the render file was not retained locally")
        return {
            "sha256": sha256_bytes(png),
            "bytes": len(png),
            "local_image": (IMAGE_DIR / self.run.run_id / image.name).as_posix(),
            "committed": False,
        }


def local_card(record_id: str) -> str:
    return f'.near-results li.near-record[data-record-id="{record_id}"]:not(.near-broader-districts *)'


def wait_records(journey: Journey, geo: str | None = None) -> None:
    journey.page.wait_for_function(
        """(geo) => { const url = new URL(location.href); const root = document.querySelector('[data-near-you-root]');
          return (!geo || url.searchParams.get('geo') === geo) && root?.dataset.nearSurface === 'records'
            && ['ready', 'partial', 'error'].includes(root?.dataset.nearDeferredState); }""",
        arg=geo,
        timeout=60_000,
    )


def record_round_trip(journey: Journey, record_id: str, obs: dict, *, wait: Callable[[], None]) -> None:
    """Inspect -> dismiss -> full record -> Back -> continue, from one listed card."""
    page = journey.page
    card = local_card(record_id)
    title = page.locator(f"{card} .near-record-title-link, {card} .near-record-title").first
    obs["record_title"] = _norm(title.inner_text()) if title.count() else ""
    inspect = page.locator(f"{card} .near-record-inspect").first
    tag = inspect.evaluate("node => node.tagName.toLowerCase()") if inspect.count() else None
    journey.activate(inspect)
    dialog = page.locator("dialog[open]")
    dialog.wait_for(state="visible", timeout=15_000)
    dialog_text = _norm(dialog.inner_text())
    journey.activate(dialog.locator("[data-near-you-record-inspection-close]"))
    page.wait_for_function("() => !document.querySelector('dialog[open]')", timeout=15_000)
    dismissed = page.evaluate(RETURN_STATE_JS)
    obs["inspect"] = {
        "control_tag": tag, "dialog_open": True, "dialog_text": dialog_text[:1000],
        "focus_record_id": dismissed["focus_record_id"], "focus_class": dismissed["focus_class"],
    }
    full = page.locator(f"{card} a.near-record-full-record").first
    obs["full_link"] = full.evaluate(LINK_JS)
    full.scroll_into_view_if_needed()
    obs["departure"] = page.evaluate(RETURN_STATE_JS)
    obs["destination"] = journey.destination(journey.navigate(full))
    page.go_back(wait_until="domcontentloaded")
    wait()
    page.wait_for_function(FOCUS_RESTORED_JS, arg=[card, obs["departure"]["scroll_y"]], timeout=15_000)
    obs["returned"] = page.evaluate(RETURN_STATE_JS)
    journey.activate(page.locator(f"{card} .near-record-inspect").first)
    page.locator("dialog[open]").wait_for(state="visible", timeout=15_000)
    obs["continued"] = True
    journey.activate(page.locator("dialog[open] [data-near-you-record-inspection-close]"))
    page.wait_for_function("() => !document.querySelector('dialog[open]')", timeout=15_000)


def collection_state(journey: Journey, response) -> dict:  # noqa: ANN001
    """A Browse document reached by navigation: the marker its served HTML carries, then its settled page."""
    page = journey.page
    body = response.text() if response is not None else ""
    marker = re.search(r'data-build-rendered="([^"]+)"', body)
    journey.settled_collection()
    return {
        "url": page.url,
        "status": response.status if response is not None else 0,
        "marker": marker.group(1) if marker else None,
        "overflow_x": page.evaluate("() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)"),
    }


def first_meeting_record(page, listed: list[str]) -> str | None:  # noqa: ANN001
    """The first listed record whose full-record link is a meeting page, as the page lists it."""
    return next((
        record for record in listed
        if page.locator(f"{local_card(record)} a.near-record-full-record[href*='/meetings/']").count()
    ), None)


def open_collection_record(journey: Journey, obs: dict) -> None:
    """From a Browse collection, open its first listed meeting and read the destination's identity."""
    links = journey.page.locator('main a[href^="/meetings/"]')
    obs["collection"]["record_links"] = links.count()
    if not links.count():
        raise PendingObligation("no-collection-record")
    first = links.first
    obs["record_href"] = first.get_attribute("href")
    obs["record_title"] = _norm(first.inner_text())
    obs["destination"] = journey.destination(journey.navigate(first))


def family_root_category_record(journey: Journey, obs: dict) -> None:
    page = journey.page
    journey.goto("/")
    journey.settle()
    journey.mark_principal()
    obs["entry_links"] = page.eval_on_selector_all(
        "[data-near-collection-entry] a",
        "nodes => nodes.map((node) => ({ text: node.textContent.trim(), href: node.getAttribute('href'), family: node.dataset.browseFamily || null }))",
    )
    family = page.locator('[data-near-collection-entry] a[data-browse-family="meetings-decisions"]').first
    obs["family_link"] = family.evaluate(LINK_JS)
    obs["collection"] = collection_state(journey, journey.navigate_response(family))
    open_collection_record(journey, obs)
    page.go_back(wait_until="domcontentloaded")
    journey.settled_collection()
    obs["returned"] = {
        "url": page.url,
        "record_link_present": page.locator(f'main a[href="{obs["record_href"]}"]').count() > 0,
    }


def family_typed_place_record(journey: Journey, obs: dict) -> None:
    page = journey.page
    journey.goto("/")
    page.locator("[data-use-location]:not([hidden])").wait_for(state="attached", timeout=60_000)
    field = page.locator("#near-geo-search-input")
    if not field.is_visible():
        page.locator(".near-place-guide > summary").click()
    field.fill(MIDWOOD_ADDRESS)
    journey.activate(page.locator("form.near-geo-search button[type='submit']"))
    wait_records(journey, MIDWOOD_GEO)
    journey.mark_principal()
    obs["scope"] = journey.measure()
    obs["listed_ids"] = page.evaluate(LOCAL_LIST_JS)
    # Offline, the named frozen anchor; served, a meeting the page itself listed.
    obs["record_id"] = (
        FROZEN_CONTROLS["midwood_record"] if journey.run.mode == LOCAL_MODE else first_meeting_record(page, obs["listed_ids"])
    )
    if not obs["record_id"]:
        raise PendingObligation("no-meeting-record")
    record_round_trip(journey, obs["record_id"], obs, wait=lambda: wait_records(journey, MIDWOOD_GEO))


def records_panel_recovery(journey: Journey, obs: dict) -> None:
    page = journey.page
    journey.mark_principal()
    scope = journey.measure()
    obs["scope"] = scope
    obs["results_count"] = scope["results_count"]
    recovery = page.locator('[data-near-surface-panel="records"] .near-local-recovery strong').first
    obs["recovery_message"] = _norm(recovery.inner_text()) if recovery.count() else None
    retry = page.locator('[data-near-surface-panel="records"] .near-local-recovery [data-near-recovery="retry"]').first
    obs["retry_href"] = retry.get_attribute("href") if retry.count() else None


def family_unsupported_place_escape(journey: Journey, obs: dict) -> None:
    journey.goto(f"/near-you/?geo={UNSUPPORTED_GEO.replace(':', '%3A')}&surface=records&lens=meetings")
    wait_records(journey, UNSUPPORTED_GEO)
    records_panel_recovery(journey, obs)
    escape = journey.page.locator('[data-near-surface-panel="records"] [data-near-recovery="all-nyc"]').first
    if not escape.count():
        raise PendingObligation("place-now-supported")
    obs["escape"] = escape.evaluate(LINK_JS)
    obs["collection"] = collection_state(journey, journey.navigate_response(escape))
    open_collection_record(journey, obs)


def family_citywide_bucket_record(journey: Journey, obs: dict) -> None:
    page = journey.page
    journey.goto("/")
    journey.settle()
    section = page.locator('.near-special-records[data-near-special-records="entry"]').first
    obs["preview_ids"] = section.evaluate(
        "node => [...node.querySelectorAll('li.near-record')].map((card) => card.dataset.recordId)"
    ) if section.count() else []
    obs["total_text"] = section.locator("h2 > strong").first.inner_text() if section.count() else None
    view_all = page.locator('[data-near-special-link="citywide"]').first
    obs["view_all_href"] = view_all.get_attribute("href") if view_all.count() else None
    if not obs["preview_ids"]:
        raise PendingObligation("no-citywide-record")
    journey.activate(view_all)
    page.wait_for_url(lambda url: _query(url).get("scope") == ["citywide"], timeout=60_000)
    wait_records(journey)
    journey.mark_principal()
    bucket = journey.measure()
    bucket["listed_ids"] = page.evaluate(LOCAL_LIST_JS)
    obs["bucket"] = bucket
    obs["record_id"] = first_meeting_record(page, bucket["listed_ids"])
    if obs["record_id"] is None:
        raise PendingObligation("no-meeting-record")
    record_round_trip(journey, obs["record_id"], obs, wait=lambda: wait_records(journey))


def family_suggested_place_record(journey: Journey, obs: dict) -> None:
    """Follow every suggestion to its Records list, then open a meeting from the first list that has one."""
    page = journey.page
    journey.goto("/")
    journey.settle()
    journey.mark_principal()
    obs["links"] = page.eval_on_selector_all(
        "a[data-near-place-suggestion]",
        "nodes => nodes.map((node) => ({ id: node.dataset.nearPlaceSuggestion, href: node.getAttribute('href'), "
        "data_count: node.dataset.count, text: node.textContent.replace(/\\s+/g, ' ').trim() }))",
    )
    if not obs["links"]:
        raise PendingObligation("no-suggested-place")
    obs["destinations"] = []
    obs["record_id"] = None
    for index, link in enumerate(obs["links"]):
        if index:
            journey.goto("/")
            journey.settle()
        journey.activate(page.locator(f'a[data-near-place-suggestion="{link["id"]}"]'))
        geo = f"nta2020:{link['id']}"
        wait_records(journey, geo)
        place = journey.measure()
        place["id"] = link["id"]
        place["listed_ids"] = page.evaluate(LOCAL_LIST_JS)
        place["meeting_record"] = first_meeting_record(page, place["listed_ids"])
        obs["destinations"].append(place)
        if obs["record_id"] is None and place["meeting_record"]:
            obs["chosen"] = link
            obs["record_id"] = place["meeting_record"]
            record_round_trip(journey, obs["record_id"], obs, wait=lambda geo=geo: wait_records(journey, geo))
    if obs["record_id"] is None:
        raise PendingObligation("no-meeting-record")


def case_location(journey: Journey, obs: dict, *, denied: bool) -> None:
    page = journey.page
    journey.goto("/near-you/")
    page.locator("[data-use-location]:not([hidden])").wait_for(state="attached", timeout=60_000)
    obs["url_before"] = page.url
    button = page.locator("[data-use-location]")
    if not button.is_visible():
        for summary in (".near-place-guide > summary", ".near-place-options > summary"):
            disclosure = page.locator(summary)
            if disclosure.count() and not disclosure.evaluate("node => node.parentElement.open"):
                disclosure.click()
    journey.activate(button)
    page.wait_for_function(
        "(prefix) => (document.querySelector('[data-map-status]')?.textContent || '').trim().startsWith(prefix)"
        " && Boolean(document.querySelector('[data-near-entry-recovery]'))",
        arg=DENIED if denied else TIMED_OUT,
        timeout=30_000,
    )
    journey.mark_principal()
    obs["state"] = page.evaluate(ENTRY_STATE_JS)
    if denied:
        journey.activate(page.locator('[data-near-entry-recovery-action="enter_address"]'))
        obs["focused_after_enter_address"] = page.evaluate("() => document.activeElement?.id || null")
        obs["browse"] = collection_state(journey, journey.navigate_response(page.locator('[data-near-entry-recovery-action="browse_all"]')))
    else:
        journey.activate(page.locator('[data-near-entry-recovery-action="retry"]'))
        wait_records(journey)
        obs["after_retry"] = {"url": page.url}
        obs["location_requests"] = page.evaluate("() => window.__locationRequests")


def case_place_state(journey: Journey, obs: dict, geo: str) -> None:
    page = journey.page
    journey.goto(f"/near-you/?geo={geo.replace(':', '%3A')}&surface=records&lens=meetings")
    wait_records(journey, geo)
    records_panel_recovery(journey, obs)
    obs["citywide_preview_ids"] = page.eval_on_selector_all(
        '[data-bag="citywide"] li.near-record', "nodes => nodes.map((node) => node.dataset.recordId)",
    )
    escape = page.locator('[data-near-surface-panel="records"] [data-near-recovery="all-nyc"]').first
    obs["escape"] = escape.evaluate(LINK_JS)
    obs["collection"] = collection_state(journey, journey.navigate_response(escape))


def case_failed_section(journey: Journey, obs: dict) -> None:
    page = journey.page
    reads: list[str] = []

    def fail_first(route) -> None:  # noqa: ANN001
        reads.append(route.request.url)
        headers = dict(route.request.headers)
        if len(reads) == 1:
            headers[FIXTURE_FAIL_HEADER] = CITYWIDE_FAULT
        route.continue_(headers=headers)

    page.route("**/near-you/deferred.json*", fail_first)
    journey.goto(f"/near-you/?geo={MIDWOOD_GEO.replace(':', '%3A')}&surface=records&lens=meetings")
    page.wait_for_function(
        "() => document.querySelector('[data-near-you-root]')?.dataset.nearDeferredState === 'partial'", timeout=60_000,
    )
    obs["faulted_reads"] = len(reads)
    journey.mark_principal()
    obs["failed"] = page.evaluate(SECTIONS_JS)
    journey.activate(page.locator('[data-bag="citywide"] [data-near-recovery="retry"]').first)
    page.wait_for_function(
        "() => { const bag = document.querySelector('[data-bag=\"citywide\"]'); return bag && !bag.hasAttribute('data-near-section-state'); }",
        timeout=60_000,
    )
    page.wait_for_function(
        "() => document.querySelector('[data-near-you-root]')?.dataset.nearDeferredState === 'ready'", timeout=60_000,
    )
    obs["after_retry"] = page.evaluate(SECTIONS_JS)
    page.unroute("**/near-you/deferred.json*", fail_first)


def case_detail_failure(journey: Journey, obs: dict) -> None:
    page = journey.page
    obs["record_id"] = FROZEN_CONTROLS["midwood_record"]
    card = local_card(obs["record_id"])
    journey.goto(f"/near-you/?geo={MIDWOOD_GEO.replace(':', '%3A')}&surface=records&lens=meetings")
    wait_records(journey, MIDWOOD_GEO)
    full = page.locator(f"{card} a.near-record-full-record").first
    obs["full_link"] = full.evaluate(LINK_JS)
    detail_path = _path(obs["full_link"]["href"])

    def unavailable(route) -> None:  # noqa: ANN001
        route.fulfill(status=503, content_type="text/html", body="<!doctype html><title>Unavailable</title><h1>Unavailable</h1>")

    page.route(f"**{detail_path}", unavailable)
    full.scroll_into_view_if_needed()
    obs["departure"] = page.evaluate(RETURN_STATE_JS)
    obs["failed_status"] = journey.navigate(full)
    page.go_back(wait_until="domcontentloaded")
    wait_records(journey, MIDWOOD_GEO)
    page.wait_for_function(FOCUS_RESTORED_JS, arg=[card, obs["departure"]["scroll_y"]], timeout=15_000)
    obs["returned"] = page.evaluate(RETURN_STATE_JS)
    journey.mark_principal()
    page.unroute(f"**{detail_path}", unavailable)
    journey.activate(page.locator(f"{card} .near-record-inspect").first)
    opener = page.locator("dialog[open] [data-near-you-record-inspection-open]")
    opener.wait_for(state="visible", timeout=15_000)
    obs["inspection_open_href"] = opener.get_attribute("href")
    # The published-record link opens its own tab and leaves this page in place.
    with journey.context.expect_page(timeout=60_000) as opened:
        journey.activate(opener)
    tab = opened.value
    tab.wait_for_load_state("domcontentloaded", timeout=60_000)
    status = tab.evaluate("() => performance.getEntriesByType('navigation')[0]?.responseStatus || 0")
    obs["destination"] = journey.destination(status, page=tab)
    obs["opened_in_new_tab"] = True
    obs["origin_kept"] = page.url == obs["departure"]["url"]
    tab.close()


FAMILY_DRIVERS = {
    "root-category-record": family_root_category_record,
    "typed-place-record": family_typed_place_record,
    "unsupported-place-escape": family_unsupported_place_escape,
    "citywide-bucket-record": family_citywide_bucket_record,
    "suggested-place-record": family_suggested_place_record,
}
CASE_DRIVERS = {
    "location-denied": (lambda journey, obs: case_location(journey, obs, denied=True), [{"kind": "deny"}]),
    "location-timeout": (
        lambda journey, obs: case_location(journey, obs, denied=False),
        [{"kind": "timeout"}, {"kind": "grant", "coords": ASTORIA}],
    ),
    "explicit-zero": (lambda journey, obs: case_place_state(journey, obs, ZERO_GEO), None),
    "failed-section": (case_failed_section, None),
    "missing-coverage": (lambda journey, obs: case_place_state(journey, obs, UNCOVERED_GEO), None),
    "detail-failure": (case_detail_failure, None),
}


def without_origin(value, origin: str):  # noqa: ANN001, ANN201
    """Site-relative observations: an ephemeral local origin never enters retained evidence."""
    if isinstance(value, str):
        return value.replace(origin, "")
    if isinstance(value, list):
        return [without_origin(item, origin) for item in value]
    if isinstance(value, dict):
        return {key: without_origin(item, origin) for key, item in value.items()}
    return value


def observe_row(browser, run: RunContext, journey_id: str, viewport, driver, *, geolocation=None) -> dict:  # noqa: ANN001
    name, width, height = viewport
    label = f"{journey_id}-{name}"
    journey = Journey(browser, run, viewport, geolocation=geolocation)
    journey.label = label
    obs: dict = {}
    row: dict = {
        "name": label,
        "journey": journey_id,
        "viewport": {"name": name, "width": width, "height": height},
        "capture_run_id": run.run_id,
    }
    try:
        try:
            driver(journey, obs)
        except PendingObligation as pending:
            row["pending_obligation"] = pending.code
        except Exception as error:  # noqa: BLE001 - recorded, and the derivation then fails the row
            row["error"] = f"{type(error).__name__}: {(str(error).splitlines() or [''])[0][:300]}"
        principal = journey.principal or {"page": journey.measure(), "render": journey.render(label)}
        row["page"] = principal["page"]
        row["render"] = principal["render"]
    finally:
        journey.close()
    row["observations"] = obs
    row["responses"] = journey.responses
    if run.mode == LOCAL_MODE:
        row = without_origin(row, run.base.rstrip("/"))
    row["assertions"] = derive_assertions(row, run.mode)
    row["outcome"] = derive_outcome(row, run.mode)
    print(f"{row['outcome']:>7} {label}", flush=True)
    return row


def assert_checkers_can_fail() -> None:
    """Positive controls: each shared derivation rejects a state built to fail it."""
    good = {"record_id": "r1", "status": 200, "near_you_shell": False, "fragment": None, "anchor_present": None}
    assert _destination_ok(good, "r1")
    for broken in (
        {**good, "record_id": "r2"}, {**good, "status": 503}, {**good, "near_you_shell": True},
        {**good, "fragment": "agenda-subject", "anchor_present": False},
    ):
        assert not _destination_ok(broken, "r1"), broken
    departure = {"url": "u", "scroll_y": 100}
    returned = {"url": "u", "scroll_y": 102, "focus_record_id": "r1", "focus_class": "near-record-full-record"}
    assert _back_ok(departure, returned, "r1")
    for broken in (
        {**returned, "scroll_y": 140}, {**returned, "focus_record_id": None}, {**returned, "url": "v"},
        {**returned, "focus_class": "near-record-inspect"},
    ):
        assert not _back_ok(departure, broken, "r1"), broken
    assert count_from_label("Tribeca-Civic Center (26 meetings)") == 26
    assert count_from_label("Tribeca-Civic Center") is None
    assert not _no_place("/browse/meetings/?when=all&geo=nta2020%3ABK1503")
    assert _no_place("/browse/meetings/?when=all")


# --- Identity ----------------------------------------------------------------


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        refuse("missing-data", f"served JSON is not an object: {url}")
    return payload


def fetch_generation(url: str) -> str | None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        response.read()
        return response.headers.get(READ_MODEL_VERSION_HEADER)


def served_identity(base: str, deployment_manifest) -> dict:  # noqa: ANN001
    pages = deployment_manifest(base)
    worker = fetch_json(WORKER_HEALTH_URL)
    return {
        "pages_revision": pages.get("source_commit_sha"),
        "pages_artifact_hash": pages.get("artifact_hash"),
        "pages_data_receipt_sha256": (pages.get("source_receipt") or {}).get("sha256"),
        "pages_data_generated_at": (pages.get("source_receipt") or {}).get("generated_at"),
        "worker_revision": worker.get("commit"),
        "worker_environment": worker.get("environment"),
        "data_generation": fetch_generation(urljoin(base, "near-you/deferred.json?lens=meetings")),
    }


def local_identity(base: str, git: GitOracle) -> dict:
    return {
        "measured_inputs": [{"path": path, "sha256": git.file_sha256(path)} for path in MEASURED_INPUTS],
        "data_generation": fetch_generation(urljoin(base, "near-you/deferred.json?lens=meetings")),
    }


def require_served_base(base: str) -> str:
    normalized = base.rstrip("/") + "/"
    parts = urlsplit(normalized)
    if parts.scheme != "https" or (parts.hostname or "").lower() not in PRODUCTION_HOSTS:
        refuse("wrong-surface", f"served capture requires the production site, got {base}")
    return normalized


def start_local_server() -> tuple[subprocess.Popen, str]:
    env = {
        **os.environ,
        "NODE_OPTIONS": " ".join(filter(None, [
            os.environ.get("NODE_OPTIONS"), f"--import={ROOT / 'test' / 'helpers' / 'test_clock_preload.mjs'}",
        ])),
        "CITYSCROLL_TEST_TIME_PIN": FROZEN_CLOCK,
        "NEAR_YOU_CAPTURE_ACTIVITY_BLOB": FROZEN_ACTIVITY["blob"],
    }
    server = subprocess.Popen(["node", "tools/serve_near_you_capture.mjs"], cwd=ROOT, stdout=subprocess.PIPE, text=True, env=env)
    base = (server.stdout.readline() if server.stdout else "").strip()
    if not base.startswith("http://127.0.0.1:"):
        server.kill()
        refuse("missing-data", "the local Near You capture server did not announce a base URL")
    return server, base.rstrip("/") + "/"


# --- Capture -----------------------------------------------------------------


def capture(*, base: str | None, local: bool, deployment_manifest=None, git: GitOracle | None = None) -> dict:  # noqa: ANN001
    sys.path.insert(0, str(ROOT / "test" / "browser"))
    from browser_support import launched_chromium  # noqa: PLC0415

    git = git or GitOracle()
    assert_checkers_can_fail()
    mode = LOCAL_MODE if local else SERVED_MODE
    run_id = str(uuid.uuid4())
    image_dir = ROOT / IMAGE_DIR / run_id
    image_dir.mkdir(parents=True, exist_ok=True)
    server = None
    provenance: dict = {}
    delivery: dict | None = None
    try:
        if local:
            capture_revision = git.merge_base()
            if not capture_revision:
                refuse("wrong-pin", f"no merge base with {DEFAULT_BRANCH_REF}; fetch the default branch first")
            if not git.tree_matches(capture_revision, PAGES_DATA_PATHS):
                refuse("missing-data", f"site/data differs from the capture revision {capture_revision}; the proof could not name its data")
            server, base = start_local_server()
            before = local_identity(base, git)
            provenance = {
                "capture_revision": capture_revision,
                "capture_revision_rule": f"merge base of the capture checkout with {DEFAULT_BRANCH_REF}",
                "frozen_activity": dict(FROZEN_ACTIVITY),
                "clock": FROZEN_CLOCK,
                "pages_data": "site/data exactly as at capture_revision",
                "measured_inputs": before["measured_inputs"],
                "recapture_command": RECAPTURE_COMMAND,
                "server": "tools/serve_near_you_capture.mjs: the Worker Near You handler and the Pages edge handler",
            }
        else:
            base = require_served_base(base or "")
            delivery = load_delivery()
            require_landed(delivery["landed_commit"], git)
            before = served_identity(base, deployment_manifest)
            require_served_contains(before, delivery["landed_commit"], git)
            if not before.get("data_generation"):
                refuse("deploy-pending", "the served Worker does not name its read-model generation yet")
        run = RunContext(base=base, mode=mode, run_id=run_id, image_dir=image_dir)
        started = now_iso()
        rows: list[dict] = []
        with launched_chromium() as browser:
            for viewport in VIEWPORTS:
                for journey_id in FAMILIES:
                    rows.append(observe_row(browser, run, journey_id, viewport, FAMILY_DRIVERS[journey_id]))
                if local:
                    for case_id in RECOVERY_CASES:
                        driver, geolocation = CASE_DRIVERS[case_id]
                        rows.append(observe_row(browser, run, case_id, viewport, driver, geolocation=geolocation))
        after = local_identity(base, git) if local else served_identity(base, deployment_manifest)
    finally:
        if server is not None:
            server.terminate()
            server.wait(timeout=15)
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "scenario": SCENARIO,
        "public_alias": PUBLIC_ALIAS,
        "capture_mode": mode,
        "capture_run_id": run_id,
        "base": "local-fixture-server" if local else base,
        "viewports": [{"name": name, "width": width, "height": height} for name, width, height in VIEWPORTS],
        "run_receipt": {"started_at": started, "finished_at": now_iso()},
        "identity": {
            "before": {key: value for key, value in before.items() if key != "measured_inputs"},
            "after": {key: value for key, value in after.items() if key != "measured_inputs"},
        },
        "image_binaries_committed": False,
        "image_policy": "Render content hashes only; the images stay under the ignored .artifacts directory.",
        "captures": rows,
    }
    if local:
        if after["measured_inputs"] != before["measured_inputs"]:
            refuse("stale-inputs", "measured inputs changed during the capture run")
        manifest["provenance"] = provenance
    else:
        manifest["required_ancestor"] = delivery["landed_commit"]
    manifest["findings"] = derive_findings(rows)
    manifest["result"] = derive_result(rows, mode)
    return manifest


def manifest_path(local: bool) -> Path:
    return LOCAL_MANIFEST_PATH if local else SERVED_MANIFEST_PATH


def check(*, local: bool, git: GitOracle | None = None) -> str:
    path = manifest_path(local)
    if not path.exists():
        if local:
            refuse("absent-capture-file", f"the local proof is absent at {path.relative_to(ROOT)}")
        refuse("absent-served-capture", f"no served capture is recorded at {path.relative_to(ROOT)}")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    result = validate_manifest(manifest, mode=LOCAL_MODE if local else SERVED_MODE, git=git)
    if result == "pending":
        owed = sorted({row["pending_obligation"] for row in manifest["captures"] if row.get("pending_obligation")})
        refuse("pending-obligation", f"served journeys still owe positive evidence: {owed}")
    return result


def run_cli(*, base: str | None, local: bool, check_only: bool, deployment_manifest=None) -> int:  # noqa: ANN001
    manifest = None
    try:
        if check_only:
            result = check(local=local)
            print(f"ok: {SCENARIO} {'local' if local else 'served'} evidence {result}")
            return 0
        manifest = capture(base=base, local=local, deployment_manifest=deployment_manifest)
        # Refuse before writing: a failing or unprovable run never becomes retained evidence.
        validate_manifest(manifest, mode=manifest["capture_mode"], delivery=None if local else load_delivery())
        path = manifest_path(local)
        EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps({
            "result": manifest["result"],
            "manifest": path.relative_to(ROOT).as_posix(),
            "captures": len(manifest["captures"]),
            "capture_run_id": manifest["capture_run_id"],
            "local_images": (IMAGE_DIR / manifest["capture_run_id"]).as_posix(),
        }, indent=2))
        return PENDING_EXIT if manifest["result"] == "pending" else 0
    except JourneyEvidenceError as error:
        if manifest is not None:
            # Exact observations of a refused run stay inspectable, outside the repository.
            refused = ROOT / IMAGE_DIR / manifest["capture_run_id"] / "refused-manifest.json"
            refused.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"refused run observations: {refused.relative_to(ROOT).as_posix()}", file=sys.stderr)
        print(f"{'pending' if error.pending else 'refused'}: {error}", file=sys.stderr)
        return PENDING_EXIT if error.pending else 1
