"""Pure axe-gate classification shared by the browser check and its regression proof."""

FAIL_IMPACTS = {"critical", "serious"}
RATCHET_RULES = {"landmark-one-main", "region", "heading-order"}


def failing_violations(violations, wcag22_rules):
    """Return every violation that is required to fail the accessibility gate."""
    wcag22_rules = set(wcag22_rules)
    return [
        violation
        for violation in violations
        if violation.get("impact") in FAIL_IMPACTS
        or violation["id"] in RATCHET_RULES
        or violation["id"] in wcag22_rules
    ]
