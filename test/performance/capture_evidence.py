#!/usr/bin/env python3
"""Capture annotated responsive evidence for the performance contract."""

from __future__ import annotations

import importlib.util
import io
from pathlib import Path
import subprocess
import tarfile
import tempfile
from typing import Any

from playwright.sync_api import Browser, Page, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs" / "screenshots" / "performance-contract"
FIXTURE_PATH = ROOT / "test" / "performance" / "fixtures" / "home.cold.json"
VIEWPORTS = ((390, 844), (1440, 900))


def load_verifier() -> Any:
    path = Path(__file__).with_name("verify.py")
    spec = importlib.util.spec_from_file_location("performance_verify", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VERIFY = load_verifier()


def revision_snapshot(revision: str, destination: Path) -> None:
    result = subprocess.run(
        ["git", "archive", "--format=tar", revision],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
        archive.extractall(destination)


def cold_cls(
    browser: Browser,
    site_root: Path,
    viewport: dict[str, int],
    fixture: dict[str, Any],
) -> float:
    unexpected: list[str] = list()
    with VERIFY.StaticServer(site_root) as base_url:
        page = browser.new_page(viewport=viewport)
        VERIFY.install_routes(page, fixture, unexpected)
        VERIFY.install_observers(page)
        page.goto(base_url, wait_until="domcontentloaded")
        VERIFY.wait_for_home(page)
        score = float(page.evaluate("window.__cityscrollPerf.cls"))
        page.close()
    assert not unexpected, unexpected
    return score


def annotate(page: Page, label: str, controls_visible: bool) -> None:
    page.evaluate(
        """
        ({label, controlsVisible}) => {
          const style=document.createElement("style");
          style.textContent=`
            html{scroll-behavior:auto!important}
            .scenario-nav,#tab-money .nlbox,#tab-money .chiprow,
            #tab-money .contract-examples,#tab-money .grid,
            footer{display:none!important}
            #tab-money{padding-top:12px!important}
            body{padding-bottom:20px!important}
          `;
          document.head.append(style);

          const outline=(element, color) => {
            if(!element) return;
            const rect=element.getBoundingClientRect();
            if(!rect.width || !rect.height) return;
            const mark=document.createElement("div");
            Object.assign(mark.style,{
              position:"absolute",
              left:`${Math.max(4,rect.left+scrollX-5)}px`,
              top:`${Math.max(4,rect.top+scrollY-5)}px`,
              width:`${Math.min(document.documentElement.scrollWidth-8,rect.width+10)}px`,
              height:`${rect.height+10}px`,
              border:`4px solid ${color}`,
              borderRadius:"9px",
              boxSizing:"border-box",
              zIndex:"99998",
              pointerEvents:"none"
            });
            document.body.append(mark);
          };
          outline(document.querySelector("#todaystrip"), "#d60000");
          outline(
            document.querySelector(controlsVisible ? "#kw" : "#tab-money .filtertoggle"),
            "#005fcc"
          );

          const note=document.createElement("div");
          note.textContent=label;
          Object.assign(note.style,{
            position:"fixed",
            inset:"8px 8px auto 8px",
            background:"#111",
            color:"#fff",
            padding:"9px 12px",
            borderRadius:"6px",
            font:"800 12px/1.35 system-ui,sans-serif",
            letterSpacing:".03em",
            zIndex:"99999",
            pointerEvents:"none",
            textAlign:"center"
          });
          document.body.append(note);
        }
        """,
        {"label": label, "controlsVisible": controls_visible},
    )


def capture(
    browser: Browser,
    site_root: Path,
    state: str,
    width: int,
    height: int,
    fixture: dict[str, Any],
    cls: float,
) -> None:
    unexpected: list[str] = list()
    with VERIFY.StaticServer(site_root) as base_url:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        VERIFY.install_routes(page, fixture, unexpected)
        page.goto(base_url, wait_until="domcontentloaded")
        VERIFY.wait_for_home(page)
        page.reload(wait_until="domcontentloaded")
        VERIFY.wait_for_home(page)
        page.locator('.tabbtn[data-tab="money"]').click()

        controls_visible = page.locator("#kw").is_visible()
        expected_visible = state == "after" or width > 680
        assert controls_visible is expected_visible, {
            "state": state,
            "width": width,
            "controlsVisible": controls_visible,
        }
        label = (
            f"{state.upper()} · "
            + (
                "CONTRACT FILTERS READY · RESERVED TODAY SHELL"
                if state == "after"
                else (
                    "CONTRACT FILTERS HIDDEN · TODAY ARRIVES LATE"
                    if width <= 680
                    else "TODAY ARRIVES LATE"
                )
            )
            + f" · COLD CLS {cls:.3f}"
        )

        raw = OUTPUT / f"{state}-{width}.png"
        page.screenshot(path=str(raw), full_page=True, animations="disabled")
        annotate(page, label, controls_visible)
        annotated = OUTPUT / f"{state}-{width}-annotated.png"
        page.screenshot(path=str(annotated), full_page=True, animations="disabled")
        assert raw.stat().st_size > 10_000
        assert annotated.stat().st_size > 10_000
        context.close()
    assert not unexpected, unexpected


def main() -> None:
    fixture = VERIFY.load_json(FIXTURE_PATH)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="cityscroll-performance-before-") as temporary:
        before_root = Path(temporary)
        revision_snapshot("origin/main", before_root)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                viewport = dict(width=width, height=height)
                before_cls = cold_cls(browser, before_root, viewport, fixture)
                after_cls = cold_cls(browser, ROOT, viewport, fixture)
                capture(
                    browser,
                    before_root,
                    "before",
                    width,
                    height,
                    fixture,
                    before_cls,
                )
                capture(browser, ROOT, "after", width, height, fixture, after_cls)
            browser.close()
    print(f"Wrote responsive performance evidence to {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
