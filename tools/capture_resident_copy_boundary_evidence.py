#!/usr/bin/env python3
"""Headless browser evidence for the rendered resident-copy boundary gate (RU-03).

The gate itself (tools/resident_copy_boundary.mjs) asserts structure over
rendered markup without a browser, which is what makes it cheap enough to run on
every preflight. This script is the complementary proof that the same bounded
fixtures behave in a real engine: it renders the corpus to standalone documents,
serves them, and at the two reviewed widths (390px and 1440px) checks

  - axe-core (vendored, no network) for accessibility violations,
  - that every interactive control is keyboard reachable and shows a visible
    focus indicator,
  - that translated and locale-fallback copy renders as sentences rather than
    raw keys in the live DOM, and
  - that nothing overflows the viewport horizontally.

It also drives the NEGATIVE fixtures, because an accessibility pass on markup the
gate is supposed to reject would mean the gate is rejecting something harmless.
Those are asserted to be caught by the gate while remaining ordinary,
non-crashing documents in the browser.

Capture proof is the committed manifest: route, viewport, revision, data vintage,
assertion, and a sha256 per capture. Image binaries stay in the ignored local
path beside it and are never committed.

Run: python3 tools/capture_resident_copy_boundary_evidence.py
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "resident-copy-boundary"
FIXTURE_DIR = OUT / "fixtures"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]

# What each fixture's rendered state was derived from. Recorded per capture
# because it varies: some states come from committed warehouse data, others from
# literal records written into the fixture so the state is reachable at all.
DATA_VINTAGE = {
    "community-board-document": (
        "committed Community Board sources: site/data/community_board_minutes_scorecard.json, "
        "site/data/community_board_geography_lookup.json, and "
        "site/data/non_council_outcome_sources/*.json"
    ),
    "edge-summary-rail": "literal edge records written into the fixture; no warehouse read",
    "money-card": "literal adopted-budget and payment-actual records written into the fixture; no warehouse read",
    "outcome-not-located": "literal outcome-lookup payload with no matching row; no warehouse read",
    "following-personal-island": "no source data: a personal-read UI state with no civic record behind it",
    "document-footer": "no source data: static document chrome",
    "negative": "synthetic markup reproducing a rejected rendered state; no warehouse read",
}

# Accessibility defects this card did not introduce and does not own. Each entry
# names one fixture and one axe rule, never a rule globally, so a NEW violation
# of the same rule anywhere else still fails. They are reported at the top of
# the receipt rather than filtered out of it: the point is to hand the owning
# card a precise finding, not to make the number green.
PRE_EXISTING = {
    ("money-card:separate-fiscal-years", "definition-list"): {
        "owner": "site/community_board_money.mjs",
        "renderer": "renderCommunityBoardMoneyCard",
        "detail": (
            "metric() wraps <dt>/<dd> in a <div> inside <dl> and appends a <small> "
            "detail as a sibling; only <dt> and <dd> are permitted there, so the "
            "grouping is announced incorrectly. Reproduces wherever a board renders "
            "both a budget and a spending metric."
        ),
    },
}

# The stylesheet the fixtures borrow so focus indicators and layout are the ones
# residents actually meet, rather than user-agent defaults.
SITE_STYLESHEETS = ["/brand.css", "/civic-documents.css", "/local_constellation.css"]

DOCUMENT_TEMPLATE = """<!doctype html>
<html lang="{lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
{styles}
</head><body><main id="main">{body}</main></body></html>
"""


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FIXTURE_DIR), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def build_corpus() -> list[dict]:
    """Ask the gate module itself for its fixtures, so the two never drift."""
    script = """
import { buildResidentCopyBoundaryCorpus, checkResidentCopyBoundary, inspectResidentCopyBoundary }
  from "./tools/resident_copy_boundary.mjs";

