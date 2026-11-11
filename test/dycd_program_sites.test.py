#!/usr/bin/env python3
"""Contract tests for the DYCD program-site reducer and fixture.

Covers the retained FY2026 Queens fixture counts (raw rows, distinct
program-site offerings, mapped records, per-district totals) and the
membership boundaries: publisher-explicit community district only, never
vendor address or inferred geography.
"""
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "warehouse/scripts"))
sys.path.insert(0, str(ROOT / "warehouse/lib"))

from dycd_program_sites import program_map, site_key  # noqa: E402
import socrata_fetch  # noqa: E402

_SPEC = importlib.util.spec_from_file_location(
    "dycd_program_sites_script", ROOT / "warehouse/scripts/dycd_program_sites.py"
)
SCRIPT = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(SCRIPT)

_SPEC_BUILDER = importlib.util.spec_from_file_location(
    "build_agency_program_sites", ROOT / "tools/build_agency_program_sites.py"
)
BUILDER = importlib.util.module_from_spec(_SPEC_BUILDER)
_SPEC_BUILDER.loader.exec_module(BUILDER)

FIXTURE_DIR = ROOT / "warehouse/fixtures/dycd-program-sites"
ROWS = json.loads((FIXTURE_DIR / "dycd-queens-fy2026.raw.json").read_text())
RECEIPT = json.loads((FIXTURE_DIR / "capture-receipt.json").read_text())
COMPLETE = bool(RECEIPT["complete"])


class ProgramSiteFixtureCounts(unittest.TestCase):
    def test_retained_fy2026_queens_counts(self):
        r = program_map(ROWS, complete=COMPLETE)
        self.assertEqual(r["input_rows"], 483)
        self.assertEqual(r["distinct_records"], 482)
        self.assertEqual(r["mapped_records"], 480)
        self.assertEqual(r["duplicate_observations"], 1)
        self.assertEqual(len(r["excluded"]), 2)
        self.assertEqual(r["districts"]["geography:community_district:Q12"], 80)
        self.assertEqual(sum(r["districts"].values()), 480)

    def test_exclusions_stay_explicit(self):
        r = program_map(ROWS, complete=COMPLETE)
        self.assertEqual(
            sorted(x["reason"] for x in r["excluded"]),
            ["joint_interest_area", "missing_or_invalid_district"],
        )

    def test_duplicate_observations_do_not_inflate_totals(self):
        self.assertEqual(
            program_map(ROWS, complete=COMPLETE)["districts"],
            program_map(ROWS + ROWS, complete=COMPLETE)["districts"],
        )

    def test_co_located_distinct_portfolios_remain_distinct(self):
        rows = [
            r
            for r in ROWS
            if r.get("provider") == "Shootin School inc"
            and r.get("program_site_name") == "Jean Nuzzi Intermediate School"
        ]
        self.assertEqual(program_map(rows, complete=True)["mapped_records"], 2)


class MembershipBoundaries(unittest.TestCase):
    def test_incomplete_capture_is_unavailable_not_zero(self):
        r = program_map([], complete=False)
        self.assertEqual(r["status"], "unavailable")
        self.assertIsNone(r["districts"])

    def test_vendor_address_never_becomes_service_geography(self):
        row = dict(ROWS[0], borough="Brooklyn", vendor_address="Queens CD 001")
        self.assertEqual(program_map([row], complete=True)["mapped_records"], 0)

    def test_conflicting_published_districts_are_refused(self):
        conflict = dict(ROWS[0], communitydistrict="Queens CD 002")
        r = program_map([ROWS[0], conflict], complete=True)
        self.assertEqual(r["mapped_records"], 0)
        self.assertEqual(r["excluded"][0]["reason"], "conflicting_published_district")

    def test_membership_fields_are_facility_site_located_in(self):
        r = program_map(ROWS, complete=COMPLETE)
        member = r["members"][0]
        self.assertEqual(member["place_role"], "facility_site")
        self.assertEqual(member["relation"], "located_in")
        self.assertEqual(member["basis"], "publisher_explicit_communitydistrict")


