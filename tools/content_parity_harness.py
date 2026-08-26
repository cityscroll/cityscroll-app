#!/usr/bin/env python3
"""Before/after content-parity gate for performance changes.

The harness runs against a local site artifact.  Capture labels are deliberately
just labels: build or serve the baseline and candidate separately, then run:

    python3 tools/content_parity_harness.py capture --ref baseline
    python3 tools/content_parity_harness.py capture --ref candidate
    python3 tools/content_parity_harness.py compare --before baseline --after candidate

Content is captured from surface-owned records and controls, not from incidental
markup.  Additive content is allowed; every baseline record, field, and control
must still be present in the candidate.  Intentional losses require an explicit,
reasoned allow file (see docs/content-parity-harness.md).
"""

from __future__ import annotations

import argparse
import hashlib
import html
import importlib.util
import json
import math
import os
import sys
import time
import struct
import zlib
from pathlib import Path
from typing import Any
from urllib.parse import urljoin


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / ".artifacts" / "content-parity"
VIEWPORTS = {
    "mobile": {"width": 390, "height": 844},
    "desktop": {"width": 1440, "height": 900},
}

# These are the public, real local routes used by the existing RUM e2e harness.
# Selectors intentionally name content owners rather than implementation details.
SURFACES: dict[str, dict[str, str]] = {
    "home": {
        "path": "/",
        "root": "main#main",
        "ready": "body[data-home-ready='true']",
        "component": "[data-home-topic-entry]",
        "records": "[data-home-topic-entry], #homeCta",
        "controls": "[data-home-topic-entry] a, [data-home-topic-entry] button, [data-home-topic-entry] input, #homeCta a, #homeCta button, #homeCta input",
    },
    "near-you": {
        "path": "/near-you/",
        "root": "main[data-near-you-root]",
        "ready": "main[data-near-you-root]",
        "component": "[data-near-surface-panel='list'], [data-near-surface-switch]",
        "records": "[data-record-id]",
        "controls": "[data-near-you-root] a, [data-near-you-root] button, [data-near-you-root] input, [data-near-you-root] select, [data-near-you-root] summary",
    },
    "following": {
        "path": "/following/",
        "root": "main[data-following-root]",
        "ready": "main[data-following-root]",
        "component": "[data-following-preview-form], [data-following-panel='create']",
        "records": "[data-pack-id], [data-following-pack-watch], [data-following-preview-form], [data-personal-watch-list]",
        "controls": "[data-following-root] a, [data-following-root] button, [data-following-root] input, [data-following-root] select, [data-following-root] summary",
    },
    "browse-contracts": {
        "path": "/browse/contracts/",
        "root": "main#main",
        "ready": "#list .money-row-card, #list .row:not(.skel), [data-primary-context='money']",
        "component": "#list .money-row-card, #list .row:not(.skel), [data-app-ready='true']",
        "records": ".money-row-card, #list .row:not(.skel), #list [data-record-id]",
        "controls": "#main a, #main button, #main input, #main select, #main summary",
    },
    "notice": {
        # The local static server serves the shared shell for clean notice URLs. The
        # client route is the repository's canonical local deep-link form; production
        # edge rendering still supplies the same notice fixture on the clean URL.
        # This award fixture exercises the resident-snapshot branches whose completion
        # previously gated Notice context readiness.
        "path": "/#notice/20260701003",
        "root": "#noticeview, main#main",
        "ready": "[data-edge-rendered='notice'], [data-edge-rendered='notice-unavailable'], #noticeview [data-notice-id], #noticeview .notice-body",
        # New Notice context owners mark the first useful/terminal card separately from
        # the settled boundary used for content extraction. The fallback keeps captures
        # readable against a baseline artifact that predates the marker.
        "component_first": "#noticeview #ncontext[data-notice-context-ready='true']",
        "component_first_required": True,
        "component": "[data-edge-rendered='notice'], [data-edge-rendered='notice-unavailable'], #noticeview [data-notice-id]",
        "settled": "#noticeview #ncontext[data-notice-context-settled='true']",
        "settled_required": True,
        "records": "[data-edge-rendered], #noticeview [data-notice-id], #noticeview .notice-body",
        "controls": "#noticeview a, #noticeview button, #noticeview input, #noticeview select, #noticeview summary",
    },
    "agency": {
        "path": "/agencies/office-of-the-mayor/",
        "root": "main[data-civic-object-kind='agency-constellation']",
        "ready": "main[data-civic-object-kind='agency-constellation']",
        "component": "main[data-civic-object-kind='agency-constellation']",
        "records": "main[data-civic-object-kind='agency-constellation'], [data-edge-summary-item], .node-record",
        "controls": "main[data-civic-object-kind='agency-constellation'] a, main[data-civic-object-kind='agency-constellation'] button, main[data-civic-object-kind='agency-constellation'] summary",
    },
}


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fingerprint(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def percentile(values: list[float], p: float = 0.75) -> float | None:
    if not values:
        return None
    ordered = sorted(float(value) for value in values)
    if len(ordered) == 1:
        return round(ordered[0], 3)
    position = (len(ordered) - 1) * p
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return round(ordered[lower], 3)
    value = ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)
    return round(value, 3)


