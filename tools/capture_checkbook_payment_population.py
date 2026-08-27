#!/usr/bin/env python3
"""Headless internal before/after proof for the AP-08 payment population."""

from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "checkbook-payment-population"
POPULATION_RECEIPT = ROOT / "warehouse" / "receipts" / "proof" / "checkbook_payment_population_latest.json"
BOUNDED_RECEIPT = ROOT / "warehouse" / "receipts" / "proof" / "checkbook_spending_population_latest.json"


def money(value: float) -> str:
    return f"${value:,.2f}"


def render(phase: str, body: str) -> str:
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root {{ color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
  body {{ margin: 0; background: #f4f1eb; color: #17231f; }}
  main {{ max-width: 1180px; margin: 0 auto; padding: 54px 64px; }}
  .eyebrow {{ color: #8b4f2d; font-size: 13px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }}
  h1 {{ margin: 14px 0 8px; font: 700 42px/1.08 Georgia, serif; letter-spacing: -.02em; }}
  .subtitle {{ color: #53625d; font-size: 17px; margin-bottom: 32px; }}
  .warning {{ border-left: 4px solid #c56b3d; background: #fffaf2; padding: 15px 18px; margin: 18px 0 28px; font-size: 16px; }}
  .hero {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin: 24px 0; }}
  .stat {{ background: #fff; border: 1px solid #d9ded8; border-radius: 12px; padding: 22px; min-width: 0; }}
  .stat strong {{ display: block; font: 700 28px/1.1 Georgia, serif; overflow-wrap: anywhere; }}
  .stat span {{ display: block; color: #62706a; font-size: 13px; margin-top: 8px; }}
  section {{ background: #fff; border: 1px solid #d9ded8; border-radius: 12px; padding: 24px; }}
  h2 {{ margin: 0 0 16px; font: 700 24px Georgia, serif; }}
  table {{ border-collapse: collapse; width: 100%; }}
  th, td {{ padding: 10px 8px; border-bottom: 1px solid #e7e9e5; text-align: left; }}
  th:last-child, td:last-child {{ text-align: right; }}
  th {{ color: #62706a; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }}
  .source {{ color: #62706a; font-size: 13px; margin-top: 22px; }}
  @media (max-width: 600px) {{ main {{ padding: 28px 18px; }} h1 {{ font-size: 32px; }} .hero {{ grid-template-columns: 1fr; }} section {{ padding: 16px; }} }}
</style></head><body><main>{body}</main></body></html>"""


def capture(page, phase: str, width: int, height: int, body: str) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.set_content(render(phase, body), wait_until="load")
    page.screenshot(path=str(OUT / f"{phase}-{width}.png"), full_page=True)


def main() -> int:
    population = json.loads(POPULATION_RECEIPT.read_text(encoding="utf-8"))
    bounded = json.loads(BOUNDED_RECEIPT.read_text(encoding="utf-8"))
    top = population["population"]["agency_grouping"][:10]
    before_body = f"""
      <div class="eyebrow">Internal AP-08 evidence · before</div>
      <h1>Bounded Checkbook Spending collector</h1>
      <div class="subtitle">The existing graph-enrichment path follows contract seeds.</div>
      <div class="warning"><strong>Boundary:</strong> these rows are retained for contract enrichment and are not a citywide spending denominator.</div>
      <div class="hero">
        <div class="stat"><strong>{bounded['population']['seed_contracts']:,}</strong><span>seed contracts</span></div>
        <div class="stat"><strong>{bounded['population']['retained_payments']:,}</strong><span>retained payment rows</span></div>
        <div class="stat"><strong>{bounded['population']['unique_contracts_with_payments']:,}</strong><span>contracts with payments</span></div>
      </div>
      <div class="source">Source receipt: bounded contract-seeded Checkbook Spending collector.</div>
    """
    after_body = f"""
      <div class="eyebrow">Internal AP-08 evidence · after</div>
      <h1>Actual Checkbook payments · FY2026</h1>
      <div class="subtitle">Independent fiscal-year population · contract-spending category · citywide agencies</div>
      <div class="hero">
        <div class="stat"><strong>{population['population']['normalized_rows']:,}</strong><span>transactions</span></div>
        <div class="stat"><strong>{money(population['reconciliation']['normalized_net_check_amount'])}</strong><span>net check amount</span></div>
        <div class="stat"><strong>{len(population['population']['agency_grouping']):,}</strong><span>agency groups</span></div>
      </div>
      <section><h2>Net check amount by agency</h2><table><thead><tr><th>Agency</th><th>Transactions</th><th>Net amount</th></tr></thead><tbody>
      {''.join(f"<tr><td>{row['agency']}</td><td>{row['transaction_count']:,}</td><td>{money(row['net_check_amount'])}</td></tr>" for row in top)}
      </tbody></table></section>
      <div class="source">Source: Office of the New York City Comptroller · Checkbook Spending API · FY2026 · c. Reconciled source XML rows, normalized CSV rows, and Parquet rows; {population['population']['reversal_rows']:,} negative reversal rows retained.</div>
    """
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        for width, height in ((390, 844), (1440, 1000)):
            capture(page, "before", width, height, before_body)
            capture(page, "after", width, height, after_body)
        browser.close()
    receipt = {
        "schema": "cityscroll.checkbook_payment_population_capture.v1",
        "captures": [
            {"phase": phase, "viewport": {"width": width, "height": height}, "path": f"artifacts/checkbook-payment-population/{phase}-{width}.png"}
            for width, height in ((390, 844), (1440, 1000))
            for phase in ("before", "after")
        ],
        "before_population": {"seed_contracts": bounded["population"]["seed_contracts"], "retained_payments": bounded["population"]["retained_payments"]},
        "after_population": {"fiscal_year": 2026, "transactions": population["population"]["normalized_rows"], "net_check_amount": population["reconciliation"]["normalized_net_check_amount"], "agency_groups": len(population["population"]["agency_grouping"])},
    }
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
