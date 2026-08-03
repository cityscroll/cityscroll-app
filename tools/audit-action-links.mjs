#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { classifyDestinationUrl } from "../ontology/actionability_sample.mjs";
import { normalizeRuleActionUrl } from "../worker/src/lib/rules.mjs";

const DEFAULT_DELAY_MS = 350;
const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = "CityScrollActionLinkAudit/1.0 (+https://cityscroll.org)";

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
    upstream_fallback: "Keep the City Record notice, published deadline, and comment-contact steps visible.",
  },
  {
    id: "land-zap-project",
    surface: "land",
    action: "comment",
    url_pattern: "https://zap.planning.nyc.gov/projects/:project_id",
    sample_url: "https://zap.planning.nyc.gov/projects/2022M0258",
    expected_destination_class: "deep",
    upstream_fallback: "Keep the joined City Record hearing and project identifier visible.",
  },
  {
    id: "contracts-passport-process",
    surface: "contracts",
    action: "submit",
    url_pattern: "https://passport.cityofnewyork.us/page.aspx/en/bpm/process_manage_extranet/:rfp_id",
    sample_url: "https://passport.cityofnewyork.us/page.aspx/en/bpm/process_manage_extranet/36426",
    expected_destination_class: "deep",
    upstream_fallback: "Keep the EPIN search recipe and City Record response instructions visible.",
  },
  {
    id: "contracts-city-record-package",
    surface: "contracts",
    action: "submit",
    url_pattern: "https://a856-cityrecord.nyc.gov/Search/GetFile?RequestID=:request_id&DocumentID=:document_id",
    sample_url: "https://a856-cityrecord.nyc.gov/Search/GetFile?SectionID=6&RequestStatus=Archived&RequestID=20240816113&DocumentID=38698",
    expected_destination_class: "deep",
    upstream_fallback: "Keep the notice page, procurement contact, deadline, and submission method visible.",
  },
  {
    id: "contracts-city-record-notice",
    surface: "contracts",
    action: "submit",
    url_pattern: "https://a856-cityrecord.nyc.gov/RequestDetail/:request_id",
    sample_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260718010",
    expected_destination_class: "deep",
    upstream_fallback: "Keep extracted response instructions and contact fields visible.",
  },
  {
    id: "contracts-nycha-isupplier-registration",
    surface: "contracts",
    action: "apply",
    url_pattern: "https://www.nyc.gov/site/nycha/business/isupplier-vendor-registration.page",
    sample_url: "https://www.nyc.gov/site/nycha/business/isupplier-vendor-registration.page",
    expected_destination_class: "landing",
    upstream_fallback: "Keep the notice's iSupplier upload instructions and registration lead time visible.",
  },
  {
    id: "meetings-zoom-join",
    surface: "meetings",
    action: "attend",
    url_pattern: "https://*.zoom.us/j/:meeting_id",
    sample_url: "https://zoom.us/j/91467302621",
    expected_destination_class: "deep",
    upstream_fallback: "Keep the venue, dial-in details, testimony contact, and City Record notice visible.",
  },
  {
    id: "property-zola-lot",
    surface: "property",
    action: "review parcel",
    url_pattern: "https://zola.planning.nyc.gov/l/lot/:borough/:block/:lot",
    sample_url: "https://zola.planning.nyc.gov/l/lot/1/644/1",
    expected_destination_class: "deep",
    upstream_fallback: "Keep the BBL, disposition notice, and any hearing details visible.",
  },
  {
    id: "staffing-oasys-apply",
    surface: "staffing",
    action: "apply",
    url_pattern: "https://www.nyc.gov/examsforjobs",
    sample_url: "https://www.nyc.gov/examsforjobs",
    expected_destination_class: "landing",
    upstream_fallback: "Keep the exam number, application window, and DCAS exam notice visible.",
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

  const result = {
    id: pattern.id,
    surface: pattern.surface,
    action: pattern.action,
    url_pattern: pattern.url_pattern,
    sample_url: pattern.sample_url,
    destination_class: classifyDestinationUrl(pattern.sample_url),
    expected_destination_class: pattern.expected_destination_class,
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

  const counts = { OK: 0, "broken-derivable-fix": 0, "broken-upstream": 0 };
  for (const result of results) counts[result.verdict] += 1;
  return {
    schema: "cityscroll.action_link_integrity.v1",
    generated_at: new Date().toISOString(),
    probe_policy: {
      sequence: ["HEAD", "GET on non-success"],
      success_status: "HTTP 200-399 after redirects",
      delay_ms: delayMs,
      timeout_ms: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      user_agent: USER_AGENT,
    },
    summary: { patterns: results.length, verdicts: counts },
    patterns: results,
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
  if (report.summary.verdicts.OK !== report.summary.patterns) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
