#!/usr/bin/env python3
"""Compare every shipped public asset between two deployments."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
SITE_ROOT = ROOT / "site"
PUBLIC_SUFFIXES = {
    ".css",
    ".html",
    ".js",
    ".json",
    ".mjs",
    ".png",
    ".svg",
    ".txt",
    ".webm",
    ".webmanifest",
    ".xml",
}
RELEASE_CONFIG_RE = re.compile(
    rb"\s*<script data-release-channel-config>.*?</script>",
    re.IGNORECASE | re.DOTALL,
)
RELEASE_BANNER_RE = re.compile(
    rb"\s*<aside data-release-channel-banner.*?</aside>",
    re.IGNORECASE | re.DOTALL,
)
I18N_STAMP_RE = re.compile(rb"(i18n\.js\?v=)[0-9a-f]{12}")
CLOUDFLARE_BEACON_RE = re.compile(
    rb'\s*<script type="module" src="https://static\.cloudflareinsights\.com/beacon\.min\.js/v[^"]+".*?</script>',
    re.IGNORECASE | re.DOTALL,
)
CLOUDFLARE_EMAIL_LINK_RE = re.compile(
    rb'<a href="/cdn-cgi/l/email-protection(?P<fragment>#[0-9a-f]+)?"[^>]*>.*?</a>',
    re.IGNORECASE | re.DOTALL,
)
CLOUDFLARE_EMAIL_VALUE_RE = re.compile(rb'data-cfemail="([0-9a-f]+)"', re.IGNORECASE)
CLOUDFLARE_EMAIL_SPAN_RE = re.compile(
    rb'<span class="__cf_email__"[^>]*>.*?</span>',
    re.IGNORECASE | re.DOTALL,
)
CLOUDFLARE_EMAIL_SCRIPT_RE = re.compile(
    rb'<script data-cfasync="false" src="/cdn-cgi/scripts/[^"]+/cloudflare-static/email-decode\.min\.js"></script>',
    re.IGNORECASE,
)


def public_paths(site_root: Path) -> list[str]:
    paths = {"/"}
    for path in site_root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in PUBLIC_SUFFIXES:
            continue
        relative = path.relative_to(site_root).as_posix()
        if relative == "index.html":
            paths.add("/")
        else:
            paths.add(f"/{relative}")
    return sorted(paths)


def decode_cfemail(value: bytes) -> bytes:
    encoded = bytes.fromhex(value.decode("ascii"))
    key = encoded[0]
    return bytes(byte ^ key for byte in encoded[1:])


def restore_cloudflare_email(match: re.Match[bytes]) -> bytes:
    source = match.group(0)
    value = CLOUDFLARE_EMAIL_VALUE_RE.search(source)
    if value is None:
        return source
    address = decode_cfemail(value.group(1))
    if match.group("fragment") is None:
        return address
    source = re.sub(
        rb'href="/cdn-cgi/l/email-protection#[0-9a-f]+"',
        b'href="mailto:' + address + b'"',
        source,
        count=1,
        flags=re.IGNORECASE,
    )
    return CLOUDFLARE_EMAIL_SPAN_RE.sub(address, source, count=1)


def normalize(path: str, body: bytes) -> bytes:
    if path == "/" or path.endswith(".html"):
        body = RELEASE_CONFIG_RE.sub(b"", body)
        body = RELEASE_BANNER_RE.sub(b"", body)
        body = I18N_STAMP_RE.sub(rb"\1__I18N_ASSET_VERSION__", body)
        body = CLOUDFLARE_BEACON_RE.sub(b"", body)
        body = CLOUDFLARE_EMAIL_LINK_RE.sub(restore_cloudflare_email, body)
        body = CLOUDFLARE_EMAIL_SCRIPT_RE.sub(b"", body)
    return body


def fetch(base: str, path: str, attempts: int = 3) -> tuple[int, bytes, str]:
    url = urljoin(base.rstrip("/") + "/", path.lstrip("/"))
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            request = Request(
                url,
                headers={
                    "Accept-Encoding": "identity",
                    "User-Agent": "CityScroll URL parity check",
                },
            )
            with urlopen(request, timeout=30) as response:
                return response.status, response.read(), response.geturl()
        except HTTPError as error:
            return error.code, error.read(), error.geturl()
        except URLError as error:
            last_error = error
            if attempt < attempts:
                time.sleep(attempt)
    raise RuntimeError(f"could not fetch {url}: {last_error}")


def sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def compare(expected_base: str, actual_base: str, site_root: Path) -> dict:
    results = []
    failures = []
    for path in public_paths(site_root):
        expected_status, expected_body, expected_url = fetch(expected_base, path)
        actual_status, actual_body, actual_url = fetch(actual_base, path)
        expected_hash = sha256(normalize(path, expected_body))
        actual_hash = sha256(normalize(path, actual_body))
        matches = (
            expected_status == 200
            and actual_status == 200
            and expected_hash == actual_hash
        )
        result = {
            "path": path,
            "expected_status": expected_status,
            "actual_status": actual_status,
            "expected_sha256": expected_hash,
            "actual_sha256": actual_hash,
            "expected_url": expected_url,
            "actual_url": actual_url,
            "matches": matches,
        }
        results.append(result)
        if not matches:
            failures.append(result)
    return {
        "expected_base": expected_base,
        "actual_base": actual_base,
        "paths_checked": len(results),
        "matched": len(results) - len(failures),
        "failed": len(failures),
        "html_comparison": "release metadata and delivery-layer i18n, beacon, and email-protection transforms normalized before hashing",
        "results": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected", required=True)
    parser.add_argument("--actual", required=True)
    parser.add_argument("--site-root", type=Path, default=SITE_ROOT)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    report = compare(args.expected, args.actual, args.site_root.resolve())
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered)
    print(
        f"URL parity: {report['matched']}/{report['paths_checked']} public paths "
        "returned 200 with matching content hashes."
    )
    if report["failed"]:
        for failure in report["results"]:
            if not failure["matches"]:
                print(
                    f"FAIL {failure['path']}: "
                    f"{failure['expected_status']} {failure['expected_sha256']} != "
                    f"{failure['actual_status']} {failure['actual_sha256']}"
                )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
