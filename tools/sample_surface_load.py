#!/usr/bin/env python3
"""Sample rendered interface load on CityScroll's principal public surfaces.

The live mode uses the same readiness discipline as the repository's screenshot
captures: content-bearing selectors must appear and visible skeletons must clear
before the DOM inventory is read. Fixture mode is network- and browser-free.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "ontology" / "fixtures" / "dimensions" / "surface_load.json"
DEFAULT_BASE = "https://cityscroll.org/"
READY_TIMEOUT_MS = 60_000
ACTIVE_VERB_IMPAIRED_RE = re.compile(
    r"\b(?:(?:auction\s+)?(closes|opens|ends))\s+((?:"
    r"January|February|March|April|May|June|July|August|September|October|November|December"
    r")\s+\d{1,2},\s*\d{4}|\d{4}-\d{2}-\d{2})",
    re.IGNORECASE,
)
MONTH_TO_NUMBERS = {
    "january": "01",
    "february": "02",
    "march": "03",
    "april": "04",
    "may": "05",
    "june": "06",
    "july": "07",
    "august": "08",
    "september": "09",
    "october": "10",
    "november": "11",
    "december": "12",
}


def parse_loose_date(raw):
    text = str(raw or "").strip()
    if not text:
        return None
    iso = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", text)
    if iso:
        return f"{iso.group(1)}-{iso.group(2)}-{iso.group(3)}"
    long_date = re.fullmatch(
        r"(January|February|March|April|May|June|July|August|September|October|November|December)"
        r"\s+(\d{1,2}),\s*(\d{4})",
        text,
        re.IGNORECASE,
    )
    if not long_date:
        return None
    month = MONTH_TO_NUMBERS[long_date.group(1).lower()]
    return f"{long_date.group(3)}-{month}-{int(long_date.group(2)):02d}"


def find_tense_violations(text, today):
    if not text or not today:
        return []
    findings = []
    for match in ACTIVE_VERB_IMPAIRED_RE.finditer(text):
        raw_date = match.group(2)
        parsed_date = parse_loose_date(raw_date)
        if not parsed_date:
            continue
        if parsed_date < today:
            findings.append({
                "verb": match.group(1).lower(),
                "date": parsed_date,
                "text": match.group(0),
            })
    return findings


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--live", action="store_true", help="sample the rendered live site")
    mode.add_argument("--fixture", action="store_true", help="emit the deterministic fixture")
    parser.add_argument("--base", default=os.environ.get("CROL_CAPTURE_BASE", DEFAULT_BASE))
    parser.add_argument("--only", help="sample one surface id")
    parser.add_argument("--out", type=Path, help="write JSON inventory to this path")
    parser.add_argument("--gate", action="store_true", help="exit nonzero when a sampled surface breaches a budget")
    return parser.parse_args()


def load_fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def select_definitions(inventory: dict[str, Any], only: str | None) -> list[dict[str, Any]]:
    definitions = inventory.get("definitions", [])
    selected = list(item for item in definitions if not only or item.get("id") == only)
    if only and not selected:
        raise SystemExit(f"unknown surface id: {only}")
    return selected


def fixture_inventory(source: dict[str, Any], only: str | None) -> dict[str, Any]:
    inventory = dict(source)
    if only:
        inventory["definitions"] = select_definitions(source, only)
        inventory["surfaces"] = [item for item in source.get("surfaces", []) if item.get("id") == only]
        if not inventory["surfaces"]:
            raise SystemExit(f"fixture has no sample for surface id: {only}")
    return inventory


def sample_live(source: dict[str, Any], base: str, only: str | None) -> dict[str, Any]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise SystemExit("live sampling requires Playwright: pip install playwright") from exc

    definitions = select_definitions(source, only)
    viewport = source.get("viewport") or {"width": 1440, "height": 900}
    base_url = base.rstrip("/") + "/"
    surfaces: list[dict[str, Any]] = list()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            context = browser.new_context(viewport=viewport, device_scale_factor=1)
            page = context.new_page()
            page.set_default_timeout(READY_TIMEOUT_MS)
            for definition in definitions:
                result = {
                    "id": definition["id"],
                    "label": definition["label"],
                    "route": definition["route"],
                    "file": "site/index.html",
                    "status": "incomplete",
                    "action_required": definition.get("action_required", True),
                    "budgets": definition["budgets"],
                    "measured": {},
                }
                try:
                    page.goto(f"{base_url}{definition['route']}", wait_until="domcontentloaded", timeout=30_000)
                    page.locator(definition["root_selector"]).wait_for(state="visible")
                    page.locator(definition["ready_selector"]).first.wait_for(state="visible")
                    page.wait_for_function(
                        """() => {
                          const visible = el => {
                            const style = getComputedStyle(el);
                            return style.display !== 'none' && style.visibility !== 'hidden'
                              && style.opacity !== '0' && el.getClientRects().length > 0;
                          };
                          return ![...document.querySelectorAll('.empty.skel, .skl')].some(visible);
                        }""",
                        timeout=READY_TIMEOUT_MS,
                    )
                    page.evaluate("document.fonts && document.fonts.ready")
                    result["measured"] = inventory_dom(
                        page,
                        definition["root_selector"],
                        definition["action_selector"],
                    )
                    minimum_words = int(definition.get("min_words", 50))
                    if result["measured"].get("words", 0) < minimum_words:
                        raise RuntimeError(
                            f"rendered surface has {result['measured'].get('words', 0)} words; "
                            f"expected at least {minimum_words}"
                        )
                    result["status"] = "ok"
                except Exception as exc:  # Playwright errors need to remain in the evidence artifact.
                    result["error"] = f"{type(exc).__name__}: {exc}"[:1000]
                surfaces.append(result)
        finally:
            browser.close()

    return {
        "schema": source["schema"],
        "methodology": source["methodology"],
        "viewport": viewport,
        "definitions": definitions,
        "fixture": False,
        "base_url": base_url,
        "measured_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "surfaces": surfaces,
    }


def inventory_dom(page: Any, root_selector: str, action_selector: str) -> dict[str, Any]:
    return page.evaluate(
        r"""([rootSelector, actionSelector]) => {
          const root = document.querySelector(rootSelector);
          if (!root) throw new Error(`surface root not found: ${rootSelector}`);
          const visible = el => {
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden'
              && style.opacity !== '0' && el.getClientRects().length > 0;
          };
          const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
          const words = normalize(root.innerText).match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || [];
          const links = [...root.querySelectorAll('a[href]')].filter(visible);
          const buttons = [...root.querySelectorAll('button, input[type=button], input[type=submit]')].filter(visible);
          const actionLinks = [...root.querySelectorAll(actionSelector)]
            .map(el => ({
              label: normalize(el.innerText || el.getAttribute('aria-label') || el.value || '').replace(/\\s+/g,' ').trim(),
              href: String(el.getAttribute('href') || '').trim(),
              source: String(el.getAttribute('href') || ''),
              id: String(el.id || ''),
              tag: el.tagName ? String(el.tagName).toLowerCase() : 'a',
            }))
            .filter(action => action.label && action.href);
          const candidateSelector = 'h1,h2,h3,h4,h5,h6,p,li,dt,dd,a,button,label,summary,td,th';
          const candidateElements = [...root.querySelectorAll(candidateSelector)].filter(visible);
          const candidates = candidateElements
            // Do not count one rendered phrase twice merely because a link is nested in a
            // paragraph carrying exactly the same text. Distinct DOM branches still count.
            .filter(el => ![...el.querySelectorAll(candidateSelector)]
              .filter(visible)
              .some(child => normalize(child.innerText || child.value || child.getAttribute('aria-label'))
                === normalize(el.innerText || el.value || el.getAttribute('aria-label'))))
            .map(el => normalize(el.innerText || el.value || el.getAttribute('aria-label')))
            .filter(text => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || []).length >= 6);
          const repeats = new Map();
          for (const text of candidates) repeats.set(text, (repeats.get(text) || 0) + 1);
          const duplicateRows = Array.from(repeats.entries())
            .filter(([, count]) => count > 1)
            .map(([text, count]) => ({ text, count }))
            .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
          const actions = [...document.querySelectorAll(actionSelector)].filter(visible);
          const rootY = root.getBoundingClientRect().top + scrollY;
          const firstAction = actions
            .map(el => ({ el, y: el.getBoundingClientRect().top + scrollY }))
            .sort((a, b) => a.y - b.y)[0];
          const card_facts = [...root.querySelectorAll('.fcard, [data-card]')]
            .filter(visible)
            .map((card, index) => ({
              card_id: card.getAttribute('data-request-id') || card.id || `card-${index + 1}`,
              facts: [...card.querySelectorAll('[data-card-fact]')]
                .filter(visible)
                .map(el => ({
                  key: normalize(el.getAttribute('data-card-fact')),
                  text: normalize(el.innerText || el.getAttribute('aria-label')),
                }))
                .filter(fact => fact.key),
            }))
            .filter(card => card.facts.length);
          // Empty-state / apology density: count visible blocks that apologize for
          // missing facts vs data-bearing blocks (wackness sampler).
          const apologyPhrases = [
            'not yet shown here',
            'not available yet',
            'needs both',
            'nothing is invented here',
            'no labeled minimum bid',
            'market-basket discount',
            'could not reach',
            'the city does not publish',
          ];
          const blockEls = [...root.querySelectorAll(
            '.stage, .box, .note, .lc-norecord, .property-commercial-detail > div, .chain-h, p, li, section'
          )].filter(visible);
          const empty_state_blocks = [];
          let empty_blocks = 0;
          let content_blocks = 0;
          for (const el of blockEls) {
            const text = normalize(el.innerText || '');
            if (!text || text.length < 8) continue;
            // Skip containers that only wrap the same text as a direct counted child.
            const childSame = [...el.children].some(child => {
              if (!visible(child)) return false;
              return normalize(child.innerText || '') === text;
            });
            if (childSame) continue;
            const lower = text.toLowerCase();
            const apologyHits = apologyPhrases.filter(p => lower.includes(p));
            const cls = String(el.className || '');
            const isEmptyClass = /\\blc-norecord\\b/.test(cls)
              || (/\\bnote\\b/.test(cls) && apologyHits.length > 0);
            const role = (apologyHits.length || isEmptyClass) ? 'empty' : 'content';
            if (role === 'empty') empty_blocks += 1;
            else content_blocks += 1;
            empty_state_blocks.push({ text: text.slice(0, 240), className: cls, role });
          }
          return {
            words: words.length,
            links: links.length,
            buttons: buttons.length,
            action_links: actionLinks,
            max_verbatim_repeat: duplicateRows.length ? duplicateRows[0].count : 1,
            verbatim_duplicates: duplicateRows.slice(0, 10),
            action_candidates: actions.length,
            first_action_y: firstAction ? Math.round(firstAction.y - rootY) : null,
            first_action_document_y: firstAction ? Math.round(firstAction.y) : null,
            document_height: Math.round(document.documentElement.scrollHeight),
            visible_loading_placeholders: [...root.querySelectorAll('.loading, .skel, .skl')].filter(visible).length,
            empty_blocks,
            content_blocks,
            empty_state_blocks: empty_state_blocks.slice(0, 40),
            card_facts: card_facts.slice(0, 80),
            visible_text: normalize(root.innerText).slice(0, 4000),
          };
        }""",
        [root_selector, action_selector],
    )


def breach_rows(inventory: dict[str, Any]) -> list[str]:
    rows: list[str] = list()
    apology_phrases = (
        "not yet shown here",
        "not available yet",
        "needs both",
        "nothing is invented here",
        "no labeled minimum bid",
        "market-basket discount",
        "could not reach",
        "the city does not publish",
    )
    for surface in inventory.get("surfaces", []):
        if surface.get("status") != "ok":
            rows.append(f"{surface.get('id')}: incomplete sample")
            continue
        measured = surface.get("measured", {})
        budgets = surface.get("budgets", {})
        for metric in ("words", "links", "buttons", "max_verbatim_repeat"):
            if measured.get(metric, 0) > budgets.get(metric, float("inf")):
                rows.append(f"{surface['id']}: {metric} {measured[metric]} > {budgets[metric]}")
        if surface.get("action_required", True):
            action_y = measured.get("first_action_y")
            maximum = budgets.get("max_first_action_y")
            if action_y is None:
                rows.append(f"{surface['id']}: no resident-serving action matched")
            elif maximum is not None and action_y > maximum:
                rows.append(f"{surface['id']}: first_action_y {action_y} > {maximum}")
        empty_blocks = int(measured.get("empty_blocks") or 0)
        content_blocks = int(measured.get("content_blocks") or 0)
        total_blocks = empty_blocks + content_blocks
        if total_blocks > 0 and empty_blocks / total_blocks > 0.5:
            rows.append(
                f"{surface['id']}: empty-state majority "
                f"{empty_blocks}/{total_blocks} blocks"
            )
        text = str(measured.get("visible_text") or "").lower()
        apology_hits = sum(text.count(p) for p in apology_phrases)
        if apology_hits > 1:
            rows.append(
                f"{surface['id']}: apology phrases x{apology_hits} "
                f"(threshold 1 per card)"
            )
        today = (inventory.get("measured_at") or measured.get("today") or "")[:10]
        if not today.startswith("1970") and today:
            for violation in find_tense_violations(
                str(measured.get("visible_text") or ""),
                today,
            ):
                rows.append(
                    f"{surface['id']}: tense mismatch '{violation['verb']} "
                    f"{violation['date']}' in \"{violation['text']}\""
                )
        action_links = [link for link in measured.get("action_links") or [] if isinstance(link, dict)]
        repeated = {}
        for link in action_links:
            key = (surface["id"], (link.get("label") or "").strip(), (link.get("href") or "").strip())
            repeated[key] = repeated.get(key, 0) + 1
        for (_section, label, _href), count in repeated.items():
            if count > 3:
                rows.append(
                    f"{surface['id']}: repeated identical CTA \"{label}\" x{count}"
                )
        for card in measured.get("card_facts") or []:
            seen: dict[str, int] = {}  # Source: rendered rule-card data-card-fact attributes.
            for fact in card.get("facts") or []:
                key = str(fact.get("key") or "").strip().lower()
                if key:
                    seen[key] = seen.get(key, 0) + 1
            for key, count in seen.items():
                if count > 1:
                    rows.append(
                        f"{surface['id']}: card {card.get('card_id', 'unknown')} "
                        f"repeats fact {key} x{count}"
                    )
    return rows


def main() -> None:
    args = parse_args()
    source = load_fixture()
    inventory = (
        sample_live(source, args.base, args.only)
        if args.live
        else fixture_inventory(source, args.only)
    )
    text = json.dumps(inventory, indent=2, ensure_ascii=False) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    breaches = breach_rows(inventory)
    summary = (
        f"surface-load sampled={len(inventory.get('surfaces', []))} "
        f"breaches={len(breaches)} mode={'live' if args.live else 'fixture'}"
    )
    print(summary, file=sys.stderr)
    incomplete = [
        surface.get("id", "unknown")
        for surface in inventory.get("surfaces", [])
        if surface.get("status") != "ok"
    ]
    if args.live and incomplete:
        print(f"incomplete live surfaces: {', '.join(incomplete)}", file=sys.stderr)
        raise SystemExit(2)
    if args.gate and breaches:
        print("\n".join(breaches), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
