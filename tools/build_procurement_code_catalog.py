#!/usr/bin/env python3
"""Build public industry-code catalog artifacts from retained official workbooks."""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

RETAINED_DIGESTS = {
    "naics-2022": "217c9e0d4d74e7517bc288f5f308b73aa0de5ee787976a6dd222412be28ada22",
    "nyc-commodity-directory": "6325fbf06b2620ea7992c6f16da4f1f209cd1339d736f86a23b17fdec579a6b7",
}

NAICS_URL = "https://www.census.gov/naics/2022NAICS/2022_NAICS_Structure.xlsx"
NYC_URL = (
    "https://www.nyc.gov/assets/mocs/downloads/PASSPort/learning-to-use-passport/"
    "NYCCommodityClassificationDirectory.xlsx"
)
NYC_ACQUIRED_URL = (
    "https://home4.nyc.gov/assets/mocs/downloads/PASSPort/learning-to-use-passport/"
    "NYCCommodityClassificationDirectory.xlsx"
)

DEFAULT_INPUTS = {
    "naics-2022": ROOT / ".artifacts/first-class-inputs/procurement-codes/naics-2022.xlsx",
    "nyc-commodity-directory": ROOT
    / ".artifacts/first-class-inputs/procurement-codes/nyc-commodity-directory.xlsx",
}
DEFAULT_RECEIPTS = {
    "naics-2022": ROOT / ".artifacts/first-class-inputs/procurement-codes/naics-2022.receipt.json",
    "nyc-commodity-directory": ROOT
    / ".artifacts/first-class-inputs/procurement-codes/nyc-commodity-directory.receipt.json",
}
DEFAULT_OUTPUTS = {
    "naics-2022": ROOT / "site/data/procurement_codes/naics-2022.json",
    "nyc-commodity-directory": ROOT / "site/data/procurement_codes/nyc-commodity-status.json",
}
PRIVATE_NYC_FULL = (
    ROOT / ".artifacts/first-class-inputs/procurement-codes/nyc-commodity-directory.full.json"
)

