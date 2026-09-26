"""Guards for production captures that wait on a landed Pages revision.

Capture tools pin a required ancestor that must already be reachable from the
default branch — typically the squash-merge commit that delivered the feature.
A pre-squash branch tip is rejected as a wrong pin (it can never become an
ancestor of a served revision). The served revision is read from the Pages
artifact manifest at ``/artifact-manifest.json`` (the page-rendering surface),
which is distinct from the Worker deploy revision.
"""

from __future__ import annotations

import json
import re
import subprocess
import urllib.request
from pathlib import Path
from typing import Callable

PAGE_ARTIFACT_MANIFEST = "/artifact-manifest.json"
DEFAULT_BRANCH_REF = "origin/main"
DELIVERY_SCHEMA = "cityscroll.capture_delivery.v1"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class CaptureAncestorError(Exception):
    """Base error for capture ancestor guards."""


class WrongPinError(CaptureAncestorError):
    """REQUIRED_ANCESTOR is not reachable from the default branch."""


class DeployPendingError(CaptureAncestorError):
    """Served page revision does not yet contain the landed ancestor."""


class ServedDataMissingError(CaptureAncestorError):
    """Served Pages data lacks a required subject/location assertion."""


SHARED_MEETING_READ_MODEL = "/data/shared_meeting_read_model.json"
SUBJECT_PROPERTY_ROLE = "subject_property"


def _git(cwd: Path | str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=False,
        capture_output=True,
        text=True,
    )


def _require_sha(value: str, *, label: str) -> str:
    sha = (value or "").strip().lower()
    if not SHA_RE.fullmatch(sha):
        raise WrongPinError(f"{label} is not a 40-hex commit SHA ({value!r})")
    return sha


