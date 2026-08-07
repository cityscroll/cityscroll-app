import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

function attachmentKind(attachment = {}) {
  const type = String(attachment.content_type || "").toLowerCase();
  const url = String(attachment.url || attachment.MatterAttachmentHyperlink || "").toLowerCase();
  if (type.includes("wordprocessingml") || /\.docx(?:$|\?)/u.test(url)) return "docx";
  if (type.includes("pdf") || /\.pdf(?:$|\?)/u.test(url)) return "pdf";
  return null;
}

export function primaryLawAttachment(attachments = []) {
  return attachments.find((attachment) => {
    const name = String(attachment.name || attachment.MatterAttachmentName || "").trim();
    return /^int\.?\s*no\.?/iu.test(name) && attachmentKind({
      content_type: attachment.content_type,
      url: attachment.url || attachment.MatterAttachmentHyperlink,
    });
  }) || null;
}

function decodeAttachmentBytes(data, kind) {
  const extractor = resolve(dirname(new URL(import.meta.url).pathname), "../../warehouse/lib/attachment_text_extract.py");
  const result = spawnSync("python3", [extractor, "--kind", kind], {
    input: data,
    encoding: "buffer",
    maxBuffer: 5_200_000,
  });
  if (result.status !== 0) return null;
  try {
    const payload = JSON.parse(result.stdout.toString("utf8"));
    return payload.status === "ok" && payload.text ? String(payload.text) : null;
  } catch {
    return null;
  }
}

export async function fetchAttachmentText(attachment, fetchImpl = fetch) {
  const url = attachment?.url || attachment?.MatterAttachmentHyperlink;
  const kind = attachmentKind(attachment);
  if (!url || !kind) return null;
  const response = await fetchImpl(url, { headers: { Accept: "*/*" } });
  if (!response?.ok) return null;
  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  if (contentLength > 5_000_000) return null;
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 5_000_000) return null;
  return decodeAttachmentBytes(data, kind);
}

export async function repairCachedLawTexts({ cacheDir = DEFAULT_LAW_CACHE_DIR, onProgress = null, fetchImpl = fetch } = {}) {
  const lawsDir = join(cacheDir, "laws");
  const files = (await readdir(lawsDir)).filter((name) => name.endsWith(".json")).sort();
  let repaired = 0;
  let skipped = 0;
  const failed = [];
  for (const [index, file] of files.entries()) {
    const path = join(lawsDir, file);
    const law = JSON.parse(await readFile(path, "utf8"));
    if (String(law.text || "").trim().length >= 200) {
      skipped += 1;
      if (typeof onProgress === "function") await onProgress({ index: index + 1, total: files.length, matter_id: law.matter_id, status: "already_substantive" });
      continue;
    }
    const attachment = primaryLawAttachment(law.provenance?.attachments || []);
    let text = null;
    let error = null;
    for (let attempt = 1; attempt <= 3 && !text; attempt += 1) {
      try { text = await fetchAttachmentText(attachment, fetchImpl); }
      catch (caught) { error = caught; }
    }
    if (!text) {
      failed.push({ matter_id: law.matter_id, reason: error?.message || (attachment ? "attachment_text_unavailable" : "primary_law_attachment_missing") });
    } else {
      const updated = {
        ...law,
        text,
        provenance: {
          ...law.provenance,
          source_url: attachment.url || attachment.MatterAttachmentHyperlink,
          source_kind: "matter_attachment_text",
          sha256: sha256(text),
          repaired_at: new Date().toISOString(),
        },
      };
      const temp = `${path}.tmp-${process.pid}`;
      await writeFile(temp, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
      await rename(temp, path);
      repaired += 1;
    }
    if (typeof onProgress === "function") await onProgress({ index: index + 1, total: files.length, matter_id: law.matter_id, status: text ? "repaired" : "repair_failed" });
  }
  return { law_count: files.length, repaired, skipped, failed, failed_count: failed.length, source_kind: "matter_attachment_text" };
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
    const lawAttachment = primaryLawAttachment(attachments);
    const attachmentText = lawAttachment && String(textInfo.text || "").length < 200 ? await fetchAttachmentText(lawAttachment, fetchImpl) : null;
    const fetchedReportText = String(textInfo.text || "").length >= 200 ? null : await fetchTextSource(textInfo.source_url, fetchImpl);
    const text = attachmentText || fetchedReportText || textInfo.text;
    if (!text) {
      skipped.push({ ...metadata, text_status: textInfo.text_status || "unavailable", source_url: textInfo.source_url });
      if (typeof onProgress === "function") await onProgress({ index: index + 1, total: matters.length, matter_id: matterId, status: "skipped_missing_text" });
      continue;
    }
    const textValue = String(text);
    const provenance = {
      source_url: attachmentText ? (lawAttachment.url || lawAttachment.MatterAttachmentHyperlink) : (textInfo.source_url || `https://webapi.legistar.com/v1/nyc/Matters/${encodeURIComponent(matterId)}`),
      fetched_at: fetchedAt,
      sha256: sha256(textValue),
      source_kind: attachmentText ? "matter_attachment_text" : (textInfo.text ? textInfo.source_kind : "matter_report"),
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
