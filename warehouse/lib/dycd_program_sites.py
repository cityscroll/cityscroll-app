"""DYCD program-site reducer.

Derives typed facility-site membership from the publisher's explicit
community district field. A program-site offering is identified by the exact
published (fiscal year, contract, portfolio, provider, program type, site
name, street address) tuple; co-located distinct portfolios stay distinct and
duplicate observations never inflate totals. Vendor address, service
catchment, unmet demand, award amount and contract joins are never used as
service geography.

The SHA256 site identity uses Python ``json.dumps`` encoding; that encoding
is normative for fixture parity across ports.
"""
import collections
import hashlib
import json
import re

GEOGRAPHY_KEYS = [f"geography:community_district:Q{i:02}" for i in range(1, 15)]

_SITE_KEY_FIELDS = (
    "date",
    "contract",
    "portfolioid",
    "provider",
    "program_type",
    "program_site_name",
    "street_address",
)


def norm(value):
    """Normalize a publisher cell: collapse whitespace, treat NULL/N/A as empty."""
    s = re.sub(r"\s+", " ", str(value or "")).strip()
    return "" if s.upper() in {"NULL", "N/A"} else s


def site_key(row):
    """Portfolio distinguishes individually delivered programs at the same
    physical site. Without one, retain contract + explicit site dimensions,
    never provider alone."""
    normalized = [norm(row.get(field)).casefold() for field in _SITE_KEY_FIELDS]
    return hashlib.sha256(json.dumps(normalized).encode()).hexdigest()


def program_map(rows, *, fy=2026, complete=False, program_area=None):
    """Reduce raw DYCD program-site rows to district membership.

    ``complete`` must come from a validated capture receipt; an incomplete
    capture yields ``unavailable`` with null districts, never fourteen zeros.
    """
    if not complete:
        return {
            "status": "unavailable",
            "districts": None,
            "reason": "incomplete_source_capture",
        }
    selected = [
        r
        for r in rows
        if norm(r.get("date")) == str(fy)
        and norm(r.get("borough")).casefold() == "queens"
        and (not program_area or r.get("program_area") == program_area)
    ]
    groups = collections.defaultdict(list)
    for r in selected:
        groups[site_key(r)].append(r)
    counts = {key: 0 for key in GEOGRAPHY_KEYS}
    excluded, members = [], []
    for key, observations in sorted(groups.items()):
        districts = {norm(r.get("communitydistrict")) for r in observations}
        if len(districts) != 1:
            excluded.append({"id": key, "reason": "conflicting_published_district"})
            continue
        match = re.fullmatch(r"Queens CD (\d{3})", next(iter(districts)))
        district = int(match.group(1)) if match else None
        if district is None or not 1 <= district <= 14:
            excluded.append(
                {
                    "id": key,
                    "reason": "joint_interest_area"
                    if district and district >= 80
                    else "missing_or_invalid_district",
                }
            )
            continue
        r = observations[0]
        geo = f"geography:community_district:Q{district:02}"
        counts[geo] += 1
        members.append(
            {
                "id": key,
                "geography_key": geo,
                "relation": "located_in",
                "place_role": "facility_site",
                "basis": "publisher_explicit_communitydistrict",
                "provider": r["provider"],
                "program_area": r.get("program_area"),
                "program_type": r["program_type"],
                "program_site_name": r["program_site_name"],
                "street_address": r.get("street_address"),
                "contract": r.get("contract"),
                "portfolioid": r.get("portfolioid"),
                "source_rows": len(observations),
            }
        )
    return {
        "status": "available",
        "fiscal_year": fy,
        "label": "DYCD program sites in Queens",
        "unit": "program-site records (contract/portfolio offerings, not unique buildings)",
        "input_rows": len(selected),
        "distinct_records": len(groups),
        "duplicate_observations": len(selected) - len(groups),
        "mapped_records": sum(counts.values()),
        "excluded": excluded,
        "districts": counts,
        "members": members,
    }