MAX_UNPACKED_BYTES = 50_000_000
FORBIDDEN_PUBLIC_NYC_KEYS = {
    "label",
    "description",
    "parent",
    "parents",
    "industry",
    "commodity_type",
    "source_row",
    "rawbytes",
    "raw_bytes",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def read_xlsx(path: Path, sheet: int):
    with zipfile.ZipFile(path) as archive:
        unpacked = sum(info.file_size for info in archive.infolist())
        if unpacked > MAX_UNPACKED_BYTES:
            raise ValueError("expanded workbook bound")
        shared = []
        for item in ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("m:si", NS):
            runs = item.findall("m:r", NS)
            if runs:
                text = "".join(
                    (run.findtext("m:t", "", NS) or "")
                    for run in runs
                    if run.find("m:rPr/m:vertAlign", NS) is None
                )
            else:
                text = item.findtext("m:t", "", NS)
            shared.append(text)
        rows = []
        sheet_xml = archive.read(f"xl/worksheets/sheet{sheet}.xml")
        for row_el in ET.fromstring(sheet_xml).findall("m:sheetData/m:row", NS):
            row = {"source_row": int(row_el.attrib["r"])}
            for cell in row_el.findall("m:c", NS):
                value = cell.findtext("m:v", "", NS)
                col = re.sub(r"\d", "", cell.attrib["r"])
                if cell.attrib.get("t") == "s" and value:
                    row[col] = shared[int(value)]
                else:
                    row[col] = value
            rows.append(row)
        return rows


def load_receipt(path: Path | None, source_id: str, digest: str, observed_at: str):
    if path and path.exists():
        receipt = json.loads(path.read_text())
        return receipt
    return {
        "schema": "cityscroll.code_catalog_source_receipt.v1",
        "source_id": source_id,
        "observed_at": observed_at,
        "acquired_at": observed_at,
        "checked_at": observed_at,
        "source_revision": digest,
        "status": "ok",
        "fetch_status": "snapshot",
    }


def build_naics(input_path: Path, receipt_path: Path | None, output_path: Path):
    digest = sha256_file(input_path)
    if digest != RETAINED_DIGESTS["naics-2022"]:
        raise SystemExit(
            f"naics-2022 digest {digest} does not match retained {RETAINED_DIGESTS['naics-2022']}"
        )
    rows = read_xlsx(input_path, 1)
    catalog = []
    for row in rows:
        code = (row.get("B") or "").strip()
        if not re.fullmatch(r"\d{2,6}|31-33|44-45|48-49", code):
            continue
        level = 2 if "-" in code else len(code)
        catalog.append(
            {
                "scheme": "NAICS",
                "version": "2022",
                "code": code,
                "label": (row.get("C") or "").strip(),
                "level": level,
                "status": "listed",
                "parents": [],
                "edition": "2022",
            }
        )
    by_code = {row["code"]: row for row in catalog}
    for row in catalog:
        code = row["code"]
        parent = code[:-1]
        if row["level"] == 3:
            parent = {
                "31": "31-33",
                "32": "31-33",
                "33": "31-33",
                "44": "44-45",
                "45": "44-45",
                "48": "48-49",
                "49": "48-49",
            }.get(code[:2], code[:2])
        if row["level"] > 2:
            if parent not in by_code:
                raise SystemExit(f"missing NAICS parent for {code}: {parent}")
            row["parents"] = [parent]
    counts = collections.Counter(row["level"] for row in catalog)
    if counts != {2: 20, 3: 96, 4: 308, 5: 689, 6: 1012}:
        raise SystemExit(f"unexpected NAICS level counts: {dict(counts)}")
    if len(catalog) != 2125:
        raise SystemExit(f"expected 2125 NAICS nodes, got {len(catalog)}")
    receipt = load_receipt(
        receipt_path,
        "procurement-codes-naics-2022",
        digest,
        "2026-11-11T04:00:00.000Z",
    )
    checked_at = receipt.get("checked_at") or receipt.get("observed_at")
    artifact = {
        "schema": "cityscroll.naics_catalog.v1",
        "version": "2022",
        "edition": "2022",
        "source_url": NAICS_URL,
        "source_sha256": digest,
        "checked_at": checked_at,
        "source_receipt": {
            "observed_at": receipt.get("observed_at"),
            "acquired_at": receipt.get("acquired_at") or receipt.get("observed_at"),
            "checked_at": checked_at,
            "source_revision": digest,
        },
        "records": [
            {
                "scheme": row["scheme"],
                "version": row["version"],
                "code": row["code"],
                "label": row["label"],
                "level": row["level"],
                "status": row["status"],
                "parents": row["parents"],
                "edition": row["edition"],
            }
            for row in catalog
        ],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(artifact, separators=(",", ":")) + "\n")
    return artifact


def build_nyc(input_path: Path, receipt_path: Path | None, output_path: Path):
    digest = sha256_file(input_path)
    if digest != RETAINED_DIGESTS["nyc-commodity-directory"]:
        raise SystemExit(
            "nyc-commodity-directory digest "
            f"{digest} does not match retained {RETAINED_DIGESTS['nyc-commodity-directory']}"
        )
    version = f"snapshot-2026-11-11-{digest[:12]}"
    rows = read_xlsx(input_path, 5)
    if (rows[0].get("E") or "").strip() != "L5 Category (NIGP Code and Description)":
        raise SystemExit("unexpected NYC commodity workbook header")
    levels = {}
    anomalies = []
    leaf = []
    for row in rows[1:]:
        values = {}
        for col, level in [("A", 1), ("C", 2), ("D", 3), ("E", 5)]:
            code, sep, label = (row.get(col) or "").strip().partition(" - ")
            if not sep:
                raise SystemExit(f"NYC row {row['source_row']} column {col} missing separator")
            values[level] = code
            key = (level, code)
            entry = levels.setdefault(
                key,
                {
                    "scheme": "NYC_COMMODITY",
                    "version": version,
                    "code": code,
                    "label": label.strip(),
                    "level": level,
                    "status": "listed",
                    "parents": [],
                    "source_row": row["source_row"],
                    "replacement_codes": [],
                },
            )
            if entry["label"] != label.strip():
                raise SystemExit(f"conflicting NYC label for {key}")
            if level > 1:
                parent = values[{2: 1, 3: 2, 5: 3}[level]]
                if parent not in entry["parents"]:
                    entry["parents"].append(parent)
            if level == 5:
                entry["commodity_type"] = row.get("F")
                entry["industry"] = row.get("G")
                if not re.fullmatch(r"\d{5}", code):
                    entry["status"] = "unclassified"
                    anomalies.append(
                        {
                            "source_row": row["source_row"],
                            "code": code,
                            "label": label,
                            "reason": "publisher internal/nonstandard code",
                        }
                    )
                elif re.search(r"INACTIVE|OBSOLETE|REPLACED BY", label, re.I):
                    entry["status"] = "inactive"
                    entry["replacement_codes"] = re.findall(
                        r"REPLACED BY\s+(\d{5})", label, re.I
                    )
                leaf.append(code)
    if len(leaf) != len(set(leaf)) or len(leaf) != 9041:
        raise SystemExit(f"expected 9041 unique NYC leaf codes, got {len(leaf)}")
    status_counts = collections.Counter(
        entry["status"] for entry in levels.values() if entry["level"] == 5
    )
    if status_counts != {"listed": 8888, "inactive": 150, "unclassified": 3}:
        raise SystemExit(f"unexpected NYC status counts: {dict(status_counts)}")
    if len(anomalies) != 3:
        raise SystemExit(f"expected 3 internal NYC anomalies, got {len(anomalies)}")

    receipt = load_receipt(
        receipt_path,
        "procurement-codes-nyc-commodity-directory",
        digest,
        "2026-11-11T04:00:00.000Z",
    )
    checked_at = receipt.get("checked_at") or receipt.get("observed_at")
    full_records = list(levels.values())
    PRIVATE_NYC_FULL.parent.mkdir(parents=True, exist_ok=True)
    PRIVATE_NYC_FULL.write_text(
        json.dumps(
            {
                "schema": "cityscroll.nyc_commodity_directory.private.v1",
                "version": version,
                "source_url": NYC_URL,
                "acquired_url": NYC_ACQUIRED_URL,
                "source_sha256": digest,
                "checked_at": checked_at,
                "data_rows": 9041,
                "anomalies": anomalies,
                "records": full_records,
            },
            separators=(",", ":"),
        )
        + "\n"
    )

    public_records = [
        {"code": entry["code"], "status": entry["status"]}
        for entry in full_records
        if entry["level"] == 5 and re.fullmatch(r"\d{5}", entry["code"])
    ]
    if len(public_records) != 9038:
        raise SystemExit(f"expected 9038 public NYC numeric rows, got {len(public_records)}")
    artifact = {
        "schema": "cityscroll.nyc_commodity_status.v1",
        "version": version,
        "source_url": NYC_URL,
        "source_sha256": digest,
        "checked_at": checked_at,
        "source_rows": 9041,
        "omitted_internal_rows": 3,
        "source_receipt": {
            "observed_at": receipt.get("observed_at"),
            "acquired_at": receipt.get("acquired_at") or receipt.get("observed_at"),
            "checked_at": checked_at,
            "source_revision": digest,
        },
        "records": public_records,
    }
    payload = json.dumps(artifact, separators=(",", ":"))
    for key in FORBIDDEN_PUBLIC_NYC_KEYS:
        if f'"{key}":' in payload:
            raise SystemExit(f"public NYC artifact leaked forbidden key {key}")
    if len(payload.encode("utf-8")) >= 512 * 1024:
        raise SystemExit("public NYC artifact exceeds 512KiB bound")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(payload + "\n")
    return artifact


def verify_retained() -> int:
    built = {}
    for source in ("naics-2022", "nyc-commodity-directory"):
        input_path = DEFAULT_INPUTS[source]
        if not input_path.exists():
            raise SystemExit(f"retained input missing: {input_path}")
        digest = sha256_file(input_path)
        if digest != RETAINED_DIGESTS[source]:
            raise SystemExit(f"retained digest mismatch for {source}: {digest}")
        receipt_path = DEFAULT_RECEIPTS[source]
        output_path = DEFAULT_OUTPUTS[source]
        if source == "naics-2022":
            built[source] = build_naics(input_path, receipt_path, output_path)
        else:
            built[source] = build_nyc(input_path, receipt_path, output_path)

    naics = built["naics-2022"]
    nyc = built["nyc-commodity-directory"]
    assert len(naics["records"]) == 2125
    assert sum(1 for row in naics["records"] if row["level"] == 6) == 1012
    assert len(nyc["records"]) == 9038
    assert sum(1 for row in nyc["records"] if row["status"] == "listed") == 8888
    assert sum(1 for row in nyc["records"] if row["status"] == "inactive") == 150
    assert nyc["source_rows"] == 9041
    assert nyc["omitted_internal_rows"] == 3
    assert naics["source_sha256"] == RETAINED_DIGESTS["naics-2022"]
    assert nyc["source_sha256"] == RETAINED_DIGESTS["nyc-commodity-directory"]
    print(
        json.dumps(
            {
                "status": "ok",
                "naics_nodes": 2125,
                "naics_industries": 1012,
                "nyc_numeric_rows": 9038,
                "nyc_listed": 8888,
                "nyc_inactive": 150,
                "nyc_omitted_internal": 3,
                "outputs": {
                    "naics": str(DEFAULT_OUTPUTS["naics-2022"].relative_to(ROOT)),
                    "nyc": str(DEFAULT_OUTPUTS["nyc-commodity-directory"].relative_to(ROOT)),
                    "private_nyc_full": str(PRIVATE_NYC_FULL.relative_to(ROOT)),
                },
            },
            indent=2,
        )
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-retained", action="store_true")
    parser.add_argument("--source", choices=sorted(DEFAULT_INPUTS))
    parser.add_argument("--input", type=Path)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)

    if args.verify_retained:
        return verify_retained()
    if not args.source:
        parser.error("--source is required unless --verify-retained is set")
    input_path = args.input or DEFAULT_INPUTS[args.source]
    receipt_path = args.receipt or DEFAULT_RECEIPTS[args.source]
    output_path = args.output or DEFAULT_OUTPUTS[args.source]
    if args.source == "naics-2022":
        artifact = build_naics(input_path, receipt_path, output_path)
    else:
        artifact = build_nyc(input_path, receipt_path, output_path)
    print(
        json.dumps(
            {
                "source": args.source,
                "records": len(artifact["records"]),
                "output": str(output_path),
                "source_sha256": artifact["source_sha256"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
