"""Add review annotations to the committed NLQ before/after screenshots."""

import base64
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).parents[2]
SHOT_DIR = ROOT / "docs" / "screenshots" / "nlq-deeplinks"

# Coordinates mark the same semantic region in each state: the area immediately below
# the interpreted-filter chips where replay/share controls are absent or present.
SPECS = {
    "before-390.png": (29, 846, 332, 112, "BEFORE · No link or preset controls"),
    "after-390.png": (29, 1297, 332, 288, "AFTER · Share link + saved preset controls"),
    "before-1440.png": (190, 454, 1060, 101, "BEFORE · No link or preset controls"),
    "after-1440.png": (190, 676, 1065, 211, "AFTER · Share link + saved preset controls"),
}


def annotated_html(source: Path, spec: tuple[int, int, int, int, str]) -> str:
    x, y, width, height, caption = spec
    image_data = base64.b64encode(source.read_bytes()).decode("ascii")
    caption_top = max(12, y - 58)
    arrow_top = caption_top + 42
    return f"""<!doctype html>
<meta charset="utf-8">
<style>
  * {{ box-sizing: border-box; }}
  html, body {{ margin: 0; width: 100%; background: #f5efe3; }}
  img {{ display: block; width: 100%; height: auto; }}
  .target {{
    position: absolute; left: {x}px; top: {y}px; width: {width}px; height: {height}px;
    border: 5px solid #ffd400; border-radius: 8px;
    box-shadow: 0 0 0 3px #111, 0 4px 16px rgba(0,0,0,.45);
    pointer-events: none;
  }}
  .caption {{
    position: absolute; left: {x + 10}px; top: {caption_top}px;
    max-width: min({width - 20}px, calc(100vw - {x + 20}px));
    padding: 8px 11px; border: 3px solid #ffd400; border-radius: 6px;
    background: #111; color: #fff;
    font: 800 14px/1.2 system-ui, sans-serif; letter-spacing: .01em;
    box-shadow: 0 3px 10px rgba(0,0,0,.4);
    pointer-events: none;
  }}
  .arrow {{
    position: absolute; left: {x + 28}px; top: {arrow_top}px;
    width: 5px; height: {max(18, y - arrow_top + 5)}px; background: #ffd400;
    filter: drop-shadow(0 0 1px #111); pointer-events: none;
  }}
  .arrow::after {{
    content: ""; position: absolute; left: -7px; bottom: -1px;
    border-left: 9px solid transparent; border-right: 9px solid transparent;
    border-top: 13px solid #ffd400;
  }}
</style>
<img src="data:image/png;base64,{image_data}" alt="">
<div class="caption">{caption}</div>
<div class="arrow"></div>
<div class="target"></div>
"""


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for filename, spec in SPECS.items():
            source = SHOT_DIR / filename
            width = 390 if "-390" in filename else 1440
            page = browser.new_page(viewport={"width": width, "height": 900})
            page.set_content(annotated_html(source, spec), wait_until="load")
            output = source.with_name(f"{source.stem}-annotated.png")
            page.screenshot(path=str(output), full_page=True)
            page.close()
        browser.close()


if __name__ == "__main__":
    main()
