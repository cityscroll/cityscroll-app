/**
 * Offline HTTP fixture map for the fixed connected-history document dossier.
 * Used by the builder observation run and the acceptance suite.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONNECTED_HISTORY_DOCUMENT_SOURCES,
  DOT_PARENT_URL,
} from "../../../tools/lib/connected_history_documents.mjs";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

function bytes(relPath) {
  return readFileSync(join(FIXTURE_DIR, relPath));
}

const DOT_ATTACHMENT = bytes("dot_attachment_body.txt");

const DIRECT = Object.freeze({
  "https://www.nyc.gov/site/oec/environmental-quality-review/13DME013X.page": {
    status: 200,
    bytes: bytes("ceqr_13dme013x.html"),
    contentType: "text/html",
  },
  "https://zap.planning.nyc.gov/projects/2025X0262": {
    status: 200,
    bytes: bytes("zap_2025x0262.html"),
    contentType: "text/html",
  },
  "https://a002-ceqraccess.nyc.gov/ceqr/Details?data=MjVETUUwMDZY0&signature=7baabc56de3147946d9415dc8b59f436a8e7c9ca": {
    status: 200,
    bytes: bytes("ceqr_25dme006x_details.html"),
    contentType: "text/html",
  },
  "https://a002-ceqraccess.nyc.gov/Handlers/ProjectFile.ashx?file=MjAyNVwyNURNRTAwNlhcZmluZGluZ3NcMjVETUUwMDZYX1N0YXRlbWVudF9PZl9GaW5kaW5nc18xMDAxMjAyNS5wZGY1&signature=203eb9aee503f4ce2970ef6e003267bb39fb5d6c": {
    status: 200,
    bytes: bytes("ceqr_25dme006x_findings.txt"),
    contentType: "application/pdf",
  },
  "https://www.nyc.gov/html/dot/downloads/pdf/31-ave-phase-ii-steinway-st-51-st-may2026-2.pdf": {
    status: 200,
    bytes: bytes("dot_31st_ave_phase_ii.txt"),
    contentType: "application/pdf",
  },
  "https://edc.nyc/project/lighthouse-point": {
    status: 200,
    bytes: bytes("edc_lighthouse_point.html"),
    contentType: "text/html",
  },
  "https://edc.nyc/press-release/mixed-use-housing-complex-opens-lighthouse-point": {
    status: 200,
    bytes: bytes("edc_lighthouse_opening.html"),
    contentType: "text/html",
  },
  [DOT_PARENT_URL]: {
    status: 200,
    bytes: bytes("dot_current_projects.html"),
    contentType: "text/html",
  },
});

const RESOLVED_DOT_PATHS = Object.freeze([
  "/html/dot/downloads/pdf/sixth-ave-lispenard-w14-june2024-cb2.pdf",
  "/html/dot/downloads/pdf/sixth-ave-w14-w35-feb2025-cb4-cb5.pdf",
  "/html/dot/downloads/pdf/sixth-ave-watts-w59-june2026-cb2-cb4-cb5.pdf",
  "/html/dot/downloads/pdf/31-ave-sept2023-workshop.pdf",
  "/html/dot/downloads/pdf/31-ave-may-june2024-materials.pdf",
  "/html/dot/downloads/pdf/31-ave-phase-ii-steinway-st-51-st-may2026-2.pdf",
]);

function buildMap(overrides = {}) {
  const map = { ...DIRECT };
  for (const path of RESOLVED_DOT_PATHS) {
    map[`https://www.nyc.gov${path}`] = {
      status: 200,
      bytes: DOT_ATTACHMENT,
      contentType: "application/pdf",
    };
  }
  return { ...map, ...overrides };
}

export function createFixtureHttpGet(overrides = {}) {
  const map = buildMap(overrides);
  const calls = [];
  const httpGet = async (url) => {
    calls.push(url);
    const hit = map[url];
    if (!hit) {
      return { status: 404, bytes: Buffer.from(""), headers: { "content-type": "text/plain" } };
    }
    if (typeof hit === "function") return hit(url);
    return {
      status: hit.status,
      bytes: Buffer.from(hit.bytes),
      headers: {
        get: (key) => (key.toLowerCase() === "content-type" ? hit.contentType : null),
        "content-type": hit.contentType,
      },
    };
  };
  httpGet.calls = calls;
  httpGet.map = map;
  return httpGet;
}

export function fixtureParentHtml() {
  return bytes("dot_current_projects.html").toString("utf8");
}

export function dossierSourceCount() {
  return CONNECTED_HISTORY_DOCUMENT_SOURCES.length;
}