class GoldenIdentities(unittest.TestCase):
    """Python JSON hash encoding is normative for the site identity; these
    goldens pin it against the recorded cross-language fixture parity."""

    def test_first_row_site_key_golden(self):
        self.assertEqual(
            site_key(ROWS[0]),
            "51faacc519c757b1b6842d9df3a56f713598808a950df813d19f722d07e963c7",
        )

    def test_member_identity_goldens(self):
        r = program_map(ROWS, complete=COMPLETE)
        ids = {m["id"] for m in r["members"]}
        self.assertIn(
            "0061aac57f03bbaff072c7566d1b06a8ea8ac2e6ff002b5f22f58998875e4a48", ids
        )
        self.assertIn(
            "ff6b76c8b2e83e3cb8c5d2d4284235148600476eda1b66b197c923886bfce1ac", ids
        )


class _FakeResponse:
    def __init__(self, chunks, status=200, delay_s=0.0):
        self._chunks = list(chunks)
        self.status = status
        self.headers = {"Content-Type": "text/csv"}
        self._delay = delay_s

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, _size):
        if self._delay:
            time.sleep(self._delay)
        return self._chunks.pop(0) if self._chunks else b""


class SharedHelperBounds(unittest.TestCase):
    def _fetch(self, dest, fake, **kwargs):
        factory = fake if callable(fake) else lambda *a, **k: fake
        with mock.patch.object(socrata_fetch.urllib.request, "urlopen", factory):
            return socrata_fetch.fetch_to_file("https://example.invalid/x.csv", dest, **kwargs)

    def test_defaults_preserve_existing_behavior(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "out.csv"
            body = b"a,b\n1,2\n3,4\n"
            receipt = self._fetch(dest, _FakeResponse([body]), backoff_s=0)
            self.assertEqual(receipt["row_count"], 2)
            self.assertEqual(receipt["bytes"], len(body))
            self.assertEqual(
                receipt["sha256"], hashlib.sha256(body).hexdigest()
            )
            self.assertEqual(receipt["http_status"], 200)
            self.assertEqual(dest.read_bytes(), body)

    def test_max_bytes_aborts_oversize_capture(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "out.csv"
            big = b"x" * (4 * 1024 * 1024)
            with self.assertRaises(SystemExit):
                self._fetch(
                    dest,
                    lambda *a, **k: _FakeResponse([big, big, big]),
                    max_attempts=2,
                    backoff_s=0,
                    max_bytes=8 * 1024 * 1024,
                )
            self.assertFalse(dest.exists())

    def test_total_timeout_bounds_all_attempts(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "out.csv"
            started = time.time()
            with self.assertRaises(SystemExit):
                self._fetch(
                    dest,
                    _FakeResponse([b"a\n1\n"] * 100, delay_s=0.02),
                    max_attempts=3,
                    backoff_s=0,
                    total_timeout_s=0.05,
                )
            self.assertLess(time.time() - started, 5)

    def test_optional_json_fetch_skips_csv_row_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "meta.json"
            receipt = self._fetch(
                dest,
                _FakeResponse([b'{"rowsUpdatedAt": 1}']),
                backoff_s=0,
                count_csv_rows=False,
            )
            self.assertIsNone(receipt["row_count"])
            self.assertEqual(json.loads(dest.read_text()), {"rowsUpdatedAt": 1})


class AcquisitionGuards(unittest.TestCase):
    def test_capture_bounds_constants(self):
        self.assertEqual(SCRIPT.CAPTURE_MAX_BYTES, 8 * 1024 * 1024)
        self.assertEqual(SCRIPT.CAPTURE_TOTAL_TIMEOUT_S, 30)
        self.assertEqual(SCRIPT.CAPTURE_ATTEMPTS, 2)
        self.assertEqual(SCRIPT.FISCAL_YEAR_ROW_CAP, 10000)

    def test_count_mismatch_refuses_replacement(self):
        with self.assertRaises(SystemExit):
            SCRIPT.validate_candidate(
                expected_count=483,
                received_count=482,
                accepted_rows_updated_at=1,
                candidate_rows_updated_at=1,
            )

    def test_metadata_change_during_capture_refuses_replacement(self):
        with self.assertRaises(SystemExit):
            SCRIPT.validate_candidate(
                expected_count=483,
                received_count=483,
                accepted_rows_updated_at=1790257979,
                candidate_rows_updated_at=1790258000,
            )

    def test_matching_candidate_is_accepted(self):
        SCRIPT.validate_candidate(
            expected_count=483,
            received_count=483,
            accepted_rows_updated_at=1790257979,
            candidate_rows_updated_at=1790257979,
        )

    def test_row_cap_refuses_oversized_population(self):
        with self.assertRaises(SystemExit):
            SCRIPT.validate_candidate(
                expected_count=10001,
                received_count=10001,
                accepted_rows_updated_at=None,
                candidate_rows_updated_at=None,
            )


class BuiltArtifactContract(unittest.TestCase):
    def test_manifest_and_shard_bounds(self):
        built = BUILDER.build(FIXTURE_DIR)
        manifest = json.loads(built["manifest"])
        self.assertEqual(manifest["schema"], "cityscroll.agency_program_sites.v1")
        self.assertEqual(manifest["agency_id"], "youth-and-community-development")
        self.assertEqual(manifest["source_id"], "dycd-program-sites")
        self.assertEqual(manifest["dataset_id"], "ebkm-iyma")
        self.assertEqual(manifest["fiscal_year"], 2026)
        self.assertTrue(manifest["capture_complete"])
        self.assertEqual(manifest["source_status"], "available")
        self.assertEqual(
            manifest["counts"],
            {
                "raw_rows": 483,
                "distinct_program_sites": 482,
                "mapped_queens": 480,
                "excluded_queens": 2,
                "duplicate_observations": 1,
            },
        )
        self.assertLessEqual(len(built["manifest"]), 65536)
        self.assertEqual(len(manifest["shards"]), 14)
        total_rows = 0
        for name, payload in built["shards"].items():
            self.assertLessEqual(len(payload), 524288)
            shard = json.loads(payload)
            self.assertLessEqual(len(shard["rows"]), 500)
            self.assertTrue(name.startswith(f"dycd-fy2026-{shard['district']}-p"))
            for row in shard["rows"]:
                self.assertEqual(row["agency_id"], "youth-and-community-development")
                self.assertEqual(row["fiscal_year"], 2026)
                self.assertEqual(row["place_role"], "facility_site")
                self.assertRegex(row["id"], r"^source:dycd-program-sites:[0-9a-f]{64}$")
            total_rows += len(shard["rows"])
        self.assertEqual(total_rows, 480)
        for descriptor in manifest["shards"]:
            payload = built["shards"][f"{descriptor['id']}.json"]
            self.assertEqual(descriptor["sha256"], hashlib.sha256(payload).hexdigest())
            self.assertEqual(descriptor["bytes"], len(payload))

    def test_incomplete_receipt_never_replaces_accepted_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Path(tmp)
            for name in (
                "dycd-queens-fy2026.raw.json",
                "capture-receipt.json",
                "ebkm-iyma-metadata.json",
            ):
                (fixture / name).write_bytes((FIXTURE_DIR / name).read_bytes())
            receipt = json.loads((fixture / "capture-receipt.json").read_text())
            receipt["complete"] = False
            (fixture / "capture-receipt.json").write_text(json.dumps(receipt))
            with self.assertRaises(SystemExit):
                BUILDER.build(fixture)
            receipt["complete"] = True
            receipt["rows"] = 482
            (fixture / "capture-receipt.json").write_text(json.dumps(receipt))
            with self.assertRaises(SystemExit):
                BUILDER.build(fixture)


if __name__ == "__main__":
    unittest.main()