def load_fixture_routes(page: Any) -> None:
    """Install the repository's hermetic Playwright fixture network routes."""
    fixture = ROOT / "test" / "functional" / "assets" / "i18n_fixtures.py"
    spec = importlib.util.spec_from_file_location("cityscroll_i18n_fixtures", fixture)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load fixture routes: {fixture}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.install_routes(page)


EXTRACT_JS = r"""
({surface, rootSelector, recordSelector, controlSelector}) => {
  const root = document.querySelector(rootSelector) || document.querySelector('main') || document.body;
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = el => {
    if (!el || el.closest('script,style,template,[aria-hidden="true"]')) return false;
    const style = getComputedStyle(el), rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const attrs = el => {
    const result = {};
    for (const name of ['href', 'aria-label', 'role', 'name', 'type', 'value', 'data-record-id',
      'data-notice-id', 'data-civic-object-id', 'data-subject-ref', 'data-pack-id',
      'data-following-scope-axis', 'data-following-scope-value', 'data-pivot-target-kind',
      'data-pivot-target-id', 'data-edge-status', 'data-edge-state']) {
      if (el.hasAttribute(name)) result[name] = compact(el.getAttribute(name));
    }
    return result;
  };
  const identity = (el, index, kind) => {
    const data = el.dataset || {};
    const id = data.recordId || data.noticeId || data.civicObjectId || data.subjectRef || data.packId
      || el.getAttribute('href') || el.id || `${kind}-${index + 1}`;
    return `${kind}:${compact(id)}`;
  };
  const text = el => compact(el.innerText || el.textContent || '');
  const recordNodes = [...root.querySelectorAll(recordSelector)].filter(visible);
  const records = [];
  const seenRecords = new Set();
  for (const [index, el] of recordNodes.entries()) {
    const key = identity(el, index, 'record');
    if (seenRecords.has(key)) continue;
    seenRecords.add(key);
    const value = text(el);
    records.push({key, fields: {text: value}, attributes: attrs(el), text: value.slice(0, 500)});
  }
  const controlNodes = [...root.querySelectorAll(controlSelector)].filter(visible);
  const controls = [];
  const seenControls = new Set();
  for (const [index, el] of controlNodes.entries()) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    const data = attrs(el);
    const label = compact(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '');
    const key = `${el.tagName.toLowerCase()}:${data.name || el.id || data.href || data['data-following-scope-value'] || index}`;
    const signature = `${key}:${label}:${data.href || ''}:${data.value || ''}`;
    if (seenControls.has(signature)) continue;
    seenControls.add(signature);
    controls.push({key, signature, label, attributes: data});
  }
  records.sort((a, b) => a.key.localeCompare(b.key));
  controls.sort((a, b) => a.signature.localeCompare(b.signature));
  const meaningfulText = text(root);
  return {
    schema: 'cityscroll.content_parity_capture.v1', surface,
    identity: attrs(root),
    records, controls,
    counts: {records: records.length, controls: controls.length},
    meaningful_text_length: meaningfulText.length,
  };
}
"""


