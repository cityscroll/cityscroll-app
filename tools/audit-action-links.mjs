#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { classifyDestinationUrl } from "../ontology/actionability_sample.mjs";
import { normalizeRuleActionUrl } from "../worker/src/lib/rules.mjs";
import { isOasysGenericHub, isOasysNoeDeepLink } from "./lib/oasys_exam_map.mjs";

const DEFAULT_DELAY_MS = 350;
const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = "CityScrollActionLinkAudit/1.0 (+https://cityscroll.org)";

/**
 * Registry of target systems that publish a known per-item deep URL pattern.
 * When an action handoff still points at a listed generic hub, that is a
 * specificity finding — HTTP 200 on the lobby is not enough.
 */
export const DEEP_LINK_SYSTEMS = Object.freeze([
  {
    id: "oasys",
    name: "OASys (DCAS exams)",
    surface: "staffing",
    deep_pattern: "https://a856-exams.nyc.gov/OASysWeb/noe?examId=:examId",
    sample_deep_url: "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619",
    generic_hub_samples: Object.freeze([
      "https://www.nyc.gov/examsforjobs",
      "https://a856-exams.nyc.gov/OASysWeb/home",
      "https://a856-exams.nyc.gov/OASysWeb/exams",
      "https://a856-exams.nyc.gov/OASysWeb/",
    ]),
    isGenericHub(url) {
      return isOasysGenericHub(url);
    },
    isDeep(url) {
      return isOasysNoeDeepLink(url);
    },
    fix: "Join OASys GetActiveExams on exam_number and deep-link noe?examId=; keep examsforjobs only for unmapped rows with a browse label.",
  },
  {
    id: "passport-rfx",
    name: "PASSPort RFx",
    surface: "contracts",
    deep_pattern: "https://passport.cityofnewyork.us/page.aspx/en/bpm/process_manage_extranet/:rfp_id",
    sample_deep_url: "https://passport.cityofnewyork.us/page.aspx/en/bpm/process_manage_extranet/36426",
    generic_hub_samples: Object.freeze([
      "https://a0333-passportpublic.nyc.gov/rfx.html",
      "https://a0333-passportpublic.nyc.gov/contracts.html",
    ]),
    isGenericHub(url) {
      try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        const path = (u.pathname || "").toLowerCase();
        if (!host.includes("passport")) return false;
        if (/process_manage_extranet\/\d+/i.test(path)) return false;
        return /\/rfx\.html$/i.test(path) || /\/contracts\.html$/i.test(path) || path === "/" || path === "";
      } catch {
        return false;
      }
    },
    isDeep(url) {
      try {
        return /process_manage_extranet\/\d+/i.test(new URL(url).pathname);
      } catch {
        return false;
      }
    },
    fix: "When rfp_id is known, use process_manage_extranet/:rfp_id; public browse remains a search recipe only without rfp_id.",
  },
  {
    id: "nyc-rules",
    name: "NYC Rules",
    surface: "rules",
    deep_pattern: "https://rules.cityofnewyork.us/rule/:slug/",
    sample_deep_url: "https://rules.cityofnewyork.us/rule/amendments-related-to-the-nyc-energy-conservation-code/",
    generic_hub_samples: Object.freeze([
      "https://rules.cityofnewyork.us/",
      "https://rules.cityofnewyork.us",
    ]),
    isGenericHub(url) {
      try {
        const u = new URL(url);
        if (!u.hostname.includes("rules.cityofnewyork.us")) return false;
        const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
        return path === "/";
      } catch {
        return false;
      }
    },
    isDeep(url) {
      try {
        return /\/rule\//i.test(new URL(url).pathname);
      } catch {
        return false;
      }
    },
    fix: "Use the joined rule page URL (or normalized non-feed resident URL), not the NYC Rules root.",
  },
  {
    id: "zap",
    name: "ZAP project portal",
    surface: "land",
    deep_pattern: "https://zap.planning.nyc.gov/projects/:project_id",
    sample_deep_url: "https://zap.planning.nyc.gov/projects/2022M0258",
    generic_hub_samples: Object.freeze([
      "https://zap.planning.nyc.gov/",
      "https://zap.planning.nyc.gov/projects",
    ]),
    isGenericHub(url) {
      try {
        const u = new URL(url);
        if (!u.hostname.includes("zap.planning.nyc.gov")) return false;
        const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
        return path === "/" || path === "/projects";
      } catch {
        return false;
      }
    },
    isDeep(url) {
      try {
        return /\/projects\/[^/]+/i.test(new URL(url).pathname);
      } catch {
        return false;
      }
    },
    fix: "Deep-link /projects/{project_id} when the ZAP id is known.",
  },
]);

