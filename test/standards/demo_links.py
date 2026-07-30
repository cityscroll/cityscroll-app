#!/usr/bin/env python3
"""Fail fast when the public demo-link manifest does not match its documented schema."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SITE_ROOT = ROOT / "site"
MANIFEST_PATH = SITE_ROOT / "demo" / "demo-links.json"
SCHEMA_PATH = SITE_ROOT / "demo" / "demo-links.schema.json"
ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def validate_locator(locator: object, path: str) -> None:
    require(isinstance(locator, dict), f"{path} must be an object")
    require(set(locator) <= {"selector", "text"}, f"{path} has unknown fields")
    require(isinstance(locator.get("selector"), str) and locator["selector"], f"{path}.selector is required")
    if "text" in locator:
        require(isinstance(locator["text"], str) and locator["text"], f"{path}.text must be non-empty")


def validate_state(state: object, path: str) -> None:
    require(isinstance(state, dict), f"{path} must be an object")
    require(set(state) <= {"selector", "property", "attribute", "equals"}, f"{path} has unknown fields")
    require(isinstance(state.get("selector"), str) and state["selector"], f"{path}.selector is required")
    require(("property" in state) != ("attribute" in state), f"{path} needs exactly one property or attribute")
    if "property" in state:
        require(state["property"] in {"value", "open", "checked"}, f"{path}.property is not supported")
    if "attribute" in state:
        require(isinstance(state["attribute"], str) and state["attribute"], f"{path}.attribute is required")
    require(isinstance(state.get("equals"), (str, bool)), f"{path}.equals must be a string or boolean")


def validate_entry(entry: object, index: int) -> None:
    path = f"entries[{index}]"
    require(isinstance(entry, dict), f"{path} must be an object")
    allowed_fields = {"id", "url", "feature", "description", "expectations", "localOnly"}
    require(set(entry) <= allowed_fields, f"{path} has unknown fields")
    require(
        {"id", "url", "feature", "description", "expectations"} <= set(entry),
        f"{path} is missing required fields",
    )
    if "localOnly" in entry:
        require(isinstance(entry["localOnly"], bool), f"{path}.localOnly must be a boolean")
    require(isinstance(entry["id"], str) and ID_PATTERN.fullmatch(entry["id"]), f"{path}.id is invalid")
    require(
        isinstance(entry["feature"], str) and ID_PATTERN.fullmatch(entry["feature"]),
        f"{path}.feature is invalid",
    )
    require(
        isinstance(entry["url"], str) and entry["url"].startswith("#") and not any(c.isspace() for c in entry["url"]),
        f"{path}.url must be a local hash route",
    )
    description = entry["description"]
    require(isinstance(description, str) and 12 <= len(description) <= 160, f"{path}.description length is invalid")
    require(not any(c in description for c in "\r\n<>"), f"{path}.description must be one line of plain text")

    expectations = entry["expectations"]
    require(isinstance(expectations, dict), f"{path}.expectations must be an object")
    allowed = frozenset(("hash", "visible", "notVisible", "focus", "states", "banner"))
    require(set(expectations) <= allowed, f"{path}.expectations has unknown fields")
    for name in ("visible", "notVisible"):
        locators = expectations.get(name)
        require(isinstance(locators, list) and locators, f"{path}.expectations.{name} must not be empty")
        for locator_index, locator in enumerate(locators):
            validate_locator(locator, f"{path}.expectations.{name}[{locator_index}]")
    if "hash" in expectations:
        require(
            isinstance(expectations["hash"], str) and expectations["hash"].startswith("#"),
            f"{path}.expectations.hash must be a hash route",
        )
    if "focus" in expectations:
        require(isinstance(expectations["focus"], str) and expectations["focus"], f"{path}.expectations.focus is invalid")
    for state_index, state in enumerate(expectations.get("states", [])):
        validate_state(state, f"{path}.expectations.states[{state_index}]")
    if "banner" in expectations:
        banner = expectations["banner"]
        require(isinstance(banner, dict), f"{path}.expectations.banner must be an object")
        require(set(banner) <= {"selector", "visible", "text"}, f"{path}.expectations.banner has unknown fields")
        require(isinstance(banner.get("selector"), str) and banner["selector"], f"{path}.expectations.banner.selector is required")
        require(isinstance(banner.get("visible"), bool), f"{path}.expectations.banner.visible must be boolean")
        if "text" in banner:
            require(banner["visible"], f"{path}.expectations.banner.text requires a visible banner")
            require(isinstance(banner["text"], str) and banner["text"], f"{path}.expectations.banner.text is invalid")


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text())
    schema = json.loads(SCHEMA_PATH.read_text())
    require(schema.get("$schema") == "https://json-schema.org/draft/2020-12/schema", "schema draft is not declared")
    require(set(manifest) == {"$schema", "schemaVersion", "entries"}, "manifest root fields differ from the schema")
    require(manifest["$schema"] == "./demo-links.schema.json", "manifest must link its sibling schema")
    require(manifest["schemaVersion"] == 1, "unsupported manifest schemaVersion")
    entries = manifest["entries"]
    require(isinstance(entries, list) and len(entries) >= 12, "manifest needs at least 12 demo entries")
    for index, entry in enumerate(entries):
        validate_entry(entry, index)
    ids = [entry["id"] for entry in entries]
    require(len(ids) == len(set(ids)), "entry ids must be unique")
    print(f"demo-links: {len(entries)} public routes match schema version 1")


if __name__ == "__main__":
    main()
