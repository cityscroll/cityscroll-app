#!/usr/bin/env python3
"""Production read-back for Brooklyn 14 identical-referral naming.

Hits the live served origin with headless Chromium. Records the page-extracted
referral text for both served answers on the Cortelyou library request, the
page text that names their sameness, the agency-specific rank and fiscal year,
and the board / agency / fiscal-year context that survives return from the
inspect detail.

Refuses a receipt when the sameness text is absent, either referral cannot be
read, the two referrals differ, or a withheld diagnostic publication appears on
the request. ``--mutation-control`` removes the sameness text in-page and
expects that refusal.

Commits textual receipts under docs/evidence/board-budget-requests-same-referral/.
Optional screenshots stay under the task scratch directory.
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
from urllib.parse import urlparse

from deployed_capture_ancestor import (
    load_recorded_delivery,
    resolve_landed_ancestor,
    revision_contains_ancestor,
)

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "docs/evidence/board-budget-requests-same-referral"
MANIFEST = OUT_DIR / "capture-manifest.json"
PRODUCTION = OUT_DIR / "production-read.json"
READBACK = OUT_DIR / "read-back.json"
DELIVERY = OUT_DIR / "delivery.json"
SCRATCH = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "board-budget-requests-same-referral-production"

PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_MANIFEST_PATH = "/artifact-manifest.json"
ARTIFACT_UA = "cityscroll-board-budget-requests-same-referral-capture/1"
DEFAULT_BASE = "https://cityscroll.org/"
PUBLIC_ALIAS = "cc479983fe385"
SCHEMA = "cityscroll.board_budget_requests_same_referral_production_read.v1"
PRODUCER_PATH = "docs/evidence/board-budget-requests-same-referral/read-back.json"
DATA_VINTAGE = (
    "community_board_budget_register as_of 2026-09-07; "
    "servable publications 20260512 and 20260630; "
    "diagnostic-only publication 20270217 withheld"
)
REQUIRED_ANCESTOR = load_recorded_delivery(DELIVERY)

VIEWPORTS = (
    ("desktop", 1440, 900),
    ("mobile", 390, 844),
)

BOARD_ID = "brooklyn-cb-14"
TRACKING_CODE = "214202702C"
AGENCY_SCOPE = "named-brooklyn-public-library"
BOARD_SECTION = "#board-budget-requests"
ROW = f'li.board-budget-request[data-tracking-code="{TRACKING_CODE}"]'
INSPECT = f"{ROW} button.board-budget-request-inspect"
DIALOG = "#budget-request-inspect"
SCOPE_FRAGMENT = f"board-budget-requests-{AGENCY_SCOPE}"
ROUTE = f"/community-boards/{BOARD_ID}/#{SCOPE_FRAGMENT}"

# Page-extracted fields — never filled from an expected constant the tool holds.
PAGE_EXTRACTED_FIELDS = (
    "referral_earlier",
    "referral_later",
    "sameness_text",
    "rank_text",
    "fiscal_year_text",
    "fiscal_year_attr",
    "tracking_code",
    "agency_scope_after_return",
    "board_path_after_return",
)

READ_ROW_JS = """(trackingCode) => {
  const row = document.querySelector(
    `li.board-budget-request[data-tracking-code="${trackingCode}"]`
  );
  if (!row) return null;
  const textOf = (node) => (node ? String(node.innerText || node.textContent || "").trim() : "");
  const answers = [...row.querySelectorAll(".board-budget-request-answer")].map((node) => ({
    publication: node.getAttribute("data-publication") || "",
    state: node.getAttribute("data-answer-state") || "",
    date: textOf(node.querySelector(".board-budget-request-answer-date")),
    text: textOf(node.querySelector(".board-budget-request-answer-text")),
    note: textOf(node.querySelector(".board-budget-request-answer-note")),
  }));
  const section = document.querySelector("#board-budget-requests");
  return {
    tracking_code: row.getAttribute("data-tracking-code") || "",
    fiscal_year_attr: row.getAttribute("data-fiscal-year") || "",
    rank_text: textOf(row.querySelector(".board-budget-request-rank")),
    fiscal_year_text: textOf(row.querySelector(".board-budget-request-fiscal-year")),
    answers,
    row_text: textOf(row),
    section_publication_count: section
      ? section.getAttribute("data-publication-count") || ""
      : "",
    diagnostic_answer_on_row: /Agency supports but cannot accommodate/i.test(row.innerText || ""),
    diagnostic_publication_attr_present: Boolean(
      row.querySelector('.board-budget-request-answer[data-publication="20270217"]')
    ),
  };
}"""

REMOVE_SAMENESS_JS = """(trackingCode) => {
  const row = document.querySelector(
    `li.board-budget-request[data-tracking-code="${trackingCode}"]`
  );
  if (!row) return 0;
  const notes = [...row.querySelectorAll(".board-budget-request-answer-note")];
  for (const note of notes) note.remove();
  return notes.length;
}"""


def normalize_base(base: str) -> str:
    return base.rstrip("/") + "/"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_ws(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip())


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
            content_type = (response.headers.get("Content-Type") or "").lower()
            if "json" not in content_type and "javascript" not in content_type:
                raise RuntimeError(
                    f"artifact-manifest at {url} returned unexpected content-type {content_type!r}"
                )
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


def revision_is_ancestor_of_head(revision: str, *, cwd: Path = ROOT) -> bool:
    tip = subprocess.run(
        ["git", "-C", str(cwd), "rev-parse", "HEAD"],
        check=False,
        capture_output=True,
        text=True,
    )
    if tip.returncode != 0:
        return False
    head = tip.stdout.strip()
    if head == revision:
        return True
    check = subprocess.run(
        ["git", "-C", str(cwd), "merge-base", "--is-ancestor", revision, "HEAD"],
        check=False,
        capture_output=True,
        text=True,
    )
    return check.returncode == 0


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def assert_identical_referrals(observed: dict, *, case_name: str) -> dict:
    """Refuse unless both referrals are readable, identical, and named as the same."""

    if not isinstance(observed, dict):
        raise AssertionError(f"{case_name}: request row unreadable from the page")
    answers = observed.get("answers") or []
    if len(answers) < 2:
        raise AssertionError(
            f"{case_name}: expected two served answers on the page, got {len(answers)}"
        )
    earlier = answers[0]
    later = answers[1]
    referral_earlier = normalize_ws(earlier.get("text") or "")
    referral_later = normalize_ws(later.get("text") or "")
    if not referral_earlier:
        raise AssertionError(f"{case_name}: earlier referral text unreadable from the page")
    if not referral_later:
        raise AssertionError(f"{case_name}: later referral text unreadable from the page")
    if referral_earlier != referral_later:
        raise AssertionError(
            f"{case_name}: served referrals differ; this capture answers a same-referral "
            f"comparison, not a changed-answer contrast "
            f"(earlier={referral_earlier!r} later={referral_later!r})"
        )
    sameness_text = normalize_ws(later.get("note") or "")
    if not sameness_text:
        raise AssertionError(f"{case_name}: sameness text absent from the rendered page")
    if not re.search(r"reads the same|se lee igual|lit (?:comme|à l)", sameness_text, re.I):
        raise AssertionError(
            f"{case_name}: sameness text does not name the answers as the same: {sameness_text!r}"
        )
    if observed.get("diagnostic_answer_on_row") or observed.get("diagnostic_publication_attr_present"):
        raise AssertionError(
            f"{case_name}: withheld diagnostic publication appeared on the served request"
        )
    rank_text = normalize_ws(observed.get("rank_text") or "")
    fiscal_year_text = normalize_ws(observed.get("fiscal_year_text") or "")
    fiscal_year_attr = str(observed.get("fiscal_year_attr") or "").strip()
    if not rank_text or "Priority" not in rank_text:
        raise AssertionError(f"{case_name}: agency-specific rank unreadable from the page")
    if "2027" not in fiscal_year_text and fiscal_year_attr != "2027":
        raise AssertionError(f"{case_name}: FY2027 unreadable from the page")
    tracking_code = str(observed.get("tracking_code") or "").strip()
    if tracking_code != TRACKING_CODE:
        raise AssertionError(
            f"{case_name}: tracking code from page {tracking_code!r} is not {TRACKING_CODE}"
        )
    return {
        "referral_earlier": referral_earlier,
        "referral_later": referral_later,
        "sameness_text": sameness_text,
        "rank_text": rank_text,
        "fiscal_year_text": fiscal_year_text,
        "fiscal_year_attr": fiscal_year_attr,
        "tracking_code": tracking_code,
        "publication_earlier": earlier.get("publication") or "",
        "publication_later": later.get("publication") or "",
        "answer_date_earlier": normalize_ws(earlier.get("date") or ""),
        "answer_date_later": normalize_ws(later.get("date") or ""),
        "section_publication_count": str(observed.get("section_publication_count") or ""),
        "diagnostic_publication_served": False,
        "page_extracted_fields": list(PAGE_EXTRACTED_FIELDS),
    }


def open_specimen(page, base: str, *, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{normalize_base(base).rstrip('/')}{ROUTE}", wait_until="load")
    page.wait_for_selector(BOARD_SECTION, timeout=30000)
    page.wait_for_selector(ROW, timeout=30000)
    # Choosing the agency is an ordinary fragment navigation; re-assert it so a
    # collapsed group opens the way a reader reaches the request.
    page.locator(f'{BOARD_SECTION} a[href="#{SCOPE_FRAGMENT}"]').first.click()
    page.wait_for_timeout(150)
    page.locator(ROW).first.scroll_into_view_if_needed()


def capture_viewport(
    page,
    *,
    base: str,
    name: str,
    width: int,
    height: int,
    rev: str,
    mutate_sameness: bool = False,
) -> dict:
    open_specimen(page, base, width=width, height=height)
    scope_before = urlparse(page.url).fragment
    path_before = urlparse(page.url).path
    if scope_before != SCOPE_FRAGMENT:
        raise AssertionError(
            f"{name}: agency scope fragment before detail was {scope_before!r}, "
            f"expected {SCOPE_FRAGMENT!r}"
        )

    if mutate_sameness:
        removed = page.evaluate(REMOVE_SAMENESS_JS, TRACKING_CODE)
        if not removed:
            raise AssertionError(
                f"{name}: failed to remove sameness text for mutation control"
            )

    raw = page.evaluate(READ_ROW_JS, TRACKING_CODE)
    served = assert_identical_referrals(raw, case_name=name)

    # Return from the inspect detail with board, agency and fiscal-year context intact.
    button = page.locator(INSPECT).first
    button.scroll_into_view_if_needed()
    button.click()
    page.wait_for_timeout(150)
    dialog = page.locator(DIALOG)
    if not dialog.evaluate("node => Boolean(node && node.open)"):
        raise AssertionError(f"{name}: inspect detail did not open")
    page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    if dialog.evaluate("node => Boolean(node && node.open)"):
        raise AssertionError(f"{name}: inspect detail did not dismiss")

    scope_after = urlparse(page.url).fragment
    path_after = urlparse(page.url).path
    raw_after = page.evaluate(READ_ROW_JS, TRACKING_CODE)
    after = assert_identical_referrals(raw_after, case_name=f"{name}-after-return")
    if scope_after != SCOPE_FRAGMENT:
        raise AssertionError(
            f"{name}: agency scope did not survive return from detail "
            f"(after={scope_after!r})"
        )
    if path_after != path_before:
        raise AssertionError(
            f"{name}: board path did not survive return from detail "
            f"(before={path_before!r} after={path_after!r})"
        )
    if after["fiscal_year_attr"] != served["fiscal_year_attr"]:
        raise AssertionError(f"{name}: fiscal-year attribute changed after return from detail")
    if after["rank_text"] != served["rank_text"]:
        raise AssertionError(f"{name}: agency-specific rank changed after return from detail")

    served_values = {
        **served,
        "agency_scope_before_detail": scope_before,
        "agency_scope_after_return": scope_after,
        "board_path_before_detail": path_before,
        "board_path_after_return": path_after,
        "filters_survived_detail_return": True,
        "page_extracted_fields": list(PAGE_EXTRACTED_FIELDS),
    }
    if "result" in served_values or "pass" in served_values:
        raise AssertionError("served_values must not carry a pass verdict")

    screenshot_name = f"same-referral-{name}-{width}x{height}.png"
    SCRATCH.mkdir(parents=True, exist_ok=True)
    screenshot_path = SCRATCH / screenshot_name
    page.screenshot(path=str(screenshot_path), full_page=False)
    screenshot_sha256 = hashlib.sha256(screenshot_path.read_bytes()).hexdigest()

    return {
        "name": f"brooklyn-14-cortelyou-same-referral-{name}",
        "clause": "identical_referrals_named_on_served_page",
        "route": ROUTE,
        "board_id": BOARD_ID,
        "tracking_code": TRACKING_CODE,
        "agency_scope": AGENCY_SCOPE,
        "viewport": {"name": name, "width": width, "height": height},
        "revision": rev,
        "data_vintage": DATA_VINTAGE,
        "source": "headless-playwright-production-served-site",
        "screenshot_file": None,
        "screenshot_sha256": screenshot_sha256,
        "local_image_dir_ignored": "task-scratch/board-budget-requests-same-referral-production",
        "image_binaries_committed": False,
        "render_sha256": sha256_text(json.dumps(served_values, sort_keys=True)),
        "served_values": served_values,
        "assertion": (
            f"{ROUTE} at {width}x{height}: both served answers for {TRACKING_CODE} carry the "
            "same elected-officials referral text read from the page, the page names that "
            "sameness, agency-specific rank and FY2027 remain visible, and board/agency/"
            "fiscal-year context survives return from the inspect detail; the withheld "
            "diagnostic publication is not served on the request."
        ),
    }


def build_receipt(
    *,
    base: str,
    artifact: dict,
    rev: str,
    observed_at: str,
    reads: list[dict],
) -> dict:
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
            "required_ancestor_on_default_branch": True,
            "capture_revision_ancestor_of_head": revision_is_ancestor_of_head(rev),
        },
        "capture": {
            "tool": "tools/capture_board_budget_requests_same_referral_production_read.py",
            "browser": "chromium",
            "viewports": [{"name": n, "width": w, "height": h} for n, w, h in VIEWPORTS],
            "screenshot_binaries_committed": False,
            "page_extracted_fields": list(PAGE_EXTRACTED_FIELDS),
            "specimen": {
                "board_id": BOARD_ID,
                "tracking_code": TRACKING_CODE,
                "agency_scope": AGENCY_SCOPE,
                "route": ROUTE,
            },
            "diagnostic_publication_withheld": "20270217",
        },
        "producer": {
            "path": PRODUCER_PATH,
            "schema": SCHEMA,
            "letters": ["A1"],
        },
        "letters": {
            "A1": {
                "clause": "identical_referrals_named_on_served_page",
                "route": ROUTE,
                "reads": reads,
            }
        },
        "reads": reads,
        "summary": {
            "case_count": len(reads),
            "capture_count": len(reads),
            "letter": "A1",
            "tracking_code": TRACKING_CODE,
            "board_id": BOARD_ID,
        },
    }


def build_manifest(receipt: dict) -> dict:
    rev = receipt["deployment"]["revision"]
    captures = list(((receipt.get("letters") or {}).get("A1") or {}).get("reads") or [])
    return {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "board-budget-requests-same-referral",
        "public_alias": PUBLIC_ALIAS,
        "surface": "Brooklyn 14 identical referral naming on served budget-request answers",
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
        "required_ancestor": REQUIRED_ANCESTOR,
        "required_ancestor_contained": True,
        "capture_revision_ancestor_of_head": receipt["deployment"].get(
            "capture_revision_ancestor_of_head"
        ),
        "data_vintage": DATA_VINTAGE,
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; "
            "only this manifest is committed."
        ),
        "note": (
            "Production desktop/mobile receipts for the Brooklyn Community Board 14 "
            f"request {TRACKING_CODE}: both served answers carry the same elected-officials "
            "referral, the page names that sameness, and board/agency/fiscal-year context "
            "survives return from inspect detail. The diagnostic-only publication is not served."
        ),
        "verifier": (
            "node --test test/board_budget_requests_same_referral_production_read.test.mjs"
        ),
        "producer": receipt["producer"],
        "page_extracted_fields": list(PAGE_EXTRACTED_FIELDS),
        "captures": captures,
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
        raise AssertionError("deployment.required_ancestor_contained must be true")
    if not revision_contains_ancestor(REQUIRED_ANCESTOR, deployment["revision"], cwd=ROOT):
        raise AssertionError(
            f"served revision {deployment['revision']} does not contain required ancestor "
            f"{REQUIRED_ANCESTOR}"
        )
    resolve_landed_ancestor(REQUIRED_ANCESTOR, cwd=ROOT)
    if deployment.get("capture_revision_ancestor_of_head") is not True:
        if not revision_is_ancestor_of_head(deployment["revision"]):
            raise AssertionError(
                f"capture revision {deployment['revision']} is not an ancestor of HEAD"
            )
    producer = receipt.get("producer") or {}
    if producer.get("path") != PRODUCER_PATH:
        raise AssertionError("producer path mismatch")
    if producer.get("letters") != ["A1"]:
        raise AssertionError("producer letters mismatch")
    a1 = ((receipt.get("letters") or {}).get("A1") or {})
    if a1.get("clause") != "identical_referrals_named_on_served_page":
        raise AssertionError("A1 clause mismatch")
    reads = a1.get("reads") or []
    if len(reads) < 2:
        raise AssertionError("A1 requires desktop and mobile served reads")
    page_fields = set(PAGE_EXTRACTED_FIELDS)
    for row in reads:
        values = row.get("served_values")
        if not isinstance(values, dict) or not values:
            raise AssertionError(f"{row.get('name')}: served_values missing observed text")
        for field in (
            "referral_earlier",
            "referral_later",
            "sameness_text",
            "rank_text",
            "fiscal_year_text",
            "agency_scope_after_return",
            "board_path_after_return",
        ):
            if not values.get(field):
                raise AssertionError(f"{row.get('name')}: missing page-extracted {field}")
        if values["referral_earlier"] != values["referral_later"]:
            raise AssertionError(f"{row.get('name')}: referrals differ in retained receipt")
        if values.get("diagnostic_publication_served") is not False:
            raise AssertionError(f"{row.get('name')}: diagnostic publication must remain unserved")
        if values.get("filters_survived_detail_return") is not True:
            raise AssertionError(f"{row.get('name')}: filters did not survive detail return")
        if values.get("agency_scope_after_return") != SCOPE_FRAGMENT:
            raise AssertionError(f"{row.get('name')}: agency scope after return mismatch")
        recorded_fields = set(values.get("page_extracted_fields") or [])
        if not page_fields.issubset(recorded_fields):
            raise AssertionError(
                f"{row.get('name')}: page_extracted_fields missing "
                f"{sorted(page_fields - recorded_fields)}"
            )
        if "result" in values or "pass" in values:
            raise AssertionError("served_values must not carry a pass verdict")
        if row.get("revision") != deployment["revision"]:
            raise AssertionError(f"{row.get('name')}: row revision mismatch")
        if row.get("image_binaries_committed") is not False:
            raise AssertionError("image binaries must not be committed")


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
    if production.get("producer", {}).get("letters") != ["A1"]:
        raise AssertionError("production-read producer letters mismatch")
    if not ((production.get("letters") or {}).get("A1") or {}).get("reads"):
        raise AssertionError("production-read missing A1 reads")
    assert_canonical_json(PRODUCTION)
    manifest = load_json(MANIFEST)
    if manifest.get("public_alias") != PUBLIC_ALIAS:
        raise AssertionError("capture-manifest public_alias mismatch")
    if manifest.get("producer", {}).get("letters") != ["A1"]:
        raise AssertionError("capture-manifest producer letters mismatch")
    if manifest.get("page_extracted_fields") != list(PAGE_EXTRACTED_FIELDS):
        raise AssertionError("capture-manifest must record page_extracted_fields")
    assert_canonical_json(MANIFEST)
    a1_names = {row["name"] for row in receipt["letters"]["A1"]["reads"]}
    manifest_names = {row.get("name") for row in manifest.get("captures") or []}
    if not a1_names.issubset(manifest_names):
        raise AssertionError("capture-manifest missing A1 captures")
    print(
        f"board-budget-requests-same-referral A1 check passed: {READBACK.relative_to(ROOT)}"
    )


def capture(*, mutation_control: bool = False) -> dict:
    from playwright.sync_api import sync_playwright

    base = resolve_base()
    artifact = read_artifact_manifest(base)
    rev = deployed_revision(artifact)
    resolve_landed_ancestor(REQUIRED_ANCESTOR, cwd=ROOT)
    if not revision_contains_ancestor(REQUIRED_ANCESTOR, rev, cwd=ROOT):
        raise RuntimeError(
            f"served revision {rev} does not contain required ancestor {REQUIRED_ANCESTOR}"
        )
    if not revision_is_ancestor_of_head(rev):
        raise RuntimeError(
            f"served revision {rev} is not an ancestor of HEAD; refresh evidence against a "
            "revision already contained in this checkout"
        )
    observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    print(
        f"production base={base} revision={rev} ancestor={REQUIRED_ANCESTOR}",
        flush=True,
    )

    reads: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (compatible; CityScrollCapture/1.0)",
            reduced_motion="reduce",
        )
        page = context.new_page()
        for name, width, height in VIEWPORTS:
            print(
                f"same-referral A1 {TRACKING_CODE} {name}"
                + (" MUTATION" if mutation_control else ""),
                flush=True,
            )
            reads.append(
                capture_viewport(
                    page,
                    base=base,
                    name=name,
                    width=width,
                    height=height,
                    rev=rev,
                    mutate_sameness=bool(mutation_control),
                )
            )
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
    parser.add_argument(
        "--mutation-control",
        action="store_true",
        help=(
            "Deliberately remove the sameness note from the rendered request and "
            "expect the capture to refuse. Proves the assertion depends on that text."
        ),
    )
    args = parser.parse_args()
    if args.check:
        check()
        return 0

    if args.mutation_control:
        try:
            capture(mutation_control=True)
        except AssertionError as error:
            message = str(error)
            if (
                "sameness text absent" in message
                or "referral text unreadable" in message
                or "referrals differ" in message
            ):
                print(f"mutation-control refused as expected: {error}", flush=True)
                return 0
            raise
        print("mutation-control unexpectedly succeeded", file=sys.stderr)
        return 1

    receipt = capture()
    write_json(READBACK, receipt)
    write_json(PRODUCTION, receipt)
    write_json(MANIFEST, build_manifest(receipt))
    print(f"wrote {READBACK.relative_to(ROOT)}", flush=True)
    print(f"wrote {PRODUCTION.relative_to(ROOT)}", flush=True)
    print(f"wrote {MANIFEST.relative_to(ROOT)}", flush=True)
    for row in receipt["letters"]["A1"]["reads"]:
        values = row["served_values"]
        print(
            f"  {row['name']}: sameness={values['sameness_text']!r} "
            f"rank={values['rank_text']!r}",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(exc, file=sys.stderr)
        raise
