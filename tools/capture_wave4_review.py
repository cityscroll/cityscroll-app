#!/usr/bin/env python3
"""Capture Wave 4 joined-data surfaces at review widths."""

from __future__ import annotations

from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "site" / "media" / "review" / "wave4"
VIEWPORTS = ((390, 844), (1440, 900))

CITY_RECORD_HNTB = "https://a856-cityrecord.nyc.gov/RequestDetail/20260623008"
CHECKBOOK_HNTB = (
    "https://www.checkbooknyc.com/smart_search/citywide"
    "?search_term=CT184120268807929"
)
CITY_RECORD_HANYC = "https://a856-cityrecord.nyc.gov/RequestDetail/20260722019"
CHECKBOOK_HANYC = (
    "https://www.checkbooknyc.com/smart_search/citywide"
    "?search_term=CT107120278800643"
)
CITY_RECORD_OH88 = "https://a856-cityrecord.nyc.gov/RequestDetail/20260715009"
CHECKBOOK_OH88 = (
    "https://www.checkbooknyc.com/smart_search/citywide"
    "?search_term=CT182620268808706"
)


def shell(title: str, eyebrow: str, body: str) -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · CityScroll</title>
<style>
  :root {{
    --paper:#f4efe5; --paper2:#fbf8f0; --ink:#161512; --muted:#69635a;
    --rule:#c8bfb0; --ox:#7b1f2b; --ox2:#a43a46; --gold:#b88627;
    --green:#285d49; --blue:#315e72;
  }}
  * {{ box-sizing:border-box; }}
  html,body {{ margin:0; min-height:100%; background:var(--paper); color:var(--ink); }}
  body {{ font-family:Arial,Helvetica,sans-serif; overflow:hidden; }}
  a {{ color:inherit; }}
  .page {{ min-height:100vh; padding:28px clamp(24px,5vw,74px) 26px; }}
  .mast {{ display:flex; align-items:center; justify-content:space-between; gap:20px;
    border-bottom:3px double var(--ink); padding-bottom:13px; margin-bottom:27px; }}
  .brand {{ font-family:Georgia,"Times New Roman",serif; font-weight:900; font-size:30px;
    letter-spacing:-.04em; }}
  .brand span {{ color:var(--ox); }}
  .coverage {{ color:var(--muted); font-size:12px; font-weight:700; letter-spacing:.04em;
    text-transform:uppercase; text-align:right; }}
  .eyebrow {{ color:var(--ox); font-size:12px; font-weight:800; letter-spacing:.12em;
    text-transform:uppercase; margin-bottom:8px; }}
  h1 {{ font-family:Georgia,"Times New Roman",serif; font-size:clamp(34px,5vw,68px);
    line-height:.98; letter-spacing:-.045em; max-width:950px; margin:0 0 13px; }}
  .dek {{ font-family:Georgia,"Times New Roman",serif; color:#4f4942; font-size:19px;
    line-height:1.4; max-width:870px; margin:0; }}
  .lede {{ margin-bottom:27px; }}
  .kicker {{ display:flex; gap:9px; flex-wrap:wrap; margin-top:16px; }}
  .chip {{ border:1px solid var(--rule); background:rgba(255,255,255,.35); border-radius:99px;
    padding:6px 10px; font-size:11px; font-weight:800; letter-spacing:.04em; }}
  .chip.ox {{ border-color:var(--ox); color:var(--ox); }}
  .source {{ color:var(--blue); text-decoration-thickness:1px; text-underline-offset:3px; }}
  .card {{ background:var(--paper2); border:1px solid var(--rule); border-radius:4px;
    box-shadow:0 10px 28px rgba(40,28,18,.06); }}
  .mono {{ font-family:"SFMono-Regular",Consolas,monospace; font-size:.92em; }}
  .section-label {{ color:var(--muted); font-size:11px; font-weight:800; letter-spacing:.11em;
    text-transform:uppercase; }}
  .record-title {{ font-family:Georgia,"Times New Roman",serif; font-weight:700; }}
  .footer {{ display:flex; justify-content:space-between; align-items:center; gap:18px;
    margin-top:17px; padding-top:12px; border-top:1px solid var(--rule); color:var(--muted);
    font-size:11px; }}
  .footer strong {{ color:var(--ink); }}

  .timeline {{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); padding:26px 22px 22px; }}
  .event {{ position:relative; min-width:0; padding:37px 20px 4px; border-top:4px solid var(--rule); }}
  .event::before {{ content:""; position:absolute; width:18px; height:18px; border:4px solid var(--paper2);
    border-radius:50%; top:-11px; left:18px; background:var(--ox); box-shadow:0 0 0 1px var(--ox); }}
  .event.money::before {{ background:var(--green); box-shadow:0 0 0 1px var(--green); }}
  .event .date {{ font-family:Georgia,"Times New Roman",serif; font-size:25px; font-weight:800; }}
  .event .name {{ color:var(--ox); font-weight:800; margin:5px 0 8px; }}
  .event p {{ color:var(--muted); font-size:12px; line-height:1.45; margin:0; }}

  .money-grid {{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1px;
    background:var(--rule); border:1px solid var(--rule); }}
  .metric {{ background:var(--paper2); padding:24px; min-width:0; }}
  .metric .number {{ font-family:Georgia,"Times New Roman",serif; font-weight:900;
    font-size:clamp(30px,4vw,54px); line-height:1; margin:8px 0 6px; }}
  .metric .caption {{ color:var(--muted); font-size:12px; line-height:1.45; }}
  .money-detail {{ display:grid; grid-template-columns:1.5fr 1fr; gap:22px; padding:22px 24px; }}
  .progress {{ height:10px; background:#ded6c8; border-radius:20px; overflow:hidden; margin:13px 0 9px; }}
  .progress span {{ display:block; width:2px; height:100%; background:var(--green); }}
  .facts {{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }}
  .fact {{ border-left:3px solid var(--gold); padding-left:11px; min-width:0; }}
  .fact b {{ display:block; margin-top:3px; overflow-wrap:anywhere; }}

  .alarm-grid {{ display:grid; grid-template-columns:1fr 1fr; gap:18px; }}
  .alarm {{ padding:21px 22px 19px; border-top:5px solid var(--ox); }}
  .alarm-top {{ display:flex; justify-content:space-between; gap:14px; align-items:flex-start; }}
  .alarm h2 {{ font-family:Georgia,"Times New Roman",serif; font-size:21px; line-height:1.13;
    margin:6px 0 8px; }}
  .days {{ flex:0 0 auto; border:1px solid var(--ox); color:var(--ox); padding:8px;
    font-weight:900; font-size:17px; text-align:center; }}
  .days small {{ display:block; font-size:9px; letter-spacing:.08em; text-transform:uppercase; }}
  .equation {{ display:flex; gap:6px; align-items:center; flex-wrap:wrap; background:#eee7dc;
    padding:9px 10px; margin:12px 0; font-size:12px; }}
  .equation b {{ color:var(--ox); }}
  .judgment {{ margin-top:14px; border-left:4px solid var(--gold); padding:8px 12px;
    color:#554f47; font:italic 15px/1.35 Georgia,serif; }}

  .queue {{ overflow:hidden; }}
  .queue-head,.queue-row {{ display:grid; grid-template-columns:54px minmax(0,2.2fr) 95px minmax(260px,1.15fr) 96px;
    gap:14px; align-items:center; }}
  .queue-head {{ padding:10px 18px; background:var(--ink); color:white; font-size:10px;
    letter-spacing:.1em; text-transform:uppercase; font-weight:800; }}
  .queue-row {{ padding:15px 18px; border-bottom:1px solid var(--rule); }}
  .queue-row:last-child {{ border-bottom:0; }}
  .rank {{ font:900 30px/1 Georgia,serif; color:var(--ox); }}
  .queue-title {{ font-family:Georgia,"Times New Roman",serif; font-weight:800; line-height:1.17; }}
  .queue-title small {{ display:block; color:var(--muted); font:11px/1.3 Arial,sans-serif; margin-top:5px; }}
  .score {{ font:900 33px/1 Georgia,serif; text-align:center; }}
  .score small {{ display:block; color:var(--muted); font:9px/1.2 Arial,sans-serif; letter-spacing:.08em;
    text-transform:uppercase; margin-top:4px; }}
  .parts {{ display:flex; flex-wrap:wrap; gap:5px; }}
  .part {{ background:#eee7dc; border-radius:2px; padding:5px 7px; font-size:10px; font-weight:700; }}
  .open {{ color:var(--ox); font-weight:800; font-size:12px; text-align:right; }}

  @media (max-width:600px) {{
    .page {{ padding:16px 14px 13px; }}
    .mast {{ margin-bottom:16px; padding-bottom:9px; }}
    .brand {{ font-size:24px; }}
    .coverage {{ font-size:8px; max-width:160px; }}
    .lede {{ margin-bottom:16px; }}
    h1 {{ font-size:35px; margin-bottom:8px; }}
    .dek {{ font-size:14px; line-height:1.32; }}
    .kicker {{ margin-top:10px; gap:5px; }}
    .chip {{ padding:4px 7px; font-size:9px; }}
    .footer {{ margin-top:9px; padding-top:8px; font-size:9px; }}
    .timeline {{ grid-template-columns:1fr; padding:13px 14px; }}
    .event {{ border-top:0; border-left:3px solid var(--rule); padding:3px 8px 11px 27px; }}
    .event:last-child {{ padding-bottom:2px; }}
    .event::before {{ width:13px; height:13px; border-width:3px; top:4px; left:-8px; }}
    .event .date {{ font-size:17px; }}
    .event .name {{ display:inline; margin-left:6px; font-size:12px; }}
    .event p {{ font-size:10px; margin-top:3px; }}
    .money-grid {{ grid-template-columns:1fr; }}
    .metric {{ display:grid; grid-template-columns:1fr 1.2fr; align-items:center; padding:11px 13px; }}
    .metric .number {{ font-size:25px; margin:0; text-align:right; }}
    .metric .caption {{ grid-column:1/-1; margin-top:3px; font-size:9px; }}
    .money-detail {{ grid-template-columns:1fr; padding:12px 14px; gap:10px; }}
    .progress {{ margin:7px 0 5px; }}
    .facts {{ gap:8px; }}
    .fact {{ font-size:10px; }}
    .alarm-grid {{ grid-template-columns:1fr; gap:10px; }}
    .alarm {{ padding:12px 13px 10px; border-top-width:4px; }}
    .alarm h2 {{ font-size:16px; margin:3px 0 4px; }}
    .days {{ padding:5px; font-size:14px; }}
    .equation {{ padding:6px 7px; margin:7px 0; font-size:9px; }}
    .alarm .record-title {{ font-size:11px; }}
    .judgment {{ margin-top:9px; font-size:12px; padding:6px 9px; }}
    .queue-head {{ display:none; }}
    .queue-row {{ grid-template-columns:30px minmax(0,1fr) 45px; gap:8px; padding:10px 11px; }}
    .rank {{ font-size:22px; }}
    .queue-title {{ font-size:12px; }}
    .queue-title small {{ font-size:8px; }}
    .score {{ font-size:21px; }}
    .parts {{ grid-column:2/-1; }}
    .part {{ font-size:8px; padding:3px 5px; }}
    .open {{ display:none; }}
  }}
</style>
</head>
<body>
<main class="page">
  <header class="mast">
    <div class="brand">CROL<span>—</span>LIST</div>
    <div class="coverage">Joined City Record + Checkbook NYC<br>Source coverage through July 29, 2026</div>
  </header>
  <section class="lede">
    <div class="eyebrow">{eyebrow}</div>
    <h1>{title}</h1>
    {body}
  </section>
</main>
</body>
</html>"""


def spine() -> str:
    return shell(
        "One contract, one complete timeline",
        "Contract spine · PIN 84124P0003001",
        f"""
<p class="dek">Follow the 21st Avenue bridge engineering contract from service start through
registration, publication, and payment.</p>
<div class="kicker">
  <span class="chip ox">Transportation</span><span class="chip">HNTB New York Engineering</span>
  <span class="chip mono">CT184120268807929</span>
</div>
</section>
<section class="card timeline">
  <article class="event"><div class="date">Oct 11, 2024</div><span class="name">Contract began</span>
    <p>Contract term start reported by Checkbook NYC.</p></article>
  <article class="event"><div class="date">Jun 22, 2026</div><span class="name">Registered</span>
    <p>Registered contract amount: $13,533,763.08.</p></article>
  <article class="event"><div class="date">Jun 29, 2026</div><span class="name">Award published</span>
    <p>City Record request 20260623008 connects the award to the same PIN.</p></article>
  <article class="event money"><div class="date">$0</div><span class="name">Paid to date</span>
    <p>Current Checkbook NYC spending against the registered contract.</p></article>
</section>
<footer class="footer"><strong class="record-title">TD/CSS for 21st Ave Bridge over the NYCTA Sea Beach Line</strong>
  <span><a class="source" href="{CITY_RECORD_HNTB}">City Record</a> ·
  <a class="source" href="{CHECKBOOK_HNTB}">Checkbook NYC</a></span></footer>
""",
    )


def dollars() -> str:
    return shell(
        "Follow every public dollar",
        "Contract money · PIN 84124P0003001",
        f"""
<p class="dek">The award notice and registered contract resolve into one money trail with
commitment, payment, and source context kept distinct.</p>
<div class="kicker"><span class="chip ox">Construction-related services</span>
  <span class="chip">Method: request for proposals</span></div>
</section>
<section class="card">
  <div class="money-grid">
    <article class="metric"><span class="section-label">Award notice</span>
      <div class="number">$13.534M</div><div class="caption">City Record award value published June 29, 2026.</div></article>
    <article class="metric"><span class="section-label">Registered commitment</span>
      <div class="number">$13.534M</div><div class="caption">Checkbook NYC current contract amount: $13,533,763.08.</div></article>
    <article class="metric"><span class="section-label">Paid to date</span>
      <div class="number">$0</div><div class="caption">Payments recorded against this contract through the coverage date.</div></article>
  </div>
  <div class="money-detail">
    <div><span class="section-label">Commitment → spending</span>
      <div class="progress"><span></span></div>
      <div style="display:flex;justify-content:space-between;color:var(--muted);font-size:11px">
        <span>$0 paid</span><span>$13,533,763.08 committed</span></div></div>
    <div class="facts">
      <div class="fact"><span class="section-label">Registered</span><b>Jun 22, 2026</b></div>
      <div class="fact"><span class="section-label">Contract ID</span><b class="mono">CT184120268807929</b></div>
    </div>
  </div>
</section>
<footer class="footer"><strong class="record-title">HNTB New York Engineering and Architecture, P.C.</strong>
  <span><a class="source" href="{CITY_RECORD_HNTB}">Award source</a> ·
  <a class="source" href="{CHECKBOOK_HNTB}">Contract source</a></span></footer>
""",
    )


def alarms() -> str:
    return shell(
        "Dates that deserve a closer look",
        "Standing integrity alarms",
        f"""
<p class="dek">Repeatable rules compare joined public dates and place the triggering facts,
sources, and counterfactual together for review.</p>
<div class="kicker"><span class="chip ox">2 active date-order leads</span>
  <span class="chip">Publication follows service start</span></div>
</section>
<section class="alarm-grid">
  <article class="card alarm">
    <div class="alarm-top"><div><span class="section-label">PIN 84124P0003001</span>
      <h2>21st Avenue bridge engineering</h2></div><div class="days">626<small>days</small></div></div>
    <div class="record-title">Transportation · HNTB New York Engineering</div>
    <div class="equation"><span>Service start <b>Oct 11, 2024</b></span><span>→</span>
      <span>publication <b>Jun 29, 2026</b></span></div>
    <span class="chip"><a class="source" href="{CHECKBOOK_HNTB}">contract date</a></span>
    <span class="chip"><a class="source" href="{CITY_RECORD_HNTB}">notice date</a></span>
  </article>
  <article class="card alarm">
    <div class="alarm-top"><div><span class="section-label">PIN 07124N0007001R001</span>
      <h2>Emergency-program hotel management</h2></div><div class="days">27<small>days</small></div></div>
    <div class="record-title">Homeless Services · HANYC Foundation Inc.</div>
    <div class="equation"><span>Service start <b>Jul 1, 2026</b></span><span>→</span>
      <span>publication <b>Jul 28, 2026</b></span></div>
    <span class="chip"><a class="source" href="{CHECKBOOK_HANYC}">contract date</a></span>
    <span class="chip"><a class="source" href="{CITY_RECORD_HANYC}">notice date</a></span>
  </article>
</section>
<div class="judgment">Review leads organize human attention; they are not findings.</div>
<footer class="footer"><strong>Counterfactual shown on every lead:</strong>
  <span>The notice date is on or before the service start date.</span></footer>
""",
    )


def review_queue() -> str:
    return shell(
        "Start with the records that carry the strongest signals",
        "Public-interest review queue",
        f"""
<p class="dek">Visible scoring components turn joined amount, method, alarm, and coverage facts
into a reproducible order for investigation.</p>
<div class="kicker"><span class="chip ox">51,563 award amounts compared</span>
  <span class="chip">Every component removable</span><span class="chip">Every row opens an investigation</span></div>
</section>
<section class="card queue">
  <div class="queue-head"><span>Rank</span><span>Procurement</span><span>Score</span><span>Visible components</span><span>Action</span></div>
  <article class="queue-row"><div class="rank">1</div>
    <div class="queue-title">Hotel Management Services for DHS Emergency Programs
      <small>Homeless Services · HANYC Foundation · <span class="mono">07124N0007001R001</span></small></div>
    <div class="score">28<small>priority</small></div>
    <div class="parts"><span class="part">amount 18</span><span class="part">date alarm 8</span><span class="part">coverage 2</span></div>
    <div class="open"><a href="{CITY_RECORD_HANYC}">Open record →</a></div></article>
  <article class="queue-row"><div class="rank">2</div>
    <div class="queue-title">21st Ave Bridge over the NYCTA Sea Beach Line
      <small>Transportation · HNTB New York Engineering · <span class="mono">84124P0003001</span></small></div>
    <div class="score">27<small>priority</small></div>
    <div class="parts"><span class="part">amount 17</span><span class="part">date alarm 8</span><span class="part">coverage 2</span></div>
    <div class="open"><a href="{CITY_RECORD_HNTB}">Open record →</a></div></article>
  <article class="queue-row"><div class="rank">3</div>
    <div class="queue-title">Owls Head WWTP Final Settling System Rehabilitation
      <small>Environmental Protection · Welkin Mechanical · <span class="mono">82626B0029001</span></small></div>
    <div class="score">20<small>priority</small></div>
    <div class="parts"><span class="part">amount 18</span><span class="part">coverage 2</span></div>
    <div class="open"><a href="{CITY_RECORD_OH88}">Open record →</a></div></article>
</section>
<footer class="footer"><strong>No responsive-bid record found for PIN 07124N0007001R001 in the joined fields.</strong>
  <span><a class="source" href="{CHECKBOOK_HANYC}">Registered contract</a> ·
  <a class="source" href="{CHECKBOOK_OH88}">Owls Head contract</a></span></footer>
""",
    )


SURFACES = {
    "spine": spine,
    "dollars": dollars,
    "alarms": alarms,
    "review": review_queue,
}


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for name, render in SURFACES.items():
                html = render()
                assert "preview" not in html.lower()
                assert "beta" not in html.lower()
                for width, height in VIEWPORTS:
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        device_scale_factor=1,
                    )
                    page = context.new_page()
                    errors: list[str] = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.set_content(html, wait_until="load")
                    page.evaluate("document.fonts && document.fonts.ready")
                    page.wait_for_timeout(100)
                    metrics = page.evaluate(
                        """() => ({
                          scrollWidth: document.documentElement.scrollWidth,
                          clientWidth: document.documentElement.clientWidth,
                          scrollHeight: document.documentElement.scrollHeight,
                          clientHeight: document.documentElement.clientHeight
                        })"""
                    )
                    assert metrics["scrollWidth"] == metrics["clientWidth"], (name, width, metrics)
                    assert metrics["scrollHeight"] <= metrics["clientHeight"], (name, width, metrics)
                    assert not errors, f"{name}-{width}: page errors: {errors}"
                    output = OUTPUT / f"{name}-{width}.png"
                    page.screenshot(path=str(output), full_page=False)
                    image = Image.open(output)
                    assert image.size == (width, height), f"{output.name}: got {image.size}"
                    print(f"{output.relative_to(ROOT)} {image.size}")
                    context.close()
        finally:
            browser.close()


if __name__ == "__main__":
    main()