/**
 * Assess whether an action URL is a known generic hub while a deep pattern exists.
 * @param {string} url
 * @param {{ system_id?: string, item_mappable?: boolean }} [context]
 * @returns {{ specificity: "deep"|"generic-hub"|"unknown", system_id: string|null, finding: object|null }}
 */
export function assessLinkSpecificity(url, context = {}) {
  const itemMappable = context.item_mappable !== false;
  for (const system of DEEP_LINK_SYSTEMS) {
    if (context.system_id && context.system_id !== system.id) continue;
    if (system.isDeep(url)) {
      return { specificity: "deep", system_id: system.id, finding: null };
    }
    if (system.isGenericHub(url)) {
      // Generic hub is a finding when a per-item deep pattern is known and the
      // caller did not mark this item as unmappable.
      if (!itemMappable) {
        return {
          specificity: "generic-hub",
          system_id: system.id,
          finding: null,
        };
      }
      return {
        specificity: "generic-hub",
        system_id: system.id,
        finding: {
          class: "low-specificity",
          system_id: system.id,
          system_name: system.name,
          url,
          deep_pattern: system.deep_pattern,
          message:
            `Action link points at the ${system.name} hub while a per-item deep URL pattern is known.`,
          fix: system.fix,
        },
      };
    }
  }
  return { specificity: "unknown", system_id: null, finding: null };
}

/**
 * Scan a list of product action URLs for low-specificity handoffs.
 * @param {Array<{ id?: string, url: string, system_id?: string, item_mappable?: boolean }>} samples
 */
export function collectSpecificityFindings(samples = []) {
  const findings = [];
  for (const sample of samples) {
    const assessed = assessLinkSpecificity(sample.url, {
      system_id: sample.system_id,
      item_mappable: sample.item_mappable,
    });
    if (assessed.finding) {
      findings.push({
        ...assessed.finding,
        sample_id: sample.id || null,
        surface: sample.surface || null,
      });
    }
  }
  return findings;
}