def wait_for(page: Any, selector: str, timeout_ms: int) -> None:
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

    try:
        page.wait_for_selector(selector, state="attached", timeout=timeout_ms)
    except PlaywrightTimeoutError as exc:
        raise RuntimeError(f"readiness selector timed out: {selector}") from exc


def wait_for_component(page: Any, config: dict[str, str], timeout_ms: int) -> None:
    first = config.get("component_first")
    if first and config.get("component_first_required"):
        wait_for(page, first, timeout_ms)
        return
    if first and page.locator(first).count():
        wait_for(page, first, timeout_ms)
        return
    wait_for(page, config["component"], timeout_ms)


def wait_for_settled(page: Any, config: dict[str, str], timeout_ms: int) -> None:
    settled = config.get("settled")
    if settled and config.get("settled_required"):
        wait_for(page, settled, timeout_ms)
    elif settled and page.locator(settled).count():
        wait_for(page, settled, timeout_ms)


def browser_metrics(page: Any) -> dict[str, Any]:
    return page.evaluate(
        """() => {
          const nav = performance.getEntriesByType('navigation')[0] || {};
          const paints = Object.fromEntries(performance.getEntriesByType('paint').map(e => [e.name, e.startTime]));
          return {
            content_ready_ms: performance.now(),
            component_ready_ms: performance.now(),
            first_paint_ms: paints['first-paint'] ?? null,
            first_contentful_paint_ms: paints['first-contentful-paint'] ?? null,
            dom_content_loaded_ms: nav.domContentLoadedEventEnd ?? null,
            load_event_end_ms: nav.loadEventEnd ?? null,
          };
        }"""
    )


def capture_viewport(
    browser: Any,
    surface: str,
    ref: str,
    base: str,
    output: Path,
    viewport_name: str,
    runs: int,
    timeout_ms: int,
    use_fixtures: bool,
) -> dict[str, Any]:
    config = SURFACES[surface]
    samples: list[dict[str, Any]] = []
    content: dict[str, Any] | None = None
    screenshot = output / ref / surface / f"{viewport_name}.png"
    screenshot.parent.mkdir(parents=True, exist_ok=True)

    for run in range(runs):
        context = browser.new_context(viewport=VIEWPORTS[viewport_name], device_scale_factor=1)
        page = context.new_page()
        if use_fixtures:
            load_fixture_routes(page)
        started = time.perf_counter()
        page.goto(urljoin(base.rstrip("/") + "/", config["path"].lstrip("/")), wait_until="domcontentloaded", timeout=timeout_ms)
        wait_for(page, config["ready"], timeout_ms)
        content_ready = page.evaluate("performance.now()")
        wait_for_component(page, config, timeout_ms)
        component_ready = page.evaluate("performance.now()")
        wait_for_settled(page, config, timeout_ms)
        page.wait_for_timeout(100)
        metrics = browser_metrics(page)
        metrics["content_ready_ms"] = round(float(content_ready), 3)
        metrics["component_ready_ms"] = round(float(component_ready), 3)
        metrics["wall_clock_ms"] = round((time.perf_counter() - started) * 1000, 3)
        samples.append(metrics)
        if content is None:
            content = page.evaluate(EXTRACT_JS, {
                "surface": surface,
                "rootSelector": config["root"],
                "recordSelector": config["records"],
                "controlSelector": config["controls"],
            })
            page.screenshot(path=str(screenshot), full_page=True)
        context.close()

    assert content is not None
    metric_names = sorted(samples[0])
    p75 = {name: percentile([float(sample[name]) for sample in samples if isinstance(sample.get(name), (int, float))])
           for name in metric_names}
    content["fingerprint"] = fingerprint(content)
    return {
        "viewport": viewport_name,
        "screenshot": str(screenshot.relative_to(output)),
        "content": content,
        "metrics": {"p75": p75, "samples": samples},
    }


