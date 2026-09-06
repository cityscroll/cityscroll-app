"""Exact published-project-code relations between solicitations and capital projects.

This is a separately named relation, deliberately independent of the fuzzy
capital-name bridge in ``procurement_plans.py``. That bridge scores title
resemblance and stays behind its own usefulness/precision review; nothing here
consumes it, extends it, or admits it. The only join this module will ever make
is an **exact published project code** carried in the notice's own text, under a
managing agency the notice already declares.

Three rules keep the relation honest:

1. An agency match alone is never a relation. A candidate needs the agency *and*
   a literal project code, matched whole -- a code may not begin or end inside a
   longer identifier -- or it stays unlinked.
2. Financial identity (managing agency + project code), schedule identity
   (managing agency + a published schedule id) and a registered contract are
   three separate things. They are carried as separate typed edges, never
   flattened into one "project" record, because a project code with no published
   schedule id is a real and common state.
3. The published record is preserved as published. A structured identifier that
   disagrees with one written in the notice body is carried as a conflict; it is
   never repaired, reconciled, or turned into a resolved portal handoff.

Everything this module produces is a materialization, computed once during
acquisition. Reader surfaces consume its output and never re-derive a match.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Sequence

from .procurement_plans import clean_text, extract_published_identifiers, identifier_key

MATERIALIZATION_SCHEMA = "cityscroll.procurement_project_context.v1"
RELATION_SCHEMA = "cityscroll.capital_project_relation.v1"

# The relation's own name. Kept distinct from `bridge_edges` so no reader can
# confuse an exact code match with the unadmitted resemblance bridge.
RELATION_METHOD = "exact_published_project_code"
SOLICITATION_RELATION = "solicitation_names_capital_project_code"
CONTRACT_RELATION = "registered_contract_names_capital_project_code"

# A shorter token is not a project code; it is a word or a budget-line fragment.
MINIMUM_CODE_LENGTH = 6

# The publisher's own blank markers. `<blank>` is written literally into the
# description column; it is a published absence, not a description.
BLANK_MARKERS = frozenset({"<blank>", "n/a", "none", "tbd"})

# Fields of a City Record notice that carry vendor-facing text.
NOTICE_TEXT_FIELDS = (
    "short_title",
    "additional_description_1",
    "additional_description_2",
    "additional_description_3",
    "other_info_1",
)

# A qualification route publishes a date for joining a pre-qualified list, not a
# construction bid. Notices whose structured identifier carries this prefix are
# marked so no surface can present their dates as a bid deadline.
QUALIFICATION_PIN_PREFIX = "PQL"

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

# A project-code-shaped token: long enough, whole, and carrying both letters and
# digits. An ordinary capitalised word in a title ("CONCRETE", "ROADWAY") is not
# a candidate identifier and must not be reported as one.
_CODE_SHAPED_TOKEN = re.compile(
    r"(?<![A-Z0-9-])(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)([A-Z][A-Z0-9-]{5,})(?![A-Z0-9-])"
)


def readable_text(value: Any) -> str | None:
    """`clean_text` plus C0 control-character removal.

    The City Record export carries stray control bytes where a typographic
    apostrophe was lost upstream. They are dropped rather than guessed at: a
    substitution would be this repository inventing a character the publisher
    did not publish.
    """
    return clean_text(_CONTROL_CHARS.sub("", str(value))) if value is not None else None


def is_published_blank(value: Any) -> bool:
    """Whether a published field is one of the publisher's blank markers."""
    text = readable_text(value)
    return not text or text.strip().lower() in BLANK_MARKERS


def notice_scan_text(notice: dict[str, Any]) -> str:
    """The notice text a project code may legitimately appear in."""
    return " ".join(readable_text(notice.get(field)) or "" for field in NOTICE_TEXT_FIELDS)