const positives = buildResidentCopyBoundaryCorpus().map((fixture) => ({
  id: fixture.id, state: fixture.state, locale: fixture.locale || "en",
  file: fixture.file, renderer: fixture.renderer, html: fixture.html,
  polarity: "positive",
  findings: inspectResidentCopyBoundary(fixture.html, fixture).length,
}));

// The two failures a phrase scan cannot see, rendered as documents so a browser
// can confirm they are ordinary markup that the gate — not the engine — rejects.
const rows = (count) => Array.from({ length: count }, (_, index) =>
  `<li class="node-record" data-source-record-kind="record"><div class="node-record-main"><strong>Board record ${index + 1}</strong></div>`
  + `<span class="muted node-muted">Community board file · Official board record</span></li>`).join("");
const negatives = [
  {
    id: "negative:diagnostic-section", state: "partial", locale: "en",
    file: "site/community_board_constellation.mjs", renderer: "renderCommunityBoardConstellationDocument",
    html: `<section class="node-section node-card"><h2>Unjoined source records (diagnostic)</h2><ul class="node-record-list">${rows(3)}</ul></section>`,
  },
  {
    id: "negative:unbounded-projection", state: "partial", locale: "en",
    file: "site/community_board_constellation.mjs", renderer: "renderCommunityBoardConstellationDocument",
    html: `<section class="node-section node-card"><h2>Official documents</h2><ul class="node-record-list">${rows(276)}</ul></section>`,
  },
  {
    id: "negative:untranslated-label", state: "sparse", locale: "ko",
    file: "site/outcome_not_located_state.mjs", renderer: "renderOutcomeState",
    html: `<section data-outcome-state="not_located" aria-label="onl_not_located_heading"><div class="chain-h">onl_not_located_heading</div></section>`,
  },
].map((fixture) => ({
  ...fixture, polarity: "negative",
  findings: inspectResidentCopyBoundary(fixture.html, fixture).length,
}));

process.stdout.write(JSON.stringify({
  fixtures: [...positives, ...negatives],
  corpus_findings: checkResidentCopyBoundary().length,
}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def run_axe(page) -> dict:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22_rules)
    return {
        "violations_total": len(result["violations"]),
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in gate],
        "passes": len(gate) == 0,
    }


def check_keyboard_focus(page) -> dict:
    """Walk the document with real Tab presses.

    Focus is driven from the keyboard rather than by calling .focus(), because
    :focus-visible is precisely the distinction between the two and a
    programmatic focus does not reliably set it. Each control is tagged with an
    index first: a document legitimately repeats identical controls (several
    "Open official source" links, one per record), so identity has to come from
    the element rather than from its markup.
    """
    expected = page.evaluate("""() => {
      // A control inside a closed disclosure is correctly not tab-reachable.
      // Progressive disclosure is the intended design, so open every one first
      // and require that what it reveals is then reachable.
      document.querySelectorAll('details').forEach((node) => { node.open = true; });
      const controls = [...document.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])')];
      controls.forEach((control, index) => control.setAttribute('data-kbd-index', String(index)));
      document.body.setAttribute('tabindex', '-1');
      document.body.focus();
      return controls.length;
    }""")
    reached: set[int] = set()
    without_indicator: list[str] = []
    for _ in range(expected + 3):
        if len(reached) >= expected:
            break
        page.keyboard.press("Tab")
        stop = page.evaluate("""() => {
          const node = document.activeElement;
          if (!node || !node.hasAttribute?.('data-kbd-index')) return null;
          const style = getComputedStyle(node);
          const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth || '0') > 0;
          const shadow = Boolean(style.boxShadow) && style.boxShadow !== 'none';
          return {
            index: Number(node.getAttribute('data-kbd-index')),
            markup: node.outerHTML.slice(0, 80),
            focus_visible: node.matches(':focus-visible'),
            indicator: outline || shadow,
          };
        }""")
        if not stop or stop["index"] in reached:
            continue
        reached.add(stop["index"])
        if not (stop["indicator"] and stop["focus_visible"]):
            without_indicator.append(stop["markup"])
    missed = expected - len(reached)
    return {
        "controls": expected,
        "reached_by_tab": len(reached),
        "unreachable": [f"{missed} control(s) never took keyboard focus"] if missed else [],
        "without_focus_indicator": without_indicator,
    }


