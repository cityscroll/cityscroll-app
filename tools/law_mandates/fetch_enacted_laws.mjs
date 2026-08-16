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
  attachment ||= {};
  const type = String(attachment.content_type || "").toLowerCase();
  const url = [attachment.url, attachment.MatterAttachmentHyperlink, attachment.name, attachment.MatterAttachmentName]
    .filter(Boolean).join(" ").toLowerCase();
  if (type.includes("wordprocessingml") || /\.docx(?:$|\?)/u.test(url)) return "docx";
  if (type.includes("msword") || /\.doc(?:$|\?)/u.test(url)) return "doc";
  if (type.includes("pdf") || /\.pdf(?:$|\?)/u.test(url)) return "pdf";
  return null;
}

function lawAttachmentCandidates(attachments = []) {
  const usable = attachments.filter((attachment) => {
    const name = String(attachment.name || attachment.MatterAttachmentName || "").trim();
    return attachmentKind({
      content_type: attachment.content_type,
      url: attachment.url || attachment.MatterAttachmentHyperlink,
    }) && /^(?:int\.?\s*no\.?|local law\s+\d+\b|law\b)/iu.test(name);
  });
  return [...usable].sort((left, right) => {
    const leftName = String(left.name || left.MatterAttachmentName || "");
    const rightName = String(right.name || right.MatterAttachmentName || "");
    const rank = (name) => /^int\.?\s*no\.?/iu.test(name) ? 0 : /^local law\s+\d+\b/iu.test(name) ? 1 : 2;
    const formatRank = (attachment) => /\.docx(?:$|\?)/iu.test(String(attachment.url || attachment.MatterAttachmentHyperlink || "")) ? 0 : /\.doc(?:$|\?)/iu.test(String(attachment.url || attachment.MatterAttachmentHyperlink || "")) ? 1 : 2;
    return rank(leftName) - rank(rightName) || formatRank(left) - formatRank(right);
  });
}

export function primaryLawAttachment(attachments = []) {
  return lawAttachmentCandidates(attachments)[0] || null;
}

function decodeAttachmentBytes(data, kind) {
  const decodeWithTextutil = () => {
    const result = spawnSync("textutil", ["-convert", "txt", "-stdout", "-stdin"], {
      input: data,
      encoding: "buffer",
      maxBuffer: 20_000_000,
    });
    if (result.status === 0 && result.stdout.length) return result.stdout.toString("utf8").trim().slice(0, 120_000) || null;
    return null;
  };
  if (kind === "doc") return decodeWithTextutil();
  if (kind === "docx" && data.length > 5_000_000) return decodeWithTextutil();
  if (kind === "docx" && data.length <= 5_000_000) {
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
  if (!url) return null;
  const response = await fetchImpl(url, {
    headers: { Accept: "*/*" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response?.ok) return null;
  const kind = attachmentKind(attachment) || attachmentKind({
    content_type: response.headers?.get?.("content-type") || "",
    url: response.headers?.get?.("content-disposition") || "",
  });
  if (!kind) return null;
  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  const maxBytes = kind === "docx" ? 20_000_000 : 5_000_000;
  if (contentLength > maxBytes) return null;
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) return null;
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
    const attachments = lawAttachmentCandidates(law.provenance?.attachments || []);
    let attachment = attachments[0] || null;
    let text = null;
    let error = null;
    for (const candidate of attachments) {
      for (let attempt = 1; attempt <= 3 && !text; attempt += 1) {
        try { text = await fetchAttachmentText(candidate, fetchImpl); }
        catch (caught) { error = caught; }
      }
      if (text) {
        attachment = candidate;
        break;
      }
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

const HTML_ENTITY_MAP = Object.freeze({
  amp: "&", apos: "'", bull: "•", copy: "©", deg: "°", hellip: "…",
  laquo: "«", ldquo: "“", lsquo: "‘", mdash: "—", middot: "·", nbsp: " ",
  ndash: "–", quot: '"', raquo: "»", rdquo: "”", reg: "®", rsquo: "’", sect: "§",
});

function decodeHtmlEntities(value) {
  return String(value ?? "").replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/giu, (entity, key) => {
    if (key[0] === "#") {
      const numeric = key[1]?.toLowerCase() === "x"
        ? Number.parseInt(key.slice(2), 16)
        : Number.parseInt(key.slice(1), 10);
      return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
        ? String.fromCodePoint(numeric)
        : entity;
    }
    return HTML_ENTITY_MAP[key.toLowerCase()] ?? entity;
  });
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
    .replace(/&[a-z#][a-z0-9#]*;/giu, (entity) => decodeHtmlEntities(entity))
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * Isolate the enacted bill text embedded in a public Legistar detail page.
 * Metadata, attachments, history, and comments are deliberately excluded so
 * extraction and quote verification share the same statute-only source span.
 */
export function lawTextFromLegistarDetailHtml(html) {
  const source = String(html ?? "");
  const marker = /<div\s+id=["']ctl00_ContentPlaceHolder1_divText["'][^>]*>/iu.exec(source);
  if (!marker) return null;
  const start = marker.index + marker[0].length;
  const endMarker = /<div\s+id=["']ctl00_ContentPlaceHolder1_pagePublicComments["'][^>]*>/giu;
  endMarker.lastIndex = start;
  const end = endMarker.exec(source)?.index ?? -1;
  if (end <= start) return null;
  const text = decodeHtmlText(source.slice(start, end));
  return text.length >= 40 ? text : null;
}

/** Select the strongest enacted-text attachment named on a detail page. */
export function finalLawAttachmentFromLegistarDetailHtml(html, detailUrl) {
  const source = String(html ?? "");
  const marker = /<span\s+id=["']ctl00_ContentPlaceHolder1_lblAttachments2["'][^>]*>/iu.exec(source);
  if (!marker) return null;
  const start = marker.index + marker[0].length;
  const end = source.indexOf("</span>", start);
  if (end <= start) return null;
  const anchors = [...source.slice(start, end).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu)]
    .map((match) => {
      const name = decodeHtmlText(match[2]);
      try {
        return { name, url: new URL(decodeHtmlEntities(match[1]), detailUrl).href };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((row) => !/^summary\b/iu.test(row.name));
  const rank = (name) => /\(final\)/iu.test(name) ? 0
    : /^local law\s+\d+/iu.test(name) ? 1
      : /^proposed\s+int\./iu.test(name) ? 2
        : /^int\./iu.test(name) ? 3
          : 9;
  return anchors.sort((left, right) => rank(left.name) - rank(right.name))[0] || null;
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