def project_code_pattern(codes: Iterable[str]) -> re.Pattern[str] | None:
    """Compile the whole-code matcher for a code roster.

    Longest alternative first so ``CO301LL`` cannot shadow a longer code that
    starts with it, and a boundary that rejects a code touching another
    identifier character on either side: ``PV279ACON`` must not match inside
    ``PV279ACONX`` or ``12-PV279ACON``.
    """
    roster = sorted({code for code in codes if code}, key=lambda code: (-len(code), code))
    if not roster:
        return None
    alternatives = "|".join(re.escape(code) for code in roster)
    return re.compile(rf"(?<![A-Z0-9-])({alternatives})(?![A-Z0-9-])")


def project_code_hits(text: str, pattern: re.Pattern[str] | None) -> list[str]:
    """Every whole project code the text publishes, sorted and deduplicated."""
    if not pattern or not text:
        return []
    return sorted(set(pattern.findall(text.upper())))


def capital_code_index(
    rows: Sequence[dict[str, Any]],
    *,
    managing_agency: str,
    reporting_period: str | None = None,
    minimum_code_length: int = MINIMUM_CODE_LENGTH,
) -> dict[str, list[dict[str, Any]]]:
    """Group published capital rows by project code, within one managing agency.

    The agency filter is the boundary rule, not a convenience: two agencies can
    publish the same short word as a project code, and a word collision across
    agencies is not a relation.
    """
    index: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        if readable_text(row.get("managing_agency")) != managing_agency:
            continue
        if reporting_period and readable_text(row.get("reporting_period")) != reporting_period:
            continue
        code = (readable_text(row.get("fms_id")) or "").upper()
        if len(code) < minimum_code_length:
            continue
        index.setdefault(code, []).append(row)
    return index


def _money(value: Any) -> str | None:
    text = readable_text(value)
    if text is None:
        return None
    try:
        return str(Decimal(text))
    except (InvalidOperation, ValueError):
        return None


def _day(value: Any) -> str | None:
    text = readable_text(value)
    return text[:10] if text else None


def _matched_fields(notice: dict[str, Any], code: str) -> list[str]:
    """Which published fields carry the code, so the evidence is checkable."""
    pattern = project_code_pattern([code])
    return [
        field for field in NOTICE_TEXT_FIELDS
        if project_code_hits(readable_text(notice.get(field)) or "", pattern)
    ]


def capital_project_facts(code: str, rows: Sequence[dict[str, Any]], managing_agency: str) -> dict[str, Any]:
    """The published project record behind one code, with its identities apart.

    ``financial_identity`` and ``schedule_identity`` stay separate: a project
    code always has the former, and only sometimes has the latter. Amounts are
    labeled as project budget and recorded project spending, and the forecast
    date is labeled a project forecast, because none of the three is a
    solicitation value, a bid deadline, or a binding contract term.
    """
    schedule_ids = sorted({readable_text(row.get("pid")) for row in rows if readable_text(row.get("pid"))})
    described = next(
        (row for row in rows if not is_published_blank(row.get("agency_project_description"))),
        None,
    )
    primary = described or rows[0]
    description = readable_text(primary.get("agency_project_description")) if described else None
    return {
        "source": "capital_projects_dashboard",
        "source_url": "https://data.cityofnewyork.us/resource/fb86-vt7u.json",
        "landing_url": "https://data.cityofnewyork.us/d/fb86-vt7u",
        "financial_identity": {"managing_agency": managing_agency, "project_code": code},
        "schedule_identity": (
            {"managing_agency": managing_agency, "schedule_ids": schedule_ids} if schedule_ids else None
        ),
        "sponsor_agency": readable_text(primary.get("sponsor_agency")),
        "project_name": readable_text(primary.get("agency_project_name") or primary.get("fms_project_name")),
        "project_scope": description,
        "project_scope_published_blank": description is None,
        "current_phase": readable_text(primary.get("current_phase")),
        "borough": readable_text(primary.get("borough")),
        "community_board": readable_text(primary.get("community_board")),
        "project_budget": _money(primary.get("total_budget")),
        "recorded_project_spending": _money(primary.get("spend_to_date")),
        "project_forecast_completion": _day(primary.get("forecast_completion")),
        "observation_dates": {
            "reporting_period": readable_text(primary.get("reporting_period")),
            "agency_data_date": _day(primary.get("agency_data_date")),
            "financial_data_date": _day(primary.get("fms_data_date")),
        },
        "component_rows": len(rows),
    }