def capture(args: argparse.Namespace) -> int:
    if args.ref.strip() in {"", ".", ".."} or "/" in args.ref or "\\" in args.ref:
        raise SystemExit("--ref must be a simple capture label")
    base = args.base or os.environ.get("CROL_BASE")
    if not base:
        raise SystemExit("--base or CROL_BASE is required")
    surfaces = selected_surfaces(args.surfaces)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": "cityscroll.content_parity_capture_manifest.v1",
        "ref": args.ref,
        "base": base,
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runs": args.runs,
        "viewports": list(VIEWPORTS),
        "surfaces": {},
    }
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for surface in surfaces:
                manifest["surfaces"][surface] = {
                    viewport: capture_viewport(
                        browser, surface, args.ref, base, output, viewport, args.runs,
                        args.timeout_ms, not args.no_fixtures,
                    )
                    for viewport in VIEWPORTS
                }
        finally:
            browser.close()
    (output / args.ref).mkdir(parents=True, exist_ok=True)
    (output / args.ref / "capture.json").write_text(canonical_json(manifest) + "\n", encoding="utf-8")
    print(f"captured {len(surfaces)} surfaces for {args.ref} under {output / args.ref}")
    return 0


def selected_surfaces(value: str | None) -> list[str]:
    chosen = [part.strip() for part in (value or ",".join(SURFACES)).split(",") if part.strip()]
    unknown = sorted(set(chosen) - set(SURFACES))
    if unknown:
        raise SystemExit(f"unknown surface(s): {', '.join(unknown)}")
    return chosen


