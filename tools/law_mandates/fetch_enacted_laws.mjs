import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  fetchLegistarMatter,
  fetchLegistarMatterAttachments,
  fetchLegistarMatters,
} from "../../worker/src/lib/legistar_client.mjs";

export const DEFAULT_LAW_CACHE_DIR = "tools/law_mandates/cache";

function textFieldValues(row) {
  return Object.entries(row || {})
    .filter(([key, value]) => /^MatterText\d+$/.test(key) && typeof value === "string" && value.trim())
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, value]) => value.trim());
}

function reportUrl(row) {
  return row?.MatterReports?.find((report) => report?.ReportURL)?.ReportURL || null;
}

export function lawTextFromMatter(row, attachments = []) {
  const inline = textFieldValues(row).join("\n\n");
  if (inline) return { text: inline, source_url: reportUrl(row) || null, source_kind: "matter_text" };
  const attachment = attachments.find((item) => item?.MatterAttachmentHyperlink);
  if (attachment) {
    return {
      text: null,
      source_url: attachment.MatterAttachmentHyperlink,
      source_kind: "matter_attachment",
      text_status: "attachment_requires_text_decoder",
    };
  }
  return { text: null, source_url: reportUrl(row) || null, source_kind: "unavailable", text_status: "unavailable" };
}

function canonicalMatter(row, detail = row) {
  return {
    matter_id: String(detail?.MatterId ?? row?.MatterId ?? ""),
    matter_guid: detail?.MatterGuid ?? row?.MatterGuid ?? null,
    matter_file: detail?.MatterFile ?? row?.MatterFile ?? null,
    title: detail?.MatterName ?? detail?.MatterTitle ?? row?.MatterName ?? row?.MatterTitle ?? null,
    type: detail?.MatterTypeName ?? row?.MatterTypeName ?? null,
    status: detail?.MatterStatusName ?? row?.MatterStatusName ?? null,
    enactment_date: String(detail?.MatterEnactmentDate ?? row?.MatterEnactmentDate ?? "").slice(0, 10) || null,
    enactment_number: detail?.MatterEnactmentNumber ?? row?.MatterEnactmentNumber ?? null,
    intro_date: String(detail?.MatterIntroDate ?? row?.MatterIntroDate ?? "").slice(0, 10) || null,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function decodeHtmlText(value) {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "")
    .replace(/<(?:p|div|br|li|tr|h[1-6])\b[^>]*>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Read an HTML/text Legistar report when MatterText* is not populated. */
export async function fetchTextSource(url, fetchImpl = fetch) {
  if (!url) return null;
  const response = await fetchImpl(url, { headers: { Accept: "text/html,text/plain" } });
  if (!response?.ok) return null;
  const contentType = response.headers?.get?.("content-type") || "";
  if (!/text\/(?:plain|html)/iu.test(contentType) && !/\.(?:html?|txt)(?:$|\?)/iu.test(url)) return null;
  const text = decodeHtmlText(await response.text());
  return text || null;
}

/**
 * Fetch enacted Introductions and cache text plus provenance.
 */
export async function fetchEnactedLaws({
  token,
  fetchImpl = fetch,
  startYear = 2014,
  endYear = new Date().getUTCFullYear(),
  limit = null,
  cacheDir = DEFAULT_LAW_CACHE_DIR,
  fetchedAt = new Date().toISOString(),
  onProgress = null,
} = {}) {
  if (!token) throw new Error("LEGISTAR_API_TOKEN is required");
  const matters = await fetchLegistarMatters({ token, fetchImpl, startYear, endYear, limit });
  const laws = [];
  const skipped = [];
  await mkdir(join(cacheDir, "laws"), { recursive: true });
  await mkdir(join(cacheDir, "text"), { recursive: true });
  for (const [index, row] of matters.entries()) {
    const matterId = String(row?.MatterId ?? "");
    if (!matterId) {
      if (typeof onProgress === "function") await onProgress({ index: index + 1, total: matters.length, matter_id: null, status: "skipped_missing_id" });
      continue;
    }
    const detail = await fetchLegistarMatter({ matterId, token, fetchImpl }) || row;
    const attachments = await fetchLegistarMatterAttachments({ matterId, token, fetchImpl });
    const textInfo = lawTextFromMatter(detail, attachments);
    const metadata = canonicalMatter(row, detail);
    const fetchedReportText = textInfo.text ? null : await fetchTextSource(textInfo.source_url, fetchImpl);
    const text = textInfo.text || fetchedReportText;
    if (!text) {
      skipped.push({ ...metadata, text_status: textInfo.text_status || "unavailable", source_url: textInfo.source_url });
      if (typeof onProgress === "function") await onProgress({ index: index + 1, total: matters.length, matter_id: matterId, status: "skipped_missing_text" });
      continue;
    }
    const textValue = String(text);
    const provenance = {
      source_url: textInfo.source_url || `https://webapi.legistar.com/v1/nyc/Matters/${encodeURIComponent(matterId)}`,
      fetched_at: fetchedAt,
      sha256: sha256(textValue),
      source_kind: textInfo.text ? textInfo.source_kind : "matter_report",
      attachments: attachments.map((item) => ({
        id: item?.MatterAttachmentId ?? null,
        name: item?.MatterAttachmentName ?? null,
        url: item?.MatterAttachmentHyperlink ?? null,
        version: item?.MatterAttachmentMatterVersion ?? null,
      })),
    };
    const law = { ...metadata, text: textValue, provenance };
    await writeFile(join(cacheDir, "text", `${matterId}.txt`), textValue, "utf8");
    await writeFile(join(cacheDir, "laws", `${matterId}.json`), `${JSON.stringify(law, null, 2)}\n`, "utf8");
    laws.push(law);
    if (typeof onProgress === "function") await onProgress({ index: index + 1, total: matters.length, matter_id: matterId, status: "cached" });
  }
  return { laws, skipped, fetched_at: fetchedAt, source: "nyc_legistar_web_api" };
}