def solicitation_identity(notice: dict[str, Any]) -> dict[str, Any]:
    """The notice as published, including an identifier conflict if there is one."""
    request_id = readable_text(notice.get("request_id"))
    structured_pin = readable_text(notice.get("pin"))
    body_identifiers = [
        value for value in extract_published_identifiers(
            *(notice.get(field) for field in NOTICE_TEXT_FIELDS)
        )
        if identifier_key(value) != identifier_key(structured_pin)
    ]
    return {
        "source": "city_record",
        "source_url": f"https://a856-cityrecord.nyc.gov/RequestDetail/{request_id}",
        "request_id": request_id,
        "structured_pin": structured_pin,
        "body_identifiers": body_identifiers,
        # Two published values for one identifier. Both are kept; neither is
        # corrected, and neither may be used to claim a resolved portal lookup.
        "identifier_conflict": bool(structured_pin and body_identifiers),
        "notice_type": readable_text(notice.get("type_of_notice_description")),
        "selection_method": readable_text(notice.get("selection_method_description")),
        "published_on": _day(notice.get("start_date")),
        "response_due": _day(notice.get("due_date")),
        "qualification_route": bool(structured_pin and structured_pin.upper().startswith(QUALIFICATION_PIN_PREFIX)),
        "title": readable_text(notice.get("short_title")),
    }


def build_capital_project_relations(
    notices: Sequence[dict[str, Any]],
    capital_rows: Sequence[dict[str, Any]],
    *,
    managing_agency: str = "DDC",
    reporting_period: str | None = None,
    code_roster: Sequence[str] | None = None,
    notice_type: str = "Solicitation",
) -> dict[str, Any]:
    """Materialize the solicitation -> capital-project code relation.

    ``code_roster`` is the join universe. It defaults to the codes present in
    ``capital_rows``; supplying it separately lets a caller carry the complete
    published roster while retaining detail for only the codes that resolve, so
    a code missing its detail row fails loudly instead of silently vanishing
    from the denominator.
    """
    index = capital_code_index(
        capital_rows, managing_agency=managing_agency, reporting_period=reporting_period,
    )
    roster = list(code_roster) if code_roster is not None else sorted(index)
    pattern = project_code_pattern(roster)

    considered = [n for n in notices if readable_text(n.get("type_of_notice_description")) == notice_type]
    relations: list[dict[str, Any]] = []
    unlinked: list[dict[str, Any]] = []

    for notice in sorted(considered, key=lambda n: str(n.get("request_id"))):
        codes = project_code_hits(notice_scan_text(notice), pattern)
        identity = solicitation_identity(notice)
        if not codes:
            unlinked.append({
                "request_id": identity["request_id"],
                "structured_pin": identity["structured_pin"],
                "source_url": identity["source_url"],
                "reason": "no published project code for this managing agency in the notice text",
            })
            continue
        for code in codes:
            rows = index.get(code)
            if not rows:
                raise ValueError(
                    f"project code {code} is on the roster but carries no published detail row; "
                    "the capital projection is incomplete"
                )
            relations.append({
                "schema": RELATION_SCHEMA,
                "relation": SOLICITATION_RELATION,
                "method": RELATION_METHOD,
                "solicitation": identity,
                "capital_project": capital_project_facts(code, rows, managing_agency),
                "evidence": {
                    "managing_agency": managing_agency,
                    "matched_code": code,
                    "matched_in": _matched_fields(notice, code),
                    "match_rule": "whole published project code, agency-scoped",
                },
            })

    unresolved = codes_named(considered, roster, pattern, index)
    return {
        "relations": relations,
        "unlinked_solicitations": unlinked,
        "unresolved_component_codes": unresolved,
        "counts": {
            "notices_published": len(notices),
            "solicitations_considered": len(considered),
            "solicitations_related": len({r["solicitation"]["request_id"] for r in relations}),
            "solicitations_unlinked": len(unlinked),
            "project_codes_related": len({r["evidence"]["matched_code"] for r in relations}),
            "relations_with_schedule_identity": len({
                r["solicitation"]["request_id"] for r in relations if r["capital_project"]["schedule_identity"]
            }),
            "relations_with_project_scope": len({
                r["solicitation"]["request_id"] for r in relations
                if not r["capital_project"]["project_scope_published_blank"]
            }),
        },
    }