def load_capture(output: Path, ref: str) -> dict[str, Any]:
    path = output / ref / "capture.json"
    if not path.is_file():
        raise SystemExit(f"capture not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def load_allow_file(path: str | None) -> dict[tuple[str, str, str], str]:
    if not path:
        return {}
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if payload.get("schema") != "cityscroll.content_parity_allow.v1":
        raise SystemExit("allow file must declare cityscroll.content_parity_allow.v1")
    allowed: dict[tuple[str, str, str], str] = {}
    for change in payload.get("changes", []):
        if not all(isinstance(change.get(key), str) and change[key].strip() for key in ("surface", "kind", "key", "reason")):
            raise SystemExit("every allow-file change needs surface, kind, key, and reason")
        allowed[(change["surface"], change["kind"], change["key"])] = change["reason"]
    return allowed


def compare_content(before: dict[str, Any], after: dict[str, Any], surface: str, allowed: dict[tuple[str, str, str], str]) -> dict[str, Any]:
    missing: list[dict[str, str]] = []
    allowed_losses: list[dict[str, str]] = []
    after_records = {item["key"]: item for item in after.get("records", [])}
    for record in before.get("records", []):
        key = record["key"]
        if key not in after_records:
            loss = {"kind": "record", "key": key, "detail": record.get("text", "")[:180]}
            reason = allowed.get((surface, "record", key))
            (allowed_losses if reason else missing).append({**loss, **({"reason": reason} if reason else {})})
            continue
        candidate = after_records[key]
        for field, value in record.get("fields", {}).items():
            if value and value not in candidate.get("fields", {}).get(field, ""):
                loss = {"kind": "field", "key": f"{key}.{field}", "detail": value[:180]}
                reason = allowed.get((surface, "field", f"{key}.{field}"))
                (allowed_losses if reason else missing).append({**loss, **({"reason": reason} if reason else {})})
    after_controls = {item["signature"]: item for item in after.get("controls", [])}
    for control in before.get("controls", []):
        key = control["signature"]
        if key not in after_controls:
            loss = {"kind": "control", "key": key, "detail": control.get("label", "")[:180]}
            reason = allowed.get((surface, "control", key))
            (allowed_losses if reason else missing).append({**loss, **({"reason": reason} if reason else {})})
    return {
        "verdict": "PASS" if not missing else "FAIL",
        "missing": missing,
        "allowed_losses": allowed_losses,
        "before_record_count": len(before.get("records", [])),
        "after_record_count": len(after.get("records", [])),
        "before_control_count": len(before.get("controls", [])),
        "after_control_count": len(after.get("controls", [])),
    }


def compare_readiness(before: dict[str, Any], after: dict[str, Any], minimum_improvement_ms: float) -> dict[str, Any]:
    before_p75 = before.get("metrics", {}).get("p75", {})
    after_p75 = after.get("metrics", {}).get("p75", {})
    readiness_metrics = ("content_ready_ms", "component_ready_ms", "first_paint_ms", "first_contentful_paint_ms")
    deltas: dict[str, float | None] = {}
    failures: list[str] = []
    improvements: list[float] = []
    for metric in readiness_metrics:
        old, new = before_p75.get(metric), after_p75.get(metric)
        if not isinstance(old, (int, float)) or not isinstance(new, (int, float)):
            failures.append(f"missing metric: {metric}")
            deltas[metric] = None
            continue
        delta = round(float(new) - float(old), 3)
        deltas[metric] = delta
        if delta > 0:
            failures.append(f"{metric} regressed by {delta} ms")
        if delta <= -minimum_improvement_ms:
            improvements.append(-delta)
    if not improvements:
        failures.append(f"no readiness/paint metric improved by at least {minimum_improvement_ms:g} ms")
    return {
        "verdict": "PASS" if not failures else "FAIL",
        "deltas_ms": deltas,
        "improvement_ms": round(max(improvements), 3) if improvements else None,
        "failures": failures,
    }


def visual_diff(before_path: Path, after_path: Path, threshold: float) -> dict[str, Any]:
    # Near You can be a long document. A regular 8-pixel sample keeps comparison
    # bounded while still catching material layout/content changes across the full
    # surface; the original screenshots remain the human-review artifacts.
    sample_stride = 8
    before_size, before_pixels = read_png_rgb(before_path, sample_stride)
    after_size, after_pixels = read_png_rgb(after_path, sample_stride)
    if before_size != after_size:
        return {"verdict": "REVIEW", "reason": f"size changed from {before_size} to {after_size}", "changed_fraction": 1.0, "sample_stride": sample_stride}
    deltas = [max(abs(old[channel] - new[channel]) for channel in range(3)) for old, new in zip(before_pixels, after_pixels)]
    changed = sum(1 for delta in deltas if delta > 12)
    fraction = changed / max(1, len(deltas))
    mean = sum(deltas) / max(1, len(deltas))
    return {
        "verdict": "PASS" if fraction <= threshold else "REVIEW",
        "changed_fraction": round(fraction, 6),
        "mean_absolute_channel_delta": round(mean, 3),
        "threshold": threshold,
        "sample_stride": sample_stride,
        "sampled_pixels": len(deltas),
    }


def read_png_rgb(path: Path, sample_stride: int = 1) -> tuple[tuple[int, int], list[tuple[int, int, int]]]:
    """Read the 8-bit PNGs emitted by Playwright without a third-party image package."""
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"not a PNG screenshot: {path}")
    position = 8
    width = height = bit_depth = color_type = None
    compressed = bytearray()
    while position < len(raw):
        length = struct.unpack(">I", raw[position:position + 4])[0]
        kind = raw[position + 4:position + 8]
        payload = raw[position + 8:position + 8 + length]
        position += 12 + length
        if kind == b"IHDR":
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            if bit_depth != 8 or compression != 0 or filtering != 0 or interlace != 0:
                raise SystemExit(f"unsupported PNG encoding in {path}")
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            break
    if width is None or height is None or bit_depth != 8:
        raise SystemExit(f"PNG is missing an 8-bit header: {path}")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
    if channels is None:
        raise SystemExit(f"unsupported PNG color type {color_type}: {path}")
    row_bytes = width * channels
    decoded = zlib.decompress(bytes(compressed))
    rows: list[bytes] = []
    offset = 0
    previous = bytearray(row_bytes)
    for _ in range(height):
        filter_type = decoded[offset]
        current = bytearray(decoded[offset + 1:offset + 1 + row_bytes])
        offset += row_bytes + 1
        for index in range(row_bytes):
            left = current[index - channels] if index >= channels else 0
            up = previous[index]
            up_left = previous[index - channels] if index >= channels else 0
            if filter_type == 1:
                current[index] = (current[index] + left) & 255
            elif filter_type == 2:
                current[index] = (current[index] + up) & 255
            elif filter_type == 3:
                current[index] = (current[index] + ((left + up) // 2)) & 255
            elif filter_type == 4:
                estimate = left + up - up_left
                distances = (abs(estimate - left), abs(estimate - up), abs(estimate - up_left))
                predictor = (left, up, up_left)[distances.index(min(distances))]
                current[index] = (current[index] + predictor) & 255
            elif filter_type != 0:
                raise SystemExit(f"unsupported PNG filter {filter_type}: {path}")
        rows.append(bytes(current))
        previous = current
    pixels: list[tuple[int, int, int]] = []
    for y, row in enumerate(rows):
        if y % sample_stride:
            continue
        for x, index in enumerate(range(0, row_bytes, channels)):
            if x % sample_stride:
                continue
            if color_type == 6:
                pixels.append(tuple(row[index:index + 3]))
            elif color_type == 2:
                pixels.append(tuple(row[index:index + 3]))
            elif color_type == 4:
                pixels.append((row[index], row[index], row[index]))
            else:
                pixels.append((row[index], row[index], row[index]))
    return (int(width), int(height)), pixels


def write_report(output: Path, report: dict[str, Any]) -> None:
    reports = output / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    for surface, result in report["surfaces"].items():
        (reports / f"{surface}.json").write_text(canonical_json(result) + "\n", encoding="utf-8")
    rows = []
    for surface, result in report["surfaces"].items():
        rows.append(
            f"<tr><th scope='row'>{html.escape(surface)}</th>"
            f"<td class='{result['verdict'].lower()}'>{html.escape(result['verdict'])}</td>"
            f"<td>{html.escape(result['content']['verdict'])}</td>"
            f"<td>{html.escape(result['readiness']['verdict'])}</td>"
            f"<td>{html.escape(result['visual']['mobile']['verdict'])} / {html.escape(result['visual']['desktop']['verdict'])}</td>"
            f"<td><a href='{html.escape(surface)}.json'>JSON</a> · "
            f"<a href='../{html.escape(report['before'])}/{html.escape(surface)}/mobile.png'>before mobile</a> · "
            f"<a href='../{html.escape(report['after'])}/{html.escape(surface)}/mobile.png'>after mobile</a></td></tr>"
        )
    document = f"""<!doctype html>
<meta charset='utf-8'><title>Content parity report</title>
<style>body{{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem}}table{{border-collapse:collapse;width:100%}}th,td{{border:1px solid #ccc;padding:.55rem;text-align:left}}.pass{{color:#075e2f}}.fail{{color:#a00}}.review{{color:#8a4b00}}</style>
<h1>Before/after content-parity report</h1>
<p>Before: <code>{html.escape(report['before'])}</code> · After: <code>{html.escape(report['after'])}</code></p>
<table><thead><tr><th>Surface</th><th>Verdict</th><th>Content</th><th>Readiness</th><th>Visual review</th><th>Artifacts</th></tr></thead><tbody>{''.join(rows)}</tbody></table>
"""
    (reports / "index.html").write_text(document, encoding="utf-8")


def compare(args: argparse.Namespace) -> int:
    output = Path(args.output).resolve()
    before = load_capture(output, args.before)
    after = load_capture(output, args.after)
    allowed = load_allow_file(args.allow_file)
    surfaces = selected_surfaces(args.surfaces)
    report: dict[str, Any] = {"schema": "cityscroll.content_parity_report.v1", "before": args.before, "after": args.after, "surfaces": {}}
    failed = False
    for surface in surfaces:
        result: dict[str, Any] = {"surface": surface, "viewports": {}}
        viewport_failures = []
        for viewport in VIEWPORTS:
            old = before.get("surfaces", {}).get(surface, {}).get(viewport)
            new = after.get("surfaces", {}).get(surface, {}).get(viewport)
            if not old or not new:
                raise SystemExit(f"missing {surface}/{viewport} in one of the captures")
            content_result = compare_content(old["content"], new["content"], surface, allowed)
            readiness_result = compare_readiness(old, new, args.minimum_improvement_ms)
            visual_result = visual_diff(output / old["screenshot"], output / new["screenshot"], args.visual_threshold)
            result["viewports"][viewport] = {"content": content_result, "readiness": readiness_result, "visual": visual_result}
            viewport_failures.extend(content_result["missing"] + readiness_result["failures"])
            if content_result["verdict"] != "PASS" or readiness_result["verdict"] != "PASS":
                failed = True
            if visual_result["verdict"] != "PASS":
                failed = True
        result["content"] = {"verdict": "FAIL" if any(v["content"]["verdict"] != "PASS" for v in result["viewports"].values()) else "PASS"}
        result["readiness"] = {"verdict": "FAIL" if any(v["readiness"]["verdict"] != "PASS" for v in result["viewports"].values()) else "PASS"}
        result["visual"] = {viewport: result["viewports"][viewport]["visual"] for viewport in VIEWPORTS}
        result["verdict"] = "FAIL" if viewport_failures or any(v["visual"]["verdict"] != "PASS" for v in result["viewports"].values()) else "PASS"
        report["surfaces"][surface] = result
    report["verdict"] = "FAIL" if failed else "PASS"
    write_report(output, report)
    print(json.dumps({"verdict": report["verdict"], "report": str(output / "reports" / "index.html"), "surfaces": {k: v["verdict"] for k, v in report["surfaces"].items()}}, indent=2))
    if failed:
        for surface, result in report["surfaces"].items():
            for viewport, view in result["viewports"].items():
                for loss in view["content"]["missing"]:
                    print(f"CONTENT LOSS {surface}/{viewport}: {loss['kind']} {loss['key']} — {loss['detail']}", file=sys.stderr)
                for failure in view["readiness"]["failures"]:
                    print(f"READINESS FAILURE {surface}/{viewport}: {failure}", file=sys.stderr)
                if view["visual"]["verdict"] != "PASS":
                    print(f"VISUAL REVIEW {surface}/{viewport}: {view['visual']}", file=sys.stderr)
        return 1
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    sub = root.add_subparsers(dest="command", required=True)
    capture_parser = sub.add_parser("capture", help="capture one local site artifact")
    capture_parser.add_argument("--ref", required=True)
    capture_parser.add_argument("--base", help="local site base URL; defaults to CROL_BASE")
    capture_parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    capture_parser.add_argument("--surfaces", help="comma-separated surface names")
    capture_parser.add_argument("--runs", type=int, default=3)
    capture_parser.add_argument("--timeout-ms", type=int, default=45_000)
    capture_parser.add_argument("--no-fixtures", action="store_true", help="allow upstreams instead of repository fixtures")
    capture_parser.set_defaults(func=capture)
    compare_parser = sub.add_parser("compare", help="compare two captures and write the batch report")
    compare_parser.add_argument("--before", required=True)
    compare_parser.add_argument("--after", required=True)
    compare_parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    compare_parser.add_argument("--surfaces", help="comma-separated surface names")
    compare_parser.add_argument("--allow-file")
    compare_parser.add_argument("--minimum-improvement-ms", type=float, default=1.0)
    compare_parser.add_argument("--visual-threshold", type=float, default=0.02)
    compare_parser.set_defaults(func=compare)
    return root


if __name__ == "__main__":
    arguments = parser().parse_args()
    raise SystemExit(arguments.func(arguments))
