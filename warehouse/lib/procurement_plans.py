"""Pure normalization and bridge-gating helpers for procurement plans (RC-1)."""

from __future__ import annotations

import hashlib
import html
import json
import re
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urljoin


USEFULNESS_THRESHOLD = 0.30
PRECISION_THRESHOLD = 0.95
# Shared with worker/src/lib/passport_join.mjs — EPIN/PIN prefix strategies.
EPIN_PREFIX_MIN_LEN = 8
SUFFIX_RE = re.compile(r"^(.+?)([A-Z]\d{3,4})$")
REST_OK_RE = re.compile(r"^(?:\d+|[A-Z]\d{2,6}|[A-Z]{1,2}\d{2,6})+$")
DETERMINISTIC_METHODS = frozenset({
    "deterministic_identifier",
    "pin_prefix_of_epin",
    "epin_prefix_of_pin",
    "pin_strip_suffix",
})
CONTENT_STOPWORDS = {
    "and", "the", "for", "from", "with", "into", "services", "service",
    "goods", "city", "new", "york", "contract", "procurement", "project",
    "program", "annual", "support", "provide", "providing", "phase",
}


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = html.unescape(str(value)).replace("\u00a0", " ")
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def comparison_key(value: Any) -> str:
    text = clean_text(value) or ""
    text = text.upper().replace("&", " AND ").replace("’", "'")
    text = re.sub(r"[^A-Z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def identifier_key(value: Any) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", str(value or "")).upper()


def strip_one_suffix(value: Any) -> str | None:
    """Strip one trailing amendment/renewal-style suffix (A001, R001, …)."""
    key = identifier_key(value)
    match = SUFFIX_RE.match(key)
    return match.group(1) if match else None


def rest_ok_for_prefix_join(rest: str | None) -> bool:
    """Honest task/line tail after a proper PIN/EPIN prefix (product passport join)."""
    if rest is None or rest == "":
        return True
    return bool(REST_OK_RE.match(str(rest)))


def join_plan_id_to_target_ids(
    plan_id: str,
    target_exact: set[str],
    target_by_prefix: dict[str, list[str]],
) -> list[tuple[str, str]]:
    """Join one plan identifier to target ids using product passport strategies.

    Strategies (same order as worker/src/lib/passport_join.mjs joinPinToEpin):
      exact | pin_strip_suffix | epin_prefix_of_pin | pin_prefix_of_epin

    Returns list of (method, matched_target_id) without inventing weak shared-prefix
    body collisions. Multiple task-order EPINs under one plan PIN are all returned.
    """
    pin = identifier_key(plan_id)
    if not pin:
        return []
    hits: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(method: str, target_id: str) -> None:
        if target_id and target_id not in seen:
            seen.add(target_id)
            hits.append((method, target_id))

    if pin in target_exact:
        add("deterministic_identifier", pin)

    stripped = strip_one_suffix(pin)
    if stripped and stripped in target_exact:
        add("pin_strip_suffix", stripped)
    if stripped:
        stripped2 = strip_one_suffix(stripped)
        if stripped2 and stripped2 in target_exact:
            add("pin_strip_suffix", stripped2)

    # Target id is a proper prefix of the plan id (EPIN prefix of longer PIN).
    for length in range(min(len(pin) - 1, 20), EPIN_PREFIX_MIN_LEN - 1, -1):
        cand = pin[:length]
        if cand not in target_exact:
            continue
        rest = pin[length:]
        if rest_ok_for_prefix_join(rest):
            add("epin_prefix_of_pin", cand)
            break

    # Plan id is a proper prefix of one or more target ids (PIN prefix of EPIN).
    for candidate_pin in (pin, stripped):
        if not candidate_pin or len(candidate_pin) < EPIN_PREFIX_MIN_LEN:
            continue
        for target_id in target_by_prefix.get(candidate_pin, []):
            rest = target_id[len(candidate_pin):]
            if rest_ok_for_prefix_join(rest):
                add("pin_prefix_of_epin", target_id)

    return hits