export const ACTION_LINK_PATTERNS = Object.freeze([
  {
    id: "rules-comment-page",
    surface: "rules",
    action: "comment",
    url_pattern: "https://rules.cityofnewyork.us/rule/:slug/",
    sample_url: "https://rules.cityofnewyork.us/rule/amendments-related-to-the-nyc-energy-conservation-code/",
    source_artifact_url: "https://rules.cityofnewyork.us/rule/amendments-related-to-the-nyc-energy-conservation-code/feed/",
    derivation: "nyc_rules_rss",
    expected_destination_class: "deep",
    expected_specificity: "deep",
    upstream_fallback: "Keep the City Record notice, published deadline, and comment-contact steps visible.",
  },
  {
    id: "land-zap-project",
    surface: "land",
    action: "comment",
    url_pattern: "https://zap.planning.nyc.gov/projects/:project_id",
    sample_url: "https://zap.planning.nyc.gov/projects/2022M0258",
    expected_destination_class: "deep",
    expected_specificity: "deep",
    upstream_fallback: "Keep the joined City Record hearing and project identifier visible.",
  },
  {
    id: "contracts-passport-process",
    surface: "contracts",
    action: "submit",
    url_pattern: "https://passport.cityofnewyork.us/page.aspx/en/bpm/process_manage_extranet/:rfp_id",
    sample_url: "https://passport.cityofnewyork.us/page.aspx/en/bpm/process_manage_extranet/36426",
    expected_destination_class: "deep",
    expected_specificity: "deep",
    upstream_fallback: "Keep the EPIN search recipe and City Record response instructions visible.",
  },
  {
    id: "contracts-city-record-package",
    surface: "contracts",
    action: "submit",
    url_pattern: "https://a856-cityrecord.nyc.gov/Search/GetFile?RequestID=:request_id&DocumentID=:document_id",
    sample_url: "https://a856-cityrecord.nyc.gov/Search/GetFile?SectionID=6&RequestStatus=Archived&RequestID=20240816113&DocumentID=38698",
    expected_destination_class: "deep",
    expected_specificity: "unknown",
    upstream_fallback: "Keep the notice page, procurement contact, deadline, and submission method visible.",
  },
  {
    id: "contracts-city-record-notice",
    surface: "contracts",
    action: "submit",
    url_pattern: "https://a856-cityrecord.nyc.gov/RequestDetail/:request_id",
    sample_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260718010",
    expected_destination_class: "deep",
    expected_specificity: "unknown",
    upstream_fallback: "Keep extracted response instructions and contact fields visible.",
  },
  {
    id: "contracts-nycha-isupplier-registration",
    surface: "contracts",
    action: "apply",
    url_pattern: "https://www.nyc.gov/site/nycha/business/isupplier-vendor-registration.page",
    sample_url: "https://www.nyc.gov/site/nycha/business/isupplier-vendor-registration.page",
    expected_destination_class: "landing",
    // No public per-RFQ deep URL — landing is honest, not a specificity finding.
    expected_specificity: "unknown",
    item_mappable: false,
    upstream_fallback: "Keep the notice's iSupplier upload instructions and registration lead time visible.",
  },
  {
    id: "meetings-zoom-join",
    surface: "meetings",
    action: "attend",
    url_pattern: "https://*.zoom.us/j/:meeting_id",
    sample_url: "https://zoom.us/j/91467302621",
    expected_destination_class: "deep",
    expected_specificity: "unknown",
    upstream_fallback: "Keep the venue, dial-in details, testimony contact, and City Record notice visible.",
  },
  {
    id: "property-zola-lot",
    surface: "property",
    action: "review parcel",
    url_pattern: "https://zola.planning.nyc.gov/l/lot/:borough/:block/:lot",
    sample_url: "https://zola.planning.nyc.gov/l/lot/1/644/1",
    expected_destination_class: "deep",
    expected_specificity: "unknown",
    upstream_fallback: "Keep the BBL, disposition notice, and any hearing details visible.",
  },
  {
    id: "staffing-oasys-noe",
    surface: "staffing",
    action: "apply",
    url_pattern: "https://a856-exams.nyc.gov/OASysWeb/noe?examId=:examId",
    sample_url: "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619",
    expected_destination_class: "deep",
    expected_specificity: "deep",
    system_id: "oasys",
    upstream_fallback: "Keep the exam number, application window, and DCAS exam notice visible.",
  },
  {
    // Documented fallback for unmapped exams only — must not be the primary handoff
    // when a GetActiveExams examId join exists (specificity detector covers that rot).
    id: "staffing-oasys-apply-landing",
    surface: "staffing",
    action: "apply",
    url_pattern: "https://www.nyc.gov/examsforjobs",
    sample_url: "https://www.nyc.gov/examsforjobs",
    expected_destination_class: "landing",
    expected_specificity: "generic-hub",
    system_id: "oasys",
    // Inventory sample is the hub itself; treat as intentional unmapped fallback.
    item_mappable: false,
    upstream_fallback: "Keep the exam number, application window, and DCAS exam notice visible. Prefer noe?examId= when mapped.",
  },
]);

function successfulStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 400;
}

