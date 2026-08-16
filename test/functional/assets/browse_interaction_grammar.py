"""Shared six-lens browser matrix for the Browse interaction grammar gate."""

from __future__ import annotations

from dataclasses import dataclass
import re
from urllib.parse import urlparse

from playwright.sync_api import expect

from ci_waits import wait_for_locator
from i18n_fixtures import install_routes


OWNED_HOSTS = {
    "cityscroll.org",
    "www.cityscroll.org",
    "api.cityscroll.org",
    "crol-list.org",
    "www.crol-list.org",
    "api.crol-list.org",
}
NAVIGATION_ONLY_ACTION = re.compile(
    r"^(?:open (?:notice|materials|project)|copy (?:notice )?link|watch(?: this)?(?: .*)?)$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Lens:
    name: str
    slug: str
    route: str
    card_selector: str
    target_path: re.Pattern[str]
    capture_selector: str
    interaction_scope: str
    preview_title: str | None = None
    preview_copy: str | None = None
    negative_card: str | None = None
    require_external_handoff: bool = True
    require_action_rail: bool = True


LENSES = (
    Lens(
        "Contracts",
        "contracts",
        "browse/contracts/",
        "#list .money-row-card",
        re.compile(r"^/notices/[^/]+/?$"),
        "#list .money-row-card",
        "#list, #dactions, #detail > [data-export-class='actions']",
        "#detail a.money-detail-object-title",
        "#detail #dcopy",
    ),
    Lens(
        "People + organizations / Staffing",
        "staffing",
        "browse/staffing/",
        "#career-results .career-card",
        re.compile(r"^/exams/[^/]+/$"),
        "#career-results .career-card",
        "#career-results",
        negative_card="#career-results .career-card[data-status='upcoming']",
    ),
    Lens(
        "Land / zoning",
        "land",
        "browse/zoning/",
        "#llist .row",
        re.compile(r"^/browse/zoning/#land/[^/]+$"),
        "#land-results-grid",
        "#llist, #land-actions, #ldetail > .actions",
        "#ldetail a.ui-object-card-title",
        "#ldetail button[data-object-card-copy]",
    ),
    Lens(
        "Rules",
        "rules",
        "browse/rules/",
        "#rulesfeed .rules-fcard",
        re.compile(r"^/notices/[^/]+/?$"),
        "#rulesfeed .rules-fcard",
        "#rulesfeed",
        negative_card=(
            "#rulesfeed .rules-fcard:not([data-process-stage='comment-open'])"
            ":not([data-process-stage='hearing'])"
        ),
        require_external_handoff=False,
        require_action_rail=False,
    ),
    Lens(
        "Meetings",
        "meetings",
        "browse/meetings/",
        "#meetingsfeed .meetings-fcard",
        re.compile(r"^/(?:meetings|notices)/[^/]+/?$"),
        "#meetingsfeed .meetings-fcard",
        "#meetingsfeed",
    ),
    Lens(
        "Exams",
        "exams",
        "browse/exams/",
        "#career-results .career-card",
        re.compile(r"^/exams/[^/]+/$"),
        "#career-results .career-card",
        "#career-results",
        negative_card="#career-results .career-card[data-status='upcoming']",
    ),
)


def _canonical_path(page, href: str) -> str:
    return page.evaluate(
        "href => { const u = new URL(href, location.origin); return u.pathname + u.search + u.hash; }",
        href,
    )


def _effective_contrast(element) -> float:
    return element.evaluate(
        """element => {
          const channels = value => (value.match(/[\\d.]+/g) || []).slice(0, 4).map(Number);
          const rgba = value => {
            const parts = channels(value);
            return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts.length > 3 ? parts[3] : 1];
          };
          const composite = (front, back) => {
            const alpha = front[3] + back[3] * (1 - front[3]);
            if (!alpha) return [255, 255, 255, 1];
            return [0, 1, 2].map(index => (
              (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / alpha
            )).concat(alpha);
          };
          let background = [255, 255, 255, 1];
          const layers = [];
          for (let node = element; node; node = node.parentElement) {
            const color = rgba(getComputedStyle(node).backgroundColor);
            if (color[3] > 0) layers.push(color);
          }
          for (let index = layers.length - 1; index >= 0; index -= 1) {
            background = composite(layers[index], background);
          }
          const foreground = composite(rgba(getComputedStyle(element).color), background);
          const luminance = color => {
            const linear = color.slice(0, 3).map(channel => {
              const normalized = channel / 255;
              return normalized <= 0.04045
                ? normalized / 12.92
                : ((normalized + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
          };
          const light = Math.max(luminance(foreground), luminance(background));
          const dark = Math.min(luminance(foreground), luminance(background));
          return (light + 0.05) / (dark + 0.05);
        }"""
    )


def open_lens(page, base: str, lens: Lens) -> None:
    install_routes(page)
    page.goto(f"{base}{lens.route}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_locator(
        page.locator(lens.card_selector).first,
        timeout=60_000,
        label=f"{lens.name} hydrated cards",
    )
    if lens.preview_title:
        wait_for_locator(
            page.locator(lens.preview_title),
            timeout=60_000,
            label=f"{lens.name} selected preview",
        )


def _assert_external_handoffs(page, lens: Lens) -> None:
    scope = f":is({lens.interaction_scope})"
    anchors = page.locator(f"{scope} a[href]")
    local_host = urlparse(page.url).hostname
    checked = 0
    for index in range(anchors.count()):
        anchor = anchors.nth(index)
        if not anchor.is_visible():
            continue
        href = anchor.get_attribute("href") or ""
        if href.startswith(("#", "/", ".", "?")):
            continue
        parsed = urlparse(href)
        is_protocol_handoff = parsed.scheme in {"mailto", "tel"}
        if not is_protocol_handoff and (
            parsed.scheme not in {"http", "https"}
            or parsed.hostname in OWNED_HOSTS
            or parsed.hostname == local_host
        ):
            continue
        label = " ".join(anchor.inner_text().split())
        assert "↗" in label, f"{lens.name}: off-site handoff lacks visible ↗: {href} ({label!r})"
        if parsed.scheme in {"http", "https"}:
            assert anchor.get_attribute("target") == "_blank", (
                f"{lens.name}: off-site handoff must open a new tab: {href}"
            )
            rel = set((anchor.get_attribute("rel") or "").split())
            assert {"noopener", "noreferrer"} <= rel, (
                f"{lens.name}: off-site handoff lacks noopener+noreferrer: {href}"
            )
        checked += 1
    if lens.require_external_handoff:
        assert checked > 0, f"{lens.name}: fixture did not exercise an off-site handoff"


def _assert_action_context(page, lens: Lens) -> None:
    scope = f":is({lens.interaction_scope})"
    rails = page.locator(
        f"{scope} .ui-object-card-action-rail, "
        f"{scope} .next-action-rail"
    )
    if lens.require_action_rail:
        assert rails.count() > 0, f"{lens.name}: fixture did not exercise a context-backed action rail"
    for index in range(rails.count()):
        rail = rails.nth(index)
        if not rail.is_visible():
            continue
        assert rail.locator(".next-action-unavailable").count() == 0, (
            f"{lens.name}: unavailable state must not create an action rail"
        )
        controls = rail.locator("a[href], button")
        has_action_or_guide = rail.locator(
            "a.ui-external-action, a.ui-action-link, .bid-guide, .next-action-guide-lead"
        ).count() > 0
        assert has_action_or_guide, f"{lens.name}: action rail has no classified action or source-backed guide"
        for control_index in range(controls.count()):
            control = controls.nth(control_index)
            label = " ".join(control.inner_text().split())
            assert not NAVIGATION_ONLY_ACTION.match(label), (
                f"{lens.name}: navigation/utility leaked into action rail: {label!r}"
            )

    if lens.negative_card:
        passive = page.locator(lens.negative_card).first
        if passive.count() and passive.is_visible():
            assert passive.locator(".ui-object-card-action-rail, .next-action-rail").count() == 0, (
                f"{lens.name}: context-incomplete card rendered an action rail"
            )


def _assert_button_contrast(page, lens: Lens) -> None:
    scope = f":is({lens.interaction_scope})"
    controls = page.locator(
        f"{scope} .ui-object-card-copy, "
        f"{scope} .ui-object-card-action-rail a, "
        f"{scope} .next-action-list a"
    )
    checked = 0
    for index in range(controls.count()):
        control = controls.nth(index)
        if not control.is_visible():
            continue
        ratio = _effective_contrast(control)
        label = " ".join(control.inner_text().split())
        assert ratio >= 4.5, (
            f"{lens.name}: {label!r} button text contrast is {ratio:.2f}:1; WCAG AA requires 4.5:1"
        )
        checked += 1
    assert checked > 0, f"{lens.name}: no visible shared card controls were contrast-tested"


def assert_lens_grammar(page, lens: Lens, *, verify_clipboard: bool = True) -> dict[str, object]:
    cards = page.locator(lens.card_selector)
    assert cards.count() > 0, f"{lens.name}: no cards rendered"
    inspected = min(cards.count(), 3)
    first_target = ""
    for index in range(inspected):
        card = cards.nth(index)
        title = card.locator("a.ui-object-card-title")
        copy = card.locator("button.ui-object-card-copy")
        assert title.count() == 1, f"{lens.name} card {index + 1}: expected one shared title"
        assert copy.count() == 1, f"{lens.name} card {index + 1}: expected one shared Copy link"
        expect(title).to_be_visible()
        expect(copy).to_be_visible()
        glyph = title.locator(":scope > [aria-hidden='true']").first
        assert glyph.count() == 1 and glyph.inner_text().strip() == "◆", (
            f"{lens.name} card {index + 1}: canonical title lacks leading ◆"
        )
        title_path = _canonical_path(page, title.get_attribute("href") or "")
        assert lens.target_path.match(title_path), (
            f"{lens.name} card {index + 1}: non-canonical title target {title_path!r}"
        )
        copy_target = copy.get_attribute("data-object-card-copy") or ""
        assert _canonical_path(page, copy_target) == title_path, (
            f"{lens.name} card {index + 1}: Copy target differs from title "
            f"({copy_target!r} vs {title_path!r})"
        )
        assert copy.inner_text().strip() == "Copy link", (
            f"{lens.name} card {index + 1}: Copy label must be exactly 'Copy link'"
        )
        if index == 0:
            first_target = title_path

    scope = f":is({lens.interaction_scope})"
    unresolved = page.locator(f"{scope} .ui-object-card-relation-unresolved")
    for index in range(unresolved.count()):
        assert unresolved.nth(index).evaluate("element => element.tagName") != "A", (
            f"{lens.name}: unresolved relation became a link"
        )
    relations = page.locator(
        f"{scope} a.ui-object-card-relation, "
        f"{scope} a.ui-constellation-link:not(.ui-object-card-title)"
    )
    for index in range(relations.count()):
        relation = relations.nth(index)
        if relation.is_visible():
            assert "◆" in relation.inner_text(), f"{lens.name}: verified internal relation lacks ◆"

    if lens.preview_title:
        preview_title = page.locator(lens.preview_title)
        preview_path = _canonical_path(page, preview_title.get_attribute("href") or "")
        assert preview_path == first_target, (
            f"{lens.name}: selected preview target {preview_path!r} differs from row {first_target!r}"
        )
        assert "◆" in preview_title.inner_text(), f"{lens.name}: selected preview title lacks ◆"
        preview_copy = page.locator(lens.preview_copy)
        expect(preview_copy).to_be_visible()
        if preview_copy.get_attribute("data-object-card-copy"):
            assert _canonical_path(page, preview_copy.get_attribute("data-object-card-copy") or "") == first_target

    _assert_external_handoffs(page, lens)
    _assert_action_context(page, lens)
    _assert_button_contrast(page, lens)

    if verify_clipboard:
        first_copy = cards.first.locator("button.ui-object-card-copy")
        first_copy.click()
        expect(first_copy).to_have_text("Copied ✓")
        copied = page.evaluate("navigator.clipboard.readText()")
        assert _canonical_path(page, copied) == first_target, (
            f"{lens.name}: Copy control wrote {copied!r}, expected {first_target!r}"
        )

    return {
        "lens": lens.slug,
        "route": f"/{lens.route}",
        "cards_inspected": inspected,
        "canonical_target": first_target,
    }