def iso_date(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        # Excel's 1900 date system, including its historical leap-year offset.
        if 1 <= float(value) <= 100_000:
            return (datetime(1899, 12, 30) + timedelta(days=float(value))).date().isoformat()
    text = clean_text(value)
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S.%f", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(text[:23], fmt).date().isoformat()
        except ValueError:
            pass
    return None


def parse_money(value: Any) -> float | None:
    if value is None or value == "":
        return None
    text = re.sub(r"[^0-9.()-]", "", str(value)).replace("(", "-").replace(")", "")
    try:
        amount = Decimal(text)
    except (InvalidOperation, ValueError):
        return None
    return float(amount)


def parse_quarter(value: Any) -> int | None:
    if isinstance(value, (int, float)) and int(value) == value and 1 <= int(value) <= 4:
        return int(value)
    match = re.search(r"(?:Q|QUARTER\s*)?([1-4])\b", comparison_key(value))
    return int(match.group(1)) if match else None


def content_tokens(value: Any) -> set[str]:
    tokens = re.findall(r"[a-z0-9]{4,}", (clean_text(value) or "").lower())
    return {token for token in tokens if token not in CONTENT_STOPWORDS}


def extract_published_identifiers(*values: Any) -> list[str]:
    """Extract only publisher-shaped PIN/EPIN/contract identifiers.

    MOCS Plan IDs (for example FY27NACS1) are intentionally excluded: they are
    source record identifiers, not PASSPort or City Record join keys.
    """
    text = " ".join(clean_text(value) or "" for value in values)
    patterns = (
        r"\b\d{3}[- ]?\d{2}[A-Z]\d{4,}(?:[A-Z]\d{3,4})?\b",
        r"\b(?:CT1|MA1|MMA1)-\d{3}-\d{8,}\b",
    )
    found: dict[str, str] = {}
    for pattern in patterns:
        for match in re.findall(pattern, text, flags=re.IGNORECASE):
            key = identifier_key(match)
            if len(key) >= 8:
                found.setdefault(key, clean_text(match) or key)
    return [found[key] for key in sorted(found)]


def _header_key(value: Any) -> str:
    return comparison_key(value).lower()


HEADER_ALIASES = {
    "plan_id": ("plan id", "plan id #"),
    "agency": ("agency",),
    "description": (
        "description of services to be provided",
        "description of goods and services to be procured",
        "description of services",
        "description",
    ),
    "term_start": (
        "anticipated contract start date", "anticipated contract start",
        "anticipated new start date",
    ),
    "term_end": (
        "anticipated contract end date", "anticipated contract end",
        "anticipated new end date",
    ),
    "procurement_method": (
        "anticipated procurement method", "procurement method",
        "anticipated r a method",
    ),
    "quarter": ("anticipated fiscal quarter", "fiscal quarter of solicitation"),
    "industry": ("procurement industry", "industry"),
    "estimated_amount": ("estimated amount",),
    "vendor": ("vendor", "vendor name"),
    "contract_number": ("contract number ct1 ma1 mma1 858", "contract number"),
}


def _map_headers(row: list[Any] | tuple[Any, ...]) -> dict[str, int]:
    mapped: dict[str, int] = {}
    for index, value in enumerate(row):
        key = _header_key(value)
        if not key:
            continue
        for canonical, aliases in HEADER_ALIASES.items():
            if key in aliases and canonical not in mapped:
                mapped[canonical] = index
    return mapped


def _cell(row: list[Any] | tuple[Any, ...], headers: dict[str, int], name: str) -> Any:
    index = headers.get(name)
    return row[index] if index is not None and index < len(row) else None


def _stable_record_id(source: str, plan_id: str | None, agency: str | None, description: str) -> str:
    if plan_id:
        return f"{source}:{plan_id}"
    digest = hashlib.sha256(f"{agency}|{description}".encode("utf-8")).hexdigest()[:16]
    return f"{source}:sha256:{digest}"


def normalize_plan_rows(
    rows: list[list[Any]] | list[tuple[Any, ...]],
    *,
    source: str,
    source_url: str,
    agency_hint: str | None,
    fiscal_year: int,
) -> list[dict[str, Any]]:
    """Normalize the first plan-shaped table in an XLSX sheet value matrix."""
    header_index = None
    headers: dict[str, int] = {}
    for index, row in enumerate(rows[:30]):
        # LL1 uses vertically merged headers: the description label is one row
        # above "Plan ID #" while the actual data begins under the same column.
        filled = list(row)
        for column, value in enumerate(filled):
            if clean_text(value):
                continue
            for prior in range(index - 1, max(-1, index - 3), -1):
                if column < len(rows[prior]) and clean_text(rows[prior][column]):
                    filled[column] = rows[prior][column]
                    break
        candidate = _map_headers(filled)
        if "plan_id" in candidate and "description" in candidate:
            header_index, headers = index, candidate
            break
    if header_index is None:
        return []

    normalized = []
    for row_number, row in enumerate(rows[header_index + 1 :], header_index + 2):
        plan_id = clean_text(_cell(row, headers, "plan_id"))
        description = clean_text(_cell(row, headers, "description"))
        if not description:
            continue
        agency_raw = clean_text(_cell(row, headers, "agency")) or clean_text(agency_hint)
        agency = clean_text(agency_hint) or agency_raw
        method = clean_text(_cell(row, headers, "procurement_method"))
        industry = clean_text(_cell(row, headers, "industry"))
        amount = parse_money(_cell(row, headers, "estimated_amount"))
        vendor = clean_text(_cell(row, headers, "vendor"))
        contract_number = clean_text(_cell(row, headers, "contract_number"))
        identifiers = extract_published_identifiers(description, contract_number)
        start = iso_date(_cell(row, headers, "term_start"))
        end = iso_date(_cell(row, headers, "term_end"))
        quality_flags = []
        if start and end and end < start:
            quality_flags.append("published_term_end_before_start")
        record_id = _stable_record_id(source, plan_id, agency, description)
        normalized.append({
            "source_record_id": record_id,
            "source": source,
            "source_url": source_url,
            "source_row": row_number,
            "fiscal_year": fiscal_year,
            "plan_id": plan_id,
            "agency": agency,
            "agency_raw": agency_raw,
            "agency_key": comparison_key(agency_raw or agency),
            "description": description,
            "procurement_method": method,
            "industry": industry,
            "term_start": start,
            "term_end": end,
            "quarter": parse_quarter(_cell(row, headers, "quarter")),
            "budget": (
                {"amount": amount, "currency": "USD", "basis": "estimated_amount"}
                if amount is not None else None
            ),
            "vendor": vendor,
            "published_identifiers": identifiers,
            "quality_flags": quality_flags,
        })
    return normalized


def normalize_capital_row(row: dict[str, Any]) -> dict[str, Any]:
    pid = clean_text(row.get("pid"))
    fms_id = clean_text(row.get("fms_id"))
    reporting_period = clean_text(row.get("reporting_period"))
    title = clean_text(row.get("agency_project_name") or row.get("fms_project_name"))
    description = clean_text(row.get("agency_project_description")) or title
    amount = parse_money(row.get("total_budget"))
    spend = parse_money(row.get("spend_to_date"))
    identifiers = [value for value in (fms_id,) if value]
    return {
        "source_record_id": f"capital_projects_dashboard:{reporting_period}:{pid}:{fms_id}",
        "source": "capital_projects_dashboard",
        "source_url": "https://data.cityofnewyork.us/d/fb86-vt7u",
        "reporting_period": reporting_period,
        "pid": pid,
        "fms_id": fms_id,
        "agency": clean_text(row.get("managing_agency")),
        "agency_raw": clean_text(row.get("managing_agency")),
        "agency_key": comparison_key(row.get("managing_agency")),
        "sponsor_agency": clean_text(row.get("sponsor_agency")),
        "title": title,
        "description": description,
        "procurement_method": None,
        "industry": clean_text(row.get("ten_year_plan_category")),
        "term_start": iso_date(row.get("current_phase_start") or row.get("actual_design_start")),
        "term_end": iso_date(row.get("forecast_completion")),
        "quarter": None,
        "budget": (
            {
                "amount": amount,
                "currency": "USD",
                "basis": "total_budget",
                "spend_to_date": spend,
            }
            if amount is not None else None
        ),
        "current_phase": clean_text(row.get("current_phase")),
        "borough": clean_text(row.get("borough")),
        "community_board": clean_text(row.get("community_board")),
        "published_identifiers": identifiers,
        "quality_flags": [],
    }


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.href: str | None = None
        self.parts: list[str] = []
        self.links: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a":
            return
        self.href = dict(attrs).get("href")
        self.parts = []

    def handle_data(self, data: str) -> None:
        if self.href is not None:
            self.parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a" and self.href is not None:
            self.links.append((self.href, clean_text(" ".join(self.parts)) or ""))
            self.href = None
            self.parts = []


def parse_plan_index(html_text: str, base_url: str, source: str, fiscal_year: int) -> list[dict[str, str]]:
    parser = _LinkParser()
    parser.feed(html_text)
    if source == "mocs_ll63":
        marker = f"/{fiscal_year}fy/"
    elif source == "mocs_ll1":
        marker = f"/fy{str(fiscal_year)[-2:]}/"
    else:
        raise ValueError(f"unknown plan source: {source}")
    links = []
    for href, label in parser.links:
        if marker.lower() not in href.lower() or not href.lower().endswith(".xlsx"):
            continue
        links.append({"url": urljoin(base_url, href), "label": label, "source": source})
    by_url = {item["url"]: item for item in links}
    return [by_url[url] for url in sorted(by_url)]


def title_similarity(left: Any, right: Any) -> float:
    a, b = content_tokens(left), content_tokens(right)
    if len(a) < 3 or len(b) < 3:
        return 0.0
    overlap = len(a & b)
    union = len(a | b)
    return overlap / union if union else 0.0


def _time_compatible(plan: dict[str, Any], target: dict[str, Any]) -> bool:
    target_date = iso_date(target.get("date"))
    if not target_date:
        return False
    target_day = datetime.strptime(target_date, "%Y-%m-%d").date()
    start = iso_date(plan.get("term_start"))
    end = iso_date(plan.get("term_end"))
    if start:
        start_day = datetime.strptime(start, "%Y-%m-%d").date()
        if target_day < start_day - timedelta(days=550):
            return False
        if target_day > start_day + timedelta(days=365):
            return False
    if end:
        end_day = datetime.strptime(end, "%Y-%m-%d").date()
        if target_day > end_day + timedelta(days=180):
            return False
    return bool(start or end)


def _target_group(source: str) -> str:
    return "city_record" if source == "city_record" else "passport"


def _candidate_key(plan: dict[str, Any], target: dict[str, Any]) -> str:
    return f"{plan['source_record_id']}|{target['source']}|{target['target_id']}"


def _match_candidate(
    plan: dict[str, Any],
    target: dict[str, Any],
    review_labels: dict[str, dict[str, Any]],
    *,
    id_hit: tuple[str, str] | None = None,
) -> dict[str, Any] | None:
    """Score one plan↔target pair.

    Prefer product passport identifier strategies (exact / strip-suffix / prefix)
    over agency+title+time fuzzy. Fuzzy still requires an explicit review label.
    """
    key = _candidate_key(plan, target)
    if id_hit:
        method, matched_id = id_hit
        reason = {
            "deterministic_identifier": (
                "publisher identifiers are equal after punctuation-only normalization"
            ),
            "pin_strip_suffix": (
                "plan identifier equals target after stripping one amendment/renewal suffix"
            ),
            "pin_prefix_of_epin": (
                "plan PIN is a proper prefix of the target EPIN with an honest task/line tail "
                "(product passport join pin_prefix_of_epin)"
            ),
            "epin_prefix_of_pin": (
                "target EPIN is a proper prefix of the plan PIN with an honest task/line tail "
                "(product passport join epin_prefix_of_pin)"
            ),
        }.get(method, "deterministic product identifier strategy")
        return {
            "candidate_key": key,
            "method": method,
            "identifier": matched_id,
            "score": 1.0,
            "reviewed": True,
            "accepted": True,
            "review_reason": reason,
        }

    plan_ids = {identifier_key(value) for value in plan.get("published_identifiers") or []}
    target_ids = {identifier_key(value) for value in target.get("identifiers") or []}
    shared = sorted((plan_ids & target_ids) - {""})
    if shared:
        return {
            "candidate_key": key,
            "method": "deterministic_identifier",
            "identifier": shared[0],
            "score": 1.0,
            "reviewed": True,
            "accepted": True,
            "review_reason": "publisher identifiers are equal after punctuation-only normalization",
        }

    if comparison_key(plan.get("agency")) != comparison_key(target.get("agency")):
        return None
    score = title_similarity(plan.get("description") or plan.get("title"), target.get("title"))
    if score < 0.62 or not _time_compatible(plan, target):
        return None
    label = review_labels.get(key)
    return {
        "candidate_key": key,
        "method": "agency_title_time_reviewed",
        "identifier": None,
        "score": round(score, 6),
        "reviewed": label is not None,
        "accepted": bool(label and label.get("accepted") is True),
        "review_reason": clean_text(label.get("reason")) if label else None,
    }


def _build_target_indexes(
    targets: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    target_indexes: dict[str, dict[str, Any]] = {}
    for group in ("city_record", "passport"):
        by_id: dict[str, list[dict[str, Any]]] = {}
        by_prefix: dict[str, list[str]] = {}
        exact_ids: set[str] = set()
        by_agency: dict[str, list[dict[str, Any]]] = {}
        for target in targets:
            if _target_group(str(target.get("source"))) != group:
                continue
            for raw_id in target.get("identifiers") or []:
                key = identifier_key(raw_id)
                if not key:
                    continue
                by_id.setdefault(key, []).append(target)
                exact_ids.add(key)
                for length in range(min(len(key) - 1, 20), EPIN_PREFIX_MIN_LEN - 1, -1):
                    pref = key[:length]
                    by_prefix.setdefault(pref, []).append(key)
            agency = comparison_key(target.get("agency"))
            if agency:
                by_agency.setdefault(agency, []).append(target)
        # de-dupe prefix lists while preserving order
        for pref, ids in list(by_prefix.items()):
            seen: set[str] = set()
            uniq: list[str] = []
            for item in ids:
                if item not in seen:
                    seen.add(item)
                    uniq.append(item)
            by_prefix[pref] = uniq
        target_indexes[group] = {
            "by_id": by_id,
            "by_prefix": by_prefix,
            "exact_ids": exact_ids,
            "by_agency": by_agency,
        }
    return target_indexes


def _select_plan_sample(
    plans: list[dict[str, Any]],
    source: str,
    *,
    sample_size: int,
    sample_method: str,
) -> list[dict[str, Any]]:
    """Select the kill-sample denominator for one plan source.

    sample_method:
      fixed_sorted — first N by source_record_id (legacy; often zero id-bearing)
      identifier_bearing — only plans with published PIN/EPIN identifiers
      both_report — identifier_bearing for the gate, with fixed_sorted contrast
                    recorded separately by the caller
    """
    pool = [plan for plan in plans if plan.get("source") == source]
    if sample_method in ("identifier_bearing", "both_report"):
        pool = [
            plan for plan in pool
            if any(identifier_key(v) for v in (plan.get("published_identifiers") or []))
        ]
    pool = sorted(pool, key=lambda plan: str(plan.get("source_record_id") or ""))
    if sample_size and sample_size > 0:
        return pool[:sample_size]
    return pool


def _collect_plan_matches(
    plan: dict[str, Any],
    index: dict[str, Any],
    labels: dict[str, dict[str, Any]],
) -> tuple[
    list[tuple[dict[str, Any], dict[str, Any]]],
    list[dict[str, Any]],
    int,
    int,
]:
    """Return (matches, fuzzy_cases, candidate_count, unreviewed_fuzzy_count)."""
    matches: list[tuple[dict[str, Any], dict[str, Any]]] = []
    fuzzy_cases: list[dict[str, Any]] = []
    candidates = 0
    unreviewed = 0
    candidate_targets: dict[tuple[str, str], dict[str, Any]] = {}
    id_hits_by_target: dict[tuple[str, str], tuple[str, str]] = {}

    exact_ids: set[str] = index["exact_ids"]
    by_prefix: dict[str, list[str]] = index["by_prefix"]
    by_id: dict[str, list[dict[str, Any]]] = index["by_id"]

    for raw_id in plan.get("published_identifiers") or []:
        for method, matched_id in join_plan_id_to_target_ids(raw_id, exact_ids, by_prefix):
            for target in by_id.get(matched_id, []):
                tkey = (str(target.get("source")), str(target.get("target_id")))
                candidate_targets[tkey] = target
                # Prefer exact over prefix when both fire for the same target.
                prior = id_hits_by_target.get(tkey)
                if prior is None or (
                    prior[0] != "deterministic_identifier"
                    and method == "deterministic_identifier"
                ):
                    id_hits_by_target[tkey] = (method, matched_id)

    agency = comparison_key(plan.get("agency"))
    for target in index["by_agency"].get(agency, []):
        tkey = (str(target.get("source")), str(target.get("target_id")))
        candidate_targets.setdefault(tkey, target)

    for tkey, target in candidate_targets.items():
        candidate = _match_candidate(
            plan, target, labels, id_hit=id_hits_by_target.get(tkey),
        )
        if not candidate:
            continue
        candidates += 1
        if candidate["method"] == "agency_title_time_reviewed":
            fuzzy_cases.append(candidate)
            if not candidate["reviewed"]:
                unreviewed += 1
        if candidate["accepted"]:
            matches.append((target, candidate))
    return matches, fuzzy_cases, candidates, unreviewed


def build_bridge_measurement(
    plans: list[dict[str, Any]],
    targets: list[dict[str, Any]],
    *,
    sample_size: int = 100,
    usefulness_threshold: float = USEFULNESS_THRESHOLD,
    precision_threshold: float = PRECISION_THRESHOLD,
    review_labels: dict[str, dict[str, Any]] | None = None,
    sample_method: str = "fixed_sorted",
    materialize_population: bool = False,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Measure, review, and gate each plan-source → target-source path.

    Usefulness denominators follow sample_method:
      fixed_sorted — first N plans by source_record_id (legacy default)
      identifier_bearing — only PIN/EPIN-bearing plans (correct RC-1 bridge denom)

    Prefer product passport identifier strategies (exact + prefix) over naive
    exact equality alone. Fuzzy agency+title+time still needs explicit labels.

    When materialize_population is True and a path clears usefulness + precision,
    edges are emitted for the full plan population (not only the kill sample).
    """
    labels = review_labels or {}
    source_names = ("mocs_ll63", "mocs_ll1", "capital_projects_dashboard")
    target_groups = ("city_record", "passport")
    paths: dict[str, dict[str, Any]] = {}
    accepted_by_path: dict[str, list[dict[str, Any]]] = {}
    reviewed_cases: dict[str, dict[str, Any]] = {}
    target_indexes = _build_target_indexes(targets)
    gate_method = (
        "identifier_bearing"
        if sample_method in ("identifier_bearing", "both_report")
        else "fixed_sorted"
    )

    def edge_from(plan: dict[str, Any], source: str, target: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
        return {
            "plan_source_record_id": plan["source_record_id"],
            "plan_source": source,
            "target_source": target["source"],
            "target_id": target["target_id"],
            "method": candidate["method"],
            "identifier": candidate["identifier"],
            "score": candidate["score"],
            "provenance": {
                "plan_url": plan.get("source_url"),
                "target_url": target.get("source_url"),
            },
        }

    for source in source_names:
        sample = _select_plan_sample(
            plans, source, sample_size=sample_size, sample_method=gate_method,
        )
        contrast_sample = None
        if sample_method == "both_report":
            contrast_sample = _select_plan_sample(
                plans, source, sample_size=sample_size, sample_method="fixed_sorted",
            )
        for group in target_groups:
            path_name = f"{source}_to_{group}"
            joined_plans: set[str] = set()
            path_edges: list[dict[str, Any]] = []
            unreviewed = 0
            candidates = 0
            method_counts: dict[str, int] = {}
            index = target_indexes[group]
            for plan in sample:
                matches, fuzzy_cases, cand_n, unrev_n = _collect_plan_matches(
                    plan, index, labels,
                )
                candidates += cand_n
                unreviewed += unrev_n
                for case in fuzzy_cases:
                    reviewed_cases[case["candidate_key"]] = case
                if matches:
                    joined_plans.add(str(plan["source_record_id"]))
                    for target, candidate in matches:
                        method_counts[candidate["method"]] = (
                            method_counts.get(candidate["method"], 0) + 1
                        )
                        path_edges.append(edge_from(plan, source, target, candidate))

            total = len(sample)
            joined = len(joined_plans)
            rate = joined / total if total else 0.0

            # Precision: deterministic product strategies auto-accept; fuzzy uses labels.
            # candidate_key = plan_source_record_id|target_source|target_id
            sample_ids = {str(plan.get("source_record_id") or "") for plan in sample}
            path_fuzzy = []
            for key, case in reviewed_cases.items():
                parts = key.split("|")
                if len(parts) < 3:
                    continue
                plan_id, target_source, _target_id = parts[0], parts[1], parts[2]
                if plan_id not in sample_ids:
                    continue
                if _target_group(target_source) != group:
                    continue
                if case["method"] != "agency_title_time_reviewed" or not case["reviewed"]:
                    continue
                path_fuzzy.append(case)
            det_edge_count = sum(
                1 for edge in path_edges if edge["method"] in DETERMINISTIC_METHODS
            )
            fuzzy_accepted = sum(1 for case in path_fuzzy if case["accepted"])
            fuzzy_rejected = sum(1 for case in path_fuzzy if not case["accepted"])
            # Count deterministic accepted plan-side hits once each (not per edge).
            det_plan_hits = len({
                edge["plan_source_record_id"]
                for edge in path_edges
                if edge["method"] in DETERMINISTIC_METHODS
            })
            precision_numer = det_plan_hits + fuzzy_accepted
            precision_denom = det_plan_hits + fuzzy_accepted + fuzzy_rejected
            if precision_denom:
                precision = precision_numer / precision_denom
            elif joined == 0:
                precision = 1.0  # no candidates → no false positives
            elif det_edge_count == len(path_edges):
                precision = 1.0  # only product deterministic strategies
            else:
                precision = None

            review_complete = unreviewed == 0
            precision_ok = precision is not None and precision >= precision_threshold
            materialize = bool(
                total
                and rate >= usefulness_threshold
                and review_complete
                and precision_ok
            )

            contrast: dict[str, Any] | None = None
            if contrast_sample is not None:
                c_joined: set[str] = set()
                for plan in contrast_sample:
                    matches, _, _, _ = _collect_plan_matches(plan, index, labels)
                    if matches:
                        c_joined.add(str(plan["source_record_id"]))
                c_total = len(contrast_sample)
                contrast = {
                    "sample_method": "fixed_sorted",
                    "joined": len(c_joined),
                    "total": c_total,
                    "rate": (len(c_joined) / c_total) if c_total else 0.0,
                    "note": (
                        "Legacy fixed-sorted sample often undersamples PIN/EPIN-bearing "
                        "renewal rows; gate uses identifier_bearing denominator."
                    ),
                }

            paths[path_name] = {
                "joined": joined,
                "total": total,
                "rate": rate,
                "candidates": candidates,
                "review_complete": review_complete,
                "unreviewed_candidates": unreviewed,
                "precision": precision,
                "precision_threshold": precision_threshold,
                "precision_ok": precision_ok,
                "method_counts": method_counts,
                "materialize": materialize,
                "sample_method": gate_method,
                "contrast_fixed_sorted": contrast,
                "verdict": (
                    "Above usefulness and precision thresholds; reviewed edges may materialize."
                    if materialize else
                    "Stop: below usefulness/precision threshold or review incomplete; no edges materialize."
                ),
            }

            if materialize and materialize_population:
                # Full population edges for this source×group, not only the sample.
                pop_edges: list[dict[str, Any]] = []
                for plan in (p for p in plans if p.get("source") == source):
                    matches, _, _, _ = _collect_plan_matches(plan, index, labels)
                    for target, candidate in matches:
                        if candidate["method"] in DETERMINISTIC_METHODS or candidate["accepted"]:
                            pop_edges.append(edge_from(plan, source, target, candidate))
                accepted_by_path[path_name] = pop_edges
            else:
                accepted_by_path[path_name] = path_edges if materialize else []

    reviewed = [case for case in reviewed_cases.values() if case["reviewed"]]
    false_positives = [case for case in reviewed if not case["accepted"]]
    measurement = {
        "sample": {
            "method": (
                "identifier_bearing_plan_sample"
                if gate_method == "identifier_bearing"
                else "fixed_sorted_modern_sample"
            ),
            "size_per_plan_source": sample_size,
            "modern_target_start": "2025-01-01",
            "sort_key": "source_record_id ASC",
            "denominator_policy": (
                "joinable_candidate_rows"
                if gate_method == "identifier_bearing"
                else "fixed_sorted_source_rows"
            ),
            "join_strategies": [
                "exact",
                "pin_strip_suffix",
                "pin_prefix_of_epin",
                "epin_prefix_of_pin",
                "agency_title_time_reviewed",
            ],
            "product_join_reuse": "worker/src/lib/passport_join.mjs",
        },
        "usefulness_threshold": usefulness_threshold,
        "precision_threshold": precision_threshold,
        "paths": paths,
        "false_positive_review": {
            "reviewed": len(reviewed),
            "accepted": len(reviewed) - len(false_positives),
            "false_positives": len(false_positives),
            "unreviewed": sum(1 for case in reviewed_cases.values() if not case["reviewed"]),
            "cases": sorted(reviewed_cases.values(), key=lambda case: case["candidate_key"]),
            "rubric": (
                "Agency+title+time candidates require an explicit label. Deterministic "
                "product identifier strategies (exact, strip-suffix, pin_prefix_of_epin, "
                "epin_prefix_of_pin with rest_ok tails) auto-accept without title similarity."
            ),
        },
    }
    edges = [edge for path_edges in accepted_by_path.values() for edge in path_edges]
    edges.sort(key=lambda edge: (edge["plan_source_record_id"], edge["target_source"], edge["target_id"]))
    return measurement, edges


def load_review_labels(path: Path | None) -> dict[str, dict[str, Any]]:
    if path is None or not path.is_file():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload.get("labels", payload)