function isSoftErrorUrl(value) {
  try {
    return /\/Error\/Error404\b/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function deriveUrl(url, derivation) {
  if (derivation === "nyc_rules_rss") return normalizeRuleActionUrl(url);
  return null;
}

export async function probeUrl(url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const attempts = [];

  for (const method of ["HEAD", "GET"]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: method === "HEAD" ? "*/*" : "text/html,application/pdf;q=0.9,*/*;q=0.8",
          "User-Agent": USER_AGENT,
        },
      });
      attempts.push({
        method,
        status: response.status,
        final_url: response.url || url,
        content_type: response.headers.get("content-type") || null,
        soft_error: isSoftErrorUrl(response.url || url),
      });
      if (response.body && method === "GET") await response.body.cancel();
      if (successfulStatus(response.status) && !isSoftErrorUrl(response.url || url)) {
        return { ok: true, status: response.status, attempts };
      }
    } catch (error) {
      attempts.push({
        method,
        status: null,
        error: error?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(error?.message || error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, status: attempts.at(-1)?.status || null, attempts };
}

export async function auditPattern(pattern, options = {}) {
  const activeProbe = await probeUrl(pattern.sample_url, options);
  let verdict = activeProbe.ok ? "OK" : "broken-upstream";
  let derived = null;

  if (!activeProbe.ok && pattern.derivation) {
    const derivedUrl = deriveUrl(pattern.sample_url, pattern.derivation);
    if (derivedUrl && derivedUrl !== pattern.sample_url) {
      const probe = await probeUrl(derivedUrl, options);
      derived = { url: derivedUrl, probe };
      if (probe.ok) verdict = "broken-derivable-fix";
    }
  }

  const specificity = assessLinkSpecificity(pattern.sample_url, {
    system_id: pattern.system_id,
    item_mappable: pattern.item_mappable,
  });
  // Reachable generic hub still fails when the product is expected to deep-link.
  if (
    verdict === "OK"
    && specificity.finding
    && pattern.expected_specificity === "deep"
  ) {
    verdict = "low-specificity";
  }

  const result = {
    id: pattern.id,
    surface: pattern.surface,
    action: pattern.action,
    url_pattern: pattern.url_pattern,
    sample_url: pattern.sample_url,
    destination_class: classifyDestinationUrl(pattern.sample_url),
    expected_destination_class: pattern.expected_destination_class,
    specificity: specificity.specificity,
    expected_specificity: pattern.expected_specificity || null,
    specificity_finding: specificity.finding,
    verdict,
    probe: activeProbe,
    upstream_fallback: pattern.upstream_fallback,
  };
  if (derived) result.derived = derived;

  if (pattern.source_artifact_url) {
    const artifactProbe = await probeUrl(pattern.source_artifact_url, options);
    const normalizedUrl = deriveUrl(pattern.source_artifact_url, pattern.derivation);
    result.derivation_evidence = {
      source_artifact_url: pattern.source_artifact_url,
      source_artifact_probe: artifactProbe,
      normalized_url: normalizedUrl,
      normalized_matches_active_url: normalizedUrl === pattern.sample_url,
      disposition: "fixed-at-ingest",
    };
  }

  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function auditActionLinks(options = {}) {
  const patterns = options.patterns || ACTION_LINK_PATTERNS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const results = [];
  for (let i = 0; i < patterns.length; i += 1) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    results.push(await auditPattern(patterns[i], options));
  }

  const productSamples = options.product_samples || [];
  const specificity_findings = collectSpecificityFindings(productSamples);

  const counts = {
    OK: 0,
    "broken-derivable-fix": 0,
    "broken-upstream": 0,
    "low-specificity": 0,
  };
  for (const result of results) counts[result.verdict] = (counts[result.verdict] || 0) + 1;
  return {
    schema: "cityscroll.action_link_integrity.v2",
    generated_at: new Date().toISOString(),
    probe_policy: {
      sequence: ["HEAD", "GET on non-success"],
      success_status: "HTTP 200-399 after redirects",
      delay_ms: delayMs,
      timeout_ms: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      user_agent: USER_AGENT,
      specificity:
        "Generic hub URLs for systems with a known per-item deep pattern are findings even when HTTP 200.",
    },
    deep_link_systems: DEEP_LINK_SYSTEMS.map((s) => ({
      id: s.id,
      name: s.name,
      surface: s.surface,
      deep_pattern: s.deep_pattern,
      sample_deep_url: s.sample_deep_url,
      generic_hub_samples: s.generic_hub_samples,
    })),
    summary: {
      patterns: results.length,
      verdicts: counts,
      specificity_findings: specificity_findings.length,
    },
    patterns: results,
    specificity_findings,
  };
}

function argumentValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  if (!process.argv.includes("--live")) {
    throw new Error("use --live to probe external action links");
  }
  const delayArg = argumentValue("--delay-ms");
  const report = await auditActionLinks({
    delayMs: delayArg == null ? DEFAULT_DELAY_MS : Number(delayArg),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const output = argumentValue("--output");
  if (output) await writeFile(output, json, "utf8");
  process.stdout.write(json);
  const ok = report.summary.verdicts.OK || 0;
  const lowSpec = report.summary.verdicts["low-specificity"] || 0;
  if (ok !== report.summary.patterns || lowSpec > 0 || (report.summary.specificity_findings || 0) > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
