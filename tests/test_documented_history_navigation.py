"""Browser controls for bounded publisher activation and strict local navigation."""
import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("history_capture", ROOT / "tools/capture_documented_history_journeys.py")
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


def resolve_pointer(document, pointer):
    value = document
    for token in pointer[2:].split("/"):
        value = value[token.replace("~1", "/").replace("~0", "~")]
    return value


class ManifestProvenanceRoundTrip(unittest.TestCase):
    def test_hermetic_and_production_writers_keep_pointer_ownership(self):
        source = json.loads(capture.MANIFEST_PATH.read_text(encoding="utf-8"))
        historical_receipt = source["production_measurement"]["run_receipt"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text(json.dumps(source), encoding="utf-8")
            cases = [item["case"] for item in source["captures"]]
            hermetic = {
                "repository_revision": "a" * 40,
                "measured_inputs": [{"path": "site/i18n.js", "sha256": "b" * 64}],
                "captures": [{"case": case, "render_sha256": "c" * 64,
                              "capture_sha256": None} for case in cases],
            }
            capture.write_hermetic_manifest(hermetic, path)
            after_hermetic = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(after_hermetic["production_measurement"]["run_receipt"], historical_receipt)
            retained = historical_receipt["retained_measurement"]
            self.assertEqual(resolve_pointer(after_hermetic, retained["inputs_ref"]),
                             after_hermetic["measurement_provenance"]["inputs"])
            self.assertEqual(after_hermetic["measurement_provenance"]["revision"], retained["revision"])
            self.assertEqual(after_hermetic["hermetic_measurement_provenance"], {
                "revision": "a" * 40,
                "inputs": hermetic["measured_inputs"],
            })

            production = source["production_measurement"]["run_receipt"]
            production_receipt = {
                "observed_at": production["observed_at"],
                "base_url": production["origin"],
                "repository_revision": production["repository_revision"],
                "required_landed_commit": production["required_landed_commit"],
                "served_revision": production["served_revision"],
                "served_revision_after": production["served_revision_after"],
                "data_vintage": production["data_vintage"],
                "request_receipts": production["request_receipts"],
                "captures": [{**item, "capture_sha256": item["sha256"]
                              if item["hash_kind"] == "screenshot" else None}
                             for item in production["captures"]],
                "failure_control": {**production["failure_control"],
                                    "capture_sha256": production["failure_control"]["sha256"]},
            }
            capture.write_production_manifest(production_receipt, path)
            after_production = json.loads(path.read_text(encoding="utf-8"))
            new_receipt = after_production["production_measurement"]["run_receipt"]
            new_retained = new_receipt["retained_measurement"]
            self.assertEqual(new_retained["revision"], "a" * 40)
            self.assertEqual(resolve_pointer(after_production, new_retained["inputs_ref"]),
                             hermetic["measured_inputs"])
            self.assertEqual(after_production["hermetic_measurement_provenance"]["inputs"],
                             hermetic["measured_inputs"])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.startswith("/slow"):
            time.sleep(45)
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        try:
            self.wfile.write(b"<h1>Loaded destination</h1>")
        except (BrokenPipeError, ConnectionResetError):
            pass


class NavigationControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def prepare(self, browser, *, external=True, hidden=False):
        page = browser.new_page()
        page.set_default_timeout(600)
        page.goto(f"http://127.0.0.1:{self.port}/initial")
        host = "localhost" if external else "127.0.0.1"
        href = f"http://{host}:{self.port}/slow"
        page.set_content(f'<a href="{href}" style="display:{"none" if hidden else "block"}">Continue</a>')
        return page, page.locator("a"), href

    def test_external_requested_but_unresponsive_publisher_is_bounded(self):
        with capture.launched_chromium() as browser:
            page, link, href = self.prepare(browser)
            before = page.url
            # Production URLs must be HTTPS; only this local browser control
            # substitutes that final URL-scheme check without changing requests.
            original = capture.urllib.parse.urlsplit
            def local_https(url, *args, **kwargs):
                parsed = original(url, *args, **kwargs)
                return parsed._replace(scheme="https") if url == href else parsed
            from unittest.mock import patch
            with patch.object(capture.urllib.parse, "urlsplit", side_effect=local_https):
                destination, departed = capture.activate_link(page, link, initial_url=before, fixture=False)
            self.assertEqual(destination, href)
            self.assertFalse(departed)
            self.assertEqual(page.url, before)
            self.assertTrue(page.locator("a").is_visible())

    def test_timeout_without_any_navigation_request_refuses(self):
        with capture.launched_chromium() as browser:
            page, link, _ = self.prepare(browser, hidden=True)
            with self.assertRaises(capture.PlaywrightTimeoutError):
                capture.activate_link(page, link, initial_url=page.url, fixture=False)

    def test_same_origin_publisher_timeout_remains_strict(self):
        with capture.launched_chromium() as browser:
            page, link, _ = self.prepare(browser, external=False)
            with self.assertRaises(capture.PlaywrightTimeoutError):
                capture.activate_link(page, link, initial_url=page.url, fixture=False)


if __name__ == "__main__":
    unittest.main()