def load_recorded_delivery(path: Path | str) -> str:
    """Return the landed delivery commit recorded beside a capture feature."""

    delivery_path = Path(path)
    try:
        payload = json.loads(delivery_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise WrongPinError(f"recorded delivery missing at {delivery_path}") from error
    except json.JSONDecodeError as error:
        raise WrongPinError(f"recorded delivery is not valid JSON at {delivery_path}") from error
    if not isinstance(payload, dict):
        raise WrongPinError(f"recorded delivery must be an object at {delivery_path}")
    if payload.get("schema") != DELIVERY_SCHEMA:
        raise WrongPinError(
            f"recorded delivery schema must be {DELIVERY_SCHEMA!r} at {delivery_path}"
        )
    surface = payload.get("surface")
    if surface not in (None, "pages", "page"):
        raise WrongPinError(
            f"recorded delivery surface must be pages (page-rendering), got {surface!r}"
        )
    return _require_sha(str(payload.get("landed_commit") or ""), label="recorded delivery landed_commit")


def resolve_landed_ancestor(
    pin: str,
    *,
    cwd: Path | str,
    main_ref: str = DEFAULT_BRANCH_REF,
) -> str:
    """Return ``pin`` after proving it is reachable from the default branch.

    A pin that is not an ancestor of ``origin/main`` (or ``main_ref``) is a
    wrong pin — typically a pre-squash branch tip — and must not be reported as
    "wait for deploy".
    """

    ancestor = _require_sha(pin, label="required ancestor pin")
    tip = _git(cwd, "rev-parse", "--verify", f"{main_ref}^{{commit}}")
    if tip.returncode != 0:
        raise WrongPinError(
            f"default branch ref {main_ref} is unavailable; cannot validate required ancestor pin {ancestor}"
        )
    if ancestor == tip.stdout.strip():
        return ancestor
    check = _git(cwd, "merge-base", "--is-ancestor", ancestor, main_ref)
    if check.returncode != 0:
        raise WrongPinError(
            f"required ancestor pin {ancestor} is not reachable from the default branch "
            f"({main_ref}); the pin is wrong (often a pre-squash branch tip). "
            "Record the landed squash-merge commit on the default branch instead of waiting for deploy."
        )
    return ancestor


def revision_contains_ancestor(
    ancestor: str,
    rev: str,
    *,
    cwd: Path | str,
) -> bool:
    """True when ``rev`` is ``ancestor`` or a descendant of it."""

    ancestor_sha = _require_sha(ancestor, label="ancestor")
    revision = _require_sha(rev, label="served revision")
    if revision == ancestor_sha:
        return True
    check = _git(cwd, "merge-base", "--is-ancestor", ancestor_sha, revision)
    return check.returncode == 0


def default_fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "cityscroll-deployed-capture-ancestor/1"})
    with urllib.request.urlopen(req, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise DeployPendingError(f"served page artifact-manifest is not an object: {url}")
    return payload


def served_page_revision(
    base: str,
    *,
    fetch_json: Callable[[str], dict] | None = None,
) -> str:
    """Read ``source_commit_sha`` from the Pages artifact-manifest (page surface)."""

    fetcher = fetch_json or default_fetch_json
    normalized = base if base.endswith("/") else f"{base}/"
    url = urllib.request.urljoin(normalized, PAGE_ARTIFACT_MANIFEST.lstrip("/"))
    manifest = fetcher(url)
    sha = manifest.get("source_commit_sha") or ""
    if not SHA_RE.fullmatch(str(sha)):
        raise DeployPendingError(f"served page artifact-manifest missing source_commit_sha: {manifest!r}")
    return str(sha)


def require_served_page_revision_contains_delivery(
    base: str,
    pin: str,
    *,
    cwd: Path | str,
    main_ref: str = DEFAULT_BRANCH_REF,
    fetch_json: Callable[[str], dict] | None = None,
) -> str:
    """Refuse capture until the served Pages revision contains a landed ancestor.

    Distinguishes a wrong pin (not on the default branch) from a genuine
    wait-for-Pages-deploy condition.
    """

    ancestor = resolve_landed_ancestor(pin, cwd=cwd, main_ref=main_ref)
    revision = served_page_revision(base, fetch_json=fetch_json)
    if not revision_contains_ancestor(ancestor, revision, cwd=cwd):
        raise DeployPendingError(
            f"served page revision {revision} does not contain required ancestor "
            f"{ancestor}; wait for Pages deploy before capturing"
        )
    return revision


def _meeting_rows(payload: dict) -> list:
    if isinstance(payload.get("rows"), list):
        return payload["rows"]
    if isinstance(payload.get("hearings"), list):
        return payload["hearings"]
    return []


def meeting_has_subject_assertions(
    row: dict | None,
    *,
    subject_address: str | None = None,
) -> bool:
    """True when a shared-meeting row carries subject assertions or places."""

    if not isinstance(row, dict):
        return False
    needle = (subject_address or "").strip().lower()

    def _address_match(value: object) -> bool:
        text = str(value or "").strip().lower()
        if not text:
            return False
        if not needle:
            return True
        return needle in text

    for assertion in row.get("location_assertions") or []:
        if not isinstance(assertion, dict):
            continue
        if assertion.get("role") != SUBJECT_PROPERTY_ROLE:
            continue
        if _address_match(assertion.get("original_address")):
            return True
    for place in row.get("agenda_subject_places") or []:
        if not isinstance(place, dict):
            continue
        if _address_match(place.get("original_address") or place.get("address")):
            return True
    return False


def require_served_meeting_subject_assertions(
    base: str,
    *,
    meeting_id: str,
    subject_address: str,
    fetch_json: Callable[[str], dict] | None = None,
) -> dict:
    """Refuse capture when the served shared meeting catalog lacks subject data.

    This is a data precondition beside the landed-ancestor code check. A missing
    subject assertion or agenda_subject_places projection means the Pages-served
    catalog was published without the producer retaining upstream subject
    admissions — not a pending code deploy by itself.
    """

    if not meeting_id or not subject_address:
        raise ServedDataMissingError(
            "served meeting subject precondition requires meeting_id and subject_address"
        )
    fetcher = fetch_json or default_fetch_json
    normalized = base if base.endswith("/") else f"{base}/"
    url = urllib.request.urljoin(normalized, SHARED_MEETING_READ_MODEL.lstrip("/"))
    payload = fetcher(url)
    if not isinstance(payload, dict):
        raise ServedDataMissingError(
            f"served shared meeting catalog is not an object at {url}"
        )
    row = next((item for item in _meeting_rows(payload) if item.get("meeting_id") == meeting_id), None)
    if row is None:
        raise ServedDataMissingError(
            f"served shared meeting catalog is missing meeting_id {meeting_id}; "
            "subject-property assertions cannot be verified"
        )
    if meeting_has_subject_assertions(row, subject_address=subject_address):
        return row
    raise ServedDataMissingError(
        "served shared meeting catalog lacks subject_property location_assertions "
        f"and agenda_subject_places for {meeting_id} ({subject_address}); "
        "the Pages publish slim dropped or never emitted the upstream subject "
        "admissions the meeting-detail renderer reads"
    )