def check_overflow(page, width: int) -> dict:
    return page.evaluate("""(width) => {
      const doc = document.documentElement;
      const overflowing = [...document.querySelectorAll('*')]
        .filter((node) => node.getBoundingClientRect().right > width + 1)
        .map((node) => node.tagName.toLowerCase() + (node.className ? '.' + String(node.className).split(/\\s+/)[0] : ''));
      return {
        scroll_width: doc.scrollWidth,
        viewport_width: width,
        horizontal_overflow: doc.scrollWidth > width + 1,
        overflowing_nodes: [...new Set(overflowing)].slice(0, 8),
      };
    }""", width)


def check_rendered_labels(page) -> dict:
    """Raw translation keys and machine values, read back out of the live DOM."""
    return page.evaluate("""() => {
      const text = document.body.innerText.replace(/\\s+/g, ' ');
      const names = [...document.querySelectorAll('[aria-label], [alt], [title]')]
        .map((node) => node.getAttribute('aria-label') || node.getAttribute('alt') || node.getAttribute('title'))
        .filter(Boolean).join(' ');
      const key = /(^|\\s)[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}(\\s|$)/;
      return {
        raw_key_in_visible_text: key.test(text),
        raw_key_in_accessible_name: key.test(names),
        visible_characters: text.trim().length,
      };
    }""")


