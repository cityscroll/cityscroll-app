from pathlib import Path

from tools.check_url_parity import normalize, public_paths


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
