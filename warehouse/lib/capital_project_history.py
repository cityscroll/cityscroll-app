"""Dated comparisons over published capital-project observations.

The publisher reissues every capital project in each periodic release. Comparing
two releases therefore needs an identity that survives reissue, an explicit rule
for repeated rows, and a vocabulary that keeps "did not change", "was never
published", and "stopped being published" apart.

Two identities are deliberately separate. Financial observations are compared at
managing agency plus FMS identifier; schedule observations are compared at
managing agency plus a nonempty project identifier. A published row can carry one
without the other, and collapsing them would let a schedule row donate a budget it
never reported.

Managing agency is part of every identity. The publisher's own record identifier
omits it, so two agencies running unrelated projects under the same identifier
would otherwise read as one project changing hands.

Amounts are project budgets and recorded project spending, and dates are project
forecasts. Neither is a solicitation value, a bid deadline, or a contract term.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Sequence

# The publisher's own release identifier, e.g. "202605" for the May 2026 release.
RELEASE_FLOOR = "202401"

# Fields compared under each identity. Nothing outside these lists is differenced.
FINANCIAL_FIELDS = ("total_budget", "spend_to_date")
SCHEDULE_FIELDS = ("forecast_completion", "current_phase")

# Comparison outcomes for a single field across two releases.
UNCHANGED = "unchanged"
CHANGED = "changed"
MISSING_BEFORE = "missing_before"
MISSING_AFTER = "missing_after"
NOT_PUBLISHED = "not_published"

# Comparison outcomes for an identity across two releases.
COMPARED = "compared"
DISAPPEARED = "disappeared"
FIRST_OBSERVED = "first_observed"

# Why a release is not admitted into published history.
BELOW_FLOOR = "below_release_floor"
INCOMPLETE = "incomplete_retained_release"


def clean(value: Any) -> str:
    """Collapse a publisher cell to comparable text."""
    return "" if value is None else " ".join(str(value).split())


def parse_amount(value: Any) -> Decimal | None:
    """Parse a published amount exactly. Money is never compared as a float."""
    text = clean(value).replace(",", "").replace("$", "")
    if not text:
        return None
    if text.startswith("(") and text.endswith(")"):
        text = "-" + text[1:-1]
    try:
        return Decimal(text)
    except (InvalidOperation, ValueError):
        return None


def parse_day(value: Any) -> str | None:
    """Parse a published timestamp to its ISO day, or None when unusable."""
    text = clean(value)[:10]
    if len(text) != 10:
        return None
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        return None


def release_admitted(period: str, floor: str = RELEASE_FLOOR) -> bool:
    """True when a release label is at or after the history floor."""
    period = clean(period)
    return len(period) == 6 and period.isdigit() and period >= floor


def reconcile_releases(
    publisher_counts: dict[str, int],
    retained_counts: dict[str, int],
    floor: str = RELEASE_FLOOR,
) -> dict[str, Any]:
    """Admit only releases retained completely, at or after the history floor.

    A release retained short of the publisher's own count is a truncated pull, not
    a release in which projects disappeared. Differencing against it would invent
    disappearances, so it is excluded and reported rather than silently used.
    """
    admitted: list[str] = []
    excluded: list[dict[str, Any]] = []
    for period in sorted(set(publisher_counts) | set(retained_counts)):
        published = int(publisher_counts.get(period, 0))
        retained = int(retained_counts.get(period, 0))
        entry = {
            "reporting_period": period,
            "publisher_rows": published,
            "retained_rows": retained,
            "retained_complete": retained == published,
        }
        if not release_admitted(period, floor):
            excluded.append({**entry, "reason": BELOW_FLOOR})
        elif retained != published:
            excluded.append({**entry, "reason": INCOMPLETE})
        else:
            admitted.append(period)
    return {
        "release_floor": floor,
        "admitted_releases": admitted,
        "excluded_releases": excluded,
        "complete": not [item for item in excluded if item["reason"] == INCOMPLETE],
    }


def observation_identity(row: dict[str, Any]) -> tuple[str, str, str, str]:
    """Agency-qualified identity of one published row within one release."""
    return (
        clean(row.get("managing_agency")),
        clean(row.get("reporting_period")),
        clean(row.get("pid")),
        clean(row.get("fms_id")).upper(),
    )


def financial_identity(row: dict[str, Any]) -> tuple[str, str] | None:
    """Managing agency plus FMS identifier, or None when not financially identified."""
    agency = clean(row.get("managing_agency"))
    fms_id = clean(row.get("fms_id")).upper()
    return (agency, fms_id) if agency and fms_id else None


def schedule_identity(row: dict[str, Any]) -> tuple[str, str] | None:
    """Managing agency plus nonempty project identifier, or None when unscheduled."""
    agency = clean(row.get("managing_agency"))
    pid = clean(row.get("pid"))
    return (agency, pid) if agency and pid else None


def observation(row: dict[str, Any]) -> dict[str, Any]:
    """Project the comparable facts of one published row.

    Reporting period, agency data date, and financial data date are kept apart on
    purpose: a release labelled for May can carry an agency date in June and a
    financial date in May, and collapsing them would misdate the observation.
    """
    budget = parse_amount(row.get("total_budget"))
    spend = parse_amount(row.get("spend_to_date"))
    return {
        "reporting_period": clean(row.get("reporting_period")),
        "agency_data_date": parse_day(row.get("agency_data_date")),
        "financial_data_date": parse_day(row.get("fms_data_date")),
        "managing_agency": clean(row.get("managing_agency")),
        "fms_id": clean(row.get("fms_id")).upper() or None,
        "pid": clean(row.get("pid")) or None,
        "total_budget": None if budget is None else str(budget),
        "spend_to_date": None if spend is None else str(spend),
        "forecast_completion": parse_day(row.get("forecast_completion")),
        "current_phase": clean(row.get("current_phase")) or None,
    }


def agree(values: Sequence[Any]) -> tuple[bool, Any]:
    """Component agreement for repeated rows sharing one identity.

    Repeated rows are components of the same published project, not separate
    amounts. Agreeing components collapse to their single agreed value; they are
    never summed. Disagreeing components have no defensible single value, so the
    caller quarantines them instead of picking one.
    """
    distinct = []
    for value in values:
        if value not in distinct:
            distinct.append(value)
    if len(distinct) == 1:
        return True, distinct[0]
    return False, None


def field_state(before: Any, after: Any) -> str:
    """Classify one field across two releases without inventing a value."""
    if before is None and after is None:
        return NOT_PUBLISHED
    if before is None:
        return MISSING_BEFORE
    if after is None:
        return MISSING_AFTER
    return UNCHANGED if before == after else CHANGED


def amount_change(before: Any, after: Any) -> dict[str, Any]:
    """Difference one published amount, reporting the delta only when comparable."""
    state = field_state(before, after)
    result: dict[str, Any] = {"before": before, "after": after, "state": state, "delta": None}
    if state in (UNCHANGED, CHANGED):
        result["delta"] = str(Decimal(after) - Decimal(before))
    return result


def day_change(before: Any, after: Any) -> dict[str, Any]:
    """Difference one published date, reporting whole days only when comparable."""
    state = field_state(before, after)
    result: dict[str, Any] = {"before": before, "after": after, "state": state, "delta_days": None}
    if state in (UNCHANGED, CHANGED):
        result["delta_days"] = (date.fromisoformat(after) - date.fromisoformat(before)).days
    return result


def text_change(before: Any, after: Any) -> dict[str, Any]:
    """Classify one published label across two releases."""
    return {"before": before, "after": after, "state": field_state(before, after)}


def compare_observations(before: dict[str, Any] | None, after: dict[str, Any] | None) -> dict[str, Any]:
    """Compare two observations of one identity, or report why they cannot be."""
    if before and not after:
        return {"identity_state": DISAPPEARED, "before": before, "after": None, "changes": {}}
    if after and not before:
        return {"identity_state": FIRST_OBSERVED, "before": None, "after": after, "changes": {}}
    if not before and not after:
        return {"identity_state": NOT_PUBLISHED, "before": None, "after": None, "changes": {}}
    changes = {
        "total_budget": amount_change(before.get("total_budget"), after.get("total_budget")),
        "spend_to_date": amount_change(before.get("spend_to_date"), after.get("spend_to_date")),
        "forecast_completion": day_change(before.get("forecast_completion"), after.get("forecast_completion")),
        "current_phase": text_change(before.get("current_phase"), after.get("current_phase")),
    }
    return {"identity_state": COMPARED, "before": before, "after": after, "changes": changes}


def has_change(comparison: dict[str, Any]) -> bool:
    """True only when a compared field actually moved.

    A later release existing is not itself a change. Without this, every project
    would appear to change in every release.
    """
    return any(change["state"] == CHANGED for change in comparison.get("changes", {}).values())


def _collapse(rows: Sequence[dict[str, Any]], fields: Iterable[str]) -> tuple[dict[str, Any] | None, list[str]]:
    """Collapse repeated rows for one identity in one release by agreement."""
    observations = [observation(row) for row in rows]
    base = dict(observations[0])
    conflicts: list[str] = []
    for field in fields:
        ok, value = agree([item.get(field) for item in observations])
        if ok:
            base[field] = value
        else:
            conflicts.append(field)
            base[field] = None
    return base, conflicts


def build_series(
    rows: Iterable[dict[str, Any]],
    identity_of,
    fields: Sequence[str],
    admitted_releases: Sequence[str],
) -> tuple[dict[tuple[str, ...], dict[str, dict[str, Any]]], list[dict[str, Any]]]:
    """Group admitted rows into per-identity release series, quarantining conflicts."""
    admitted = set(admitted_releases)
    grouped: dict[tuple[str, ...], dict[str, list[dict[str, Any]]]] = {}
    for row in rows:
        identity = identity_of(row)
        period = clean(row.get("reporting_period"))
        if identity is None or period not in admitted:
            continue
        grouped.setdefault(identity, {}).setdefault(period, []).append(row)

    series: dict[tuple[str, ...], dict[str, dict[str, Any]]] = {}
    quarantine: list[dict[str, Any]] = []
    for identity, releases in grouped.items():
        for period, rows_in_release in releases.items():
            collapsed, conflicts = _collapse(rows_in_release, fields)
            if conflicts:
                quarantine.append({
                    "identity": list(identity),
                    "reporting_period": period,
                    "conflicting_fields": sorted(conflicts),
                    "component_count": len(rows_in_release),
                    "components": sorted(
                        clean(row.get("fms_id")).upper() or clean(row.get("pid"))
                        for row in rows_in_release
                    ),
                })
            series.setdefault(identity, {})[period] = collapsed
    return series, quarantine


def transition_releases(admitted_releases: Sequence[str]) -> tuple[str | None, str | None]:
    """The two most recent admitted releases, compared for every identity alike.

    The pair is chosen once for the whole population rather than per project. An
    identity published in the earlier release and absent from the later one has
    disappeared from publication; picking each project's own last two appearances
    would quietly reclassify that disappearance as an ordinary comparison.
    """
    periods = list(admitted_releases)
    if len(periods) < 2:
        return (None, None)
    return periods[-2], periods[-1]


def history_depth(series_for_identity: dict[str, dict[str, Any]], admitted_releases: Sequence[str]) -> int:
    """How many admitted releases published this identity."""
    return sum(1 for period in admitted_releases if period in series_for_identity)