def codes_named(
    notices: Sequence[dict[str, Any]],
    roster: Sequence[str],
    pattern: re.Pattern[str] | None,
    index: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Codes a notice looks like it names but which this agency never published.

    A bundled solicitation can advertise several components while only one of
    them carries a project code this agency publishes. Recording the others as
    unresolved keeps the component boundary visible instead of letting the one
    resolved component stand in for the whole package.
    """
    known = {code.upper() for code in roster}
    out: list[dict[str, Any]] = []
    for notice in sorted(notices, key=lambda n: str(n.get("request_id"))):
        text = notice_scan_text(notice).upper()
        if not project_code_hits(text, pattern):
            continue
        identity = solicitation_identity(notice)
        published = {identifier_key(identity["structured_pin"])} | {
            identifier_key(value) for value in identity["body_identifiers"]
        }
        title = (readable_text(notice.get("short_title")) or "").upper()
        for token in sorted({match.rstrip("-") for match in _CODE_SHAPED_TOKEN.findall(title)}):
            if token in known or token in index or identifier_key(token) in published:
                continue
            out.append({
                "request_id": identity["request_id"],
                "token": token,
                "reason": "named in the notice title but not published as a project code for this agency",
            })
    return out


def build_contract_relations(
    contracts: Sequence[dict[str, Any]],
    capital_rows: Sequence[dict[str, Any]],
    *,
    managing_agency: str = "DDC",
    reporting_period: str | None = None,
    code_roster: Sequence[str] | None = None,
) -> list[dict[str, Any]]:
    """Registered contracts that name a published project code, as separate edges.

    A contract that names a project code once per component keeps one edge per
    component. Nothing here claims the contract covers the whole project, or
    that the retained contracts are a complete package inventory.
    """
    index = capital_code_index(
        capital_rows, managing_agency=managing_agency, reporting_period=reporting_period,
    )
    roster = list(code_roster) if code_roster is not None else sorted(index)
    pattern = project_code_pattern(roster)
    edges: list[dict[str, Any]] = []
    for contract in sorted(contracts, key=lambda c: str(c.get("contract_id"))):
        for code in project_code_hits(readable_text(contract.get("title")) or "", pattern):
            rows = index.get(code)
            if not rows:
                raise ValueError(
                    f"project code {code} is on the roster but carries no published detail row; "
                    "the capital projection is incomplete"
                )
            edges.append({
                "schema": RELATION_SCHEMA,
                "relation": CONTRACT_RELATION,
                "method": RELATION_METHOD,
                "registered_contract": {
                    "source": "passport_contracts",
                    "contract_id": readable_text(contract.get("contract_id")),
                    "title": readable_text(contract.get("title")),
                    "vendor": readable_text(contract.get("vendor")),
                    "agency": readable_text(contract.get("agency")),
                },
                "capital_project": capital_project_facts(code, rows, managing_agency),
                "evidence": {
                    "managing_agency": managing_agency,
                    "matched_code": code,
                    "match_rule": "whole published project code, agency-scoped",
                },
            })
    return edges
