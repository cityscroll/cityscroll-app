from pathlib import Path

from tools.check_url_parity import decode_cfemail, normalize, public_paths


def test_public_paths_cover_browser_assets_without_repository_markdown(tmp_path: Path):
    (tmp_path / "index.html").write_text("<!doctype html>")
    (tmp_path / "app.js").write_text("void 0")
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "items.json").write_text("[]")
    (tmp_path / "data" / "README.md").write_text("notes")

    assert public_paths(tmp_path) == ["/", "/app.js", "/data/items.json"]


def test_normalize_removes_only_beta_release_markup():
    source = b"""<!doctype html><body>
<script data-release-channel-config>window.CROL_API_ORIGIN = "https://api-beta.cityscroll.org";</script>
<aside data-release-channel-banner role="note"><strong>Experimental beta</strong></aside>
<main><script src="i18n.js?v=0c283adb3f74"></script>Same public page</main>
<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/v123" integrity="sha512-test"></script>
</body>"""

    assert normalize("/", source) == (
        b'<!doctype html><body>\n<main><script src="i18n.js?v=__I18N_ASSET_VERSION__"></script>Same public page</main>\n</body>'
    )
    assert normalize("/app.js", source) == source


def test_normalize_restores_cloudflare_email_protection():
    encoded = b"6b181e0918081902090e2b08190407460702181f4504190c"
    protected = b"""<body>
<a href="/cdn-cgi/l/email-protection#645751465747564d46416447564b4809484d57500a4b5643"><code><span class="__cf_email__" data-cfemail="6b181e0918081902090e2b08190407460702181f4504190c">[email protected]</span></code></a>
<script data-cfasync="false" src="/cdn-cgi/scripts/test/cloudflare-static/email-decode.min.js"></script><script>start()</script>
</body>"""

    assert decode_cfemail(encoded) == b"subscribe@crol-list.org"
    assert normalize("/api.html", protected) == b"""<body>
<a href="mailto:subscribe@crol-list.org"><code>subscribe@crol-list.org</code></a>
<script>start()</script>
</body>"""