def main() -> None:
    corpus = build_corpus()
    fixtures = corpus["fixtures"]
    revision = git_revision()

    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for stale in FIXTURE_DIR.glob("*.html"):
        stale.unlink()

    styles = "\n".join(f'<link rel="stylesheet" href="{href}">' for href in SITE_STYLESHEETS)
    for fixture in fixtures:
        slug = fixture["id"].replace(":", "--").replace("/", "-")
        fixture["slug"] = slug
        document = DOCUMENT_TEMPLATE.format(
            lang=fixture["locale"], title=fixture["id"], styles=styles, body=fixture["html"],
        )
        (FIXTURE_DIR / f"{slug}.html").write_text(document, encoding="utf-8")
    for href in SITE_STYLESHEETS:
        source = ROOT / "site" / href.lstrip("/")
        if source.exists():
            (FIXTURE_DIR / href.lstrip("/")).write_text(source.read_text(encoding="utf-8"), encoding="utf-8")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    captures: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for fixture in fixtures:
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                route = f"/{fixture['slug']}.html"
                page.goto(f"{base}{route}", wait_until="networkidle")

                axe_result = run_axe(page)
                keyboard = check_keyboard_focus(page)
                overflow = check_overflow(page, width)
                labels = check_rendered_labels(page)

                shot = OUT / f"{fixture['slug']}-{width}.png"
                page.screenshot(path=str(shot), full_page=True)
                digest = hashlib.sha256(shot.read_bytes()).hexdigest()

                keyboard_ok = not keyboard["unreachable"] and not keyboard["without_focus_indicator"]
                labels_ok = not labels["raw_key_in_visible_text"] and not labels["raw_key_in_accessible_name"]
                expects_findings = fixture["polarity"] == "negative"

                assertion = (
                    f"{fixture['polarity']} fixture: axe_passes={axe_result['passes']} "
                    f"keyboard_reachable_and_focus_visible={keyboard_ok} "
                    f"no_horizontal_overflow={not overflow['horizontal_overflow']} "
                    f"no_raw_dynamic_label_in_dom={labels_ok} "
                    f"boundary_gate_findings={fixture['findings']} (expected {'>0' if expects_findings else '0'})"
                )
                captures.append({
                    "fixture": fixture["id"],
                    "polarity": fixture["polarity"],
                    "state": fixture["state"],
                    "locale": fixture["locale"],
                    "owning_file": fixture["file"],
                    "owning_renderer": fixture["renderer"],
                    "route": route,
                    "viewport": {"width": width, "height": height},
                    "revision": revision,
                    "data_vintage": DATA_VINTAGE[fixture["id"].split(":", 1)[0]],
                    "axe": axe_result,
                    "keyboard": keyboard,
                    "overflow": overflow,
                    "rendered_labels": labels,
                    "boundary_gate_findings": fixture["findings"],
                    "assertion": assertion,
                    # The image itself stays local; this digest is the committed proof.
                    "screenshot_local_path": str(shot.relative_to(ROOT)),
                    "screenshot_sha256": digest,
                })
                page.close()
                context.close()
        browser.close()
    server.shutdown()

    def scoped_axe(capture: dict) -> list[dict]:
        """axe violations this card is accountable for."""
        return [
            violation for violation in capture["axe"]["failing_violations"]
            if (capture["fixture"], violation["id"]) not in PRE_EXISTING
        ]

    def holds(capture: dict) -> bool:
        positive = capture["polarity"] == "positive"
        structural = (
            not capture["keyboard"]["unreachable"]
            and not capture["keyboard"]["without_focus_indicator"]
            and not capture["overflow"]["horizontal_overflow"]
        )
        gate = (capture["boundary_gate_findings"] == 0) if positive else (capture["boundary_gate_findings"] > 0)
        if not positive:
            # A rejected fixture still has to be ordinary markup; the negative
            # label fixture is expected to show the raw key it is rejected for.
            return structural and gate and not scoped_axe(capture)
        labels = capture["rendered_labels"]
        return (
            structural and gate and not scoped_axe(capture)
            and not labels["raw_key_in_visible_text"]
            and not labels["raw_key_in_accessible_name"]
        )

    for capture in captures:
        capture["axe_scoped_failing_violations"] = scoped_axe(capture)

    inherited = [
        {
            "fixture": capture["fixture"],
            "viewport": capture["viewport"],
            "rule": violation["id"],
            "impact": violation["impact"],
            **PRE_EXISTING[(capture["fixture"], violation["id"])],
        }
        for capture in captures
        for violation in capture["axe"]["failing_violations"]
        if (capture["fixture"], violation["id"]) in PRE_EXISTING
    ]
    failures = [capture for capture in captures if not holds(capture)]
    receipt = {
        "schema": "cityscroll.resident_copy_boundary_evidence_receipt.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revision": revision,
        "data_vintage": (
            "committed Community Board sources plus literal in-fixture budget, payment "
            "and outcome records; no network, publisher, or production read at any point. "
            "Each capture records its own vintage in data_vintage."
        ),
        "viewports": [{"width": width, "height": height} for width, height in VIEWPORTS],
        "capture_convention": (
            "the manifest is the committed proof; rendered image binaries stay under "
            "the ignored local path named per capture and are never committed"
        ),
        "corpus_findings": corpus["corpus_findings"],
        "inherited_accessibility_findings": inherited,
        "inherited_note": (
            "these are real, reproducible defects in markup owned by other cards; "
            "this run reports them and does not gate on them, because fixing them "
            "changes rendered output outside this card's scope"
        ),
        "captures_passing": len(captures) - len(failures),
        "captures_total": len(captures),
        "captures": captures,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(captures)} captures under {OUT.relative_to(ROOT)}")
    if failures:
        for capture in failures:
            print(f"FAIL {capture['fixture']} @{capture['viewport']['width']}px: {capture['assertion']}", file=sys.stderr)
        sys.exit(1)
    print(f"resident-copy-boundary evidence: {len(captures)} captures passed at 390px and 1440px")
    for item in inherited:
        print(
            f"note: pre-existing {item['impact']} '{item['rule']}' in {item['owner']} "
            f"({item['renderer']}) reproduced by fixture {item['fixture']} @{item['viewport']['width']}px",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
