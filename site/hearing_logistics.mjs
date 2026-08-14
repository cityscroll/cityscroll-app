// Conservative hearing logistics extraction shared by the Worker and rule surfaces.
// A mode is a source-backed fact only when the notice says so or publishes a
// recognizable video-conference join URL. Generic URLs do not imply online attendance.

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;
const ONLINE_HOST_RE = /(?:zoom(?:gov)?\.com|zoom\.us|teams\.microsoft\.com|webex\.com|meet\.google\.com)\b/i;
const CITY_RECORD_HOST = "a856-cityrecord.nyc.gov";
const CITY_RECORD_REQUEST_RE = /\/RequestDetail\/([^/?#]+)/i;
const ONLINE_LANGUAGE_RE = /\b(?:online|virtual|remote|remotely|via\s+(?:zoom|teams|webex)|video[- ]conference|conference\s+call)\b/i;
const JOIN_LANGUAGE_RE = /\b(?:join|register|registration|enter\s+to\s+register|participate|connect)\b[^.\n]{0,120}\b(?:meeting|hearing|zoom|teams|webex|online|virtual)\b/i;
const ADDRESS_RE = /\b\d{1,5}(?:-\d{1,5})?\s+[A-Z0-9][A-Z0-9.'’ -]{1,70}\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway)\b/i;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g;

export const HEARING_LOGISTICS_RULE =
  "Explicit online language or a recognized video-conference URL means online; a physical address without a virtual signal means in person; both means hybrid; otherwise the mode remains not stated.";

function clean(value) {
  if (value == null) return null;
  const output = String(value).replace(/\s+/g, " ").trim();
  return output || null;
}

function normalizeUrl(value) {
  const raw = String(value || "").replace(/&amp;/gi, "&").replace(/[.,;:)\]]+$/g, "");
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function hasClass(tag, className) {
  const classes = /\bclass\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || "";
  return new RegExp(`(?:^|\\s)${className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(classes);
}

function divElementByClass(html, className, from = 0) {
  const opening = /<div\b[^>]*>/gi;
  opening.lastIndex = from;
  let match;
  while ((match = opening.exec(html))) {
    if (!hasClass(match[0], className)) continue;
    const tag = /<\/?div\b[^>]*>/gi;
    tag.lastIndex = opening.lastIndex;
    let depth = 1;
    let nested;
    while ((nested = tag.exec(html))) {
      if (/^<\//.test(nested[0])) depth -= 1;
      else if (!/\/\s*>$/.test(nested[0])) depth += 1;
      if (depth === 0) {
        return {
          html: html.slice(opening.lastIndex, nested.index),
          end: tag.lastIndex,
        };
      }
    }
    return null;
  }
  return null;
}

function divElementByClassWithText(html, className, textPattern) {
  let from = 0;
  while (from < html.length) {
    const element = divElementByClass(html, className, from);
    if (!element) return null;
    if (textPattern.test(element.html)) return element;
    from = element.end;
  }
  return null;
}

function textFromHtml(html) {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Validate and resolve a City Record attachment URL. The request and document
 * identifiers are required so a generic GetFile route cannot become a link.
 */
export function officialCityRecordAttachmentUrl(value, sourceUrl = null) {
  const raw = String(value || "").replace(/&amp;/gi, "&").trim();
  let url;
  try { url = new URL(raw, sourceUrl || undefined); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== CITY_RECORD_HOST || !/^\/Search\/GetFile$/i.test(url.pathname)) return null;
  const requestId = url.searchParams.get("requestId") || url.searchParams.get("RequestID");
  const documentId = url.searchParams.get("documentId") || url.searchParams.get("DocumentID");
  if (!requestId || !documentId) return null;
  const sourceRequestId = sourceUrl?.match(CITY_RECORD_REQUEST_RE)?.[1];
  if (sourceRequestId && decodeURIComponent(requestId) !== decodeURIComponent(sourceRequestId)) return null;
  return url.toString();
}

export function recognizedMeetingUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  if (ONLINE_HOST_RE.test(url.hostname)) return url.toString();
  if (/\/(?:zoom|webex|teams)\/(?:j|join|meeting|register)(?:[/?#]|$)/i.test(url.pathname)) return url.toString();
  if (/nycida-board-meetings-public-hearings/i.test(url.href) || /edc\.nyc\/nycida(?:[/?#]|$)/i.test(url.href)) return url.toString();
  return null;
}

function publishedMeetingUrl(value, sourceUrl = null) {
  let resolved;
  try { resolved = new URL(String(value || "").replace(/&amp;/gi, "&"), sourceUrl || undefined).toString(); } catch { return null; }
  return recognizedMeetingUrl(resolved);
}

function onlineUrl(value) {
  return recognizedMeetingUrl(value);
}

function bodyUrls(body, sourceLinks = []) {
  const candidates = [
    ...(String(body || "").match(URL_RE) || []),
    ...(Array.isArray(sourceLinks) ? sourceLinks : []),
  ];
  return [...new Set(candidates.map(normalizeUrl).filter(Boolean))];
}

function joinUrlFrom(body, urls) {
  const online = urls.map(onlineUrl).filter(Boolean);
  if (online.length) return online[0];
  const text = String(body || "");
  for (const url of urls) {
    const index = text.indexOf(url);
    if (index >= 0 && JOIN_LANGUAGE_RE.test(text.slice(Math.max(0, index - 120), index + url.length + 120))) return url;
  }
  return null;
}

function physicalLocationFromBody(body, structuredLocation) {
  const structured = clean(structuredLocation);
  if (structured) return structured;
  const text = String(body || "");
  const match = ADDRESS_RE.exec(text);
  if (!match) return null;
  // A rule or consent body can list affected properties without naming them as
  // the hearing venue. Require nearby venue language before treating a body
  // address as in-person evidence.
  const context = text.slice(Math.max(0, match.index - 100), match.index + match[0].length + 80);
  if (!/(?:\bheld\s+(?:at|in)\b|\blocated\s+(?:at|in)\b|\b(?:venue|room|address)\b[\s:,-]{0,20})/i.test(context)) return null;
  return clean(match[0]);
}

/**
 * @returns {{mode: "remote"|"hybrid"|"in-person"|"unknown", in_person_location: string|null,
 *   remote_join_url: string|null, dial_in: string[], passcode: string|null}}
 */
export function inferHearingLogistics({ body = "", sourceLinks = [], physicalLocation = null } = {}) {
  const text = String(body || "");
  const urls = bodyUrls(text, sourceLinks);
  const joinUrl = joinUrlFrom(text, urls);
  const online = ONLINE_LANGUAGE_RE.test(text) || !!joinUrl;
  const location = physicalLocationFromBody(text, physicalLocation);
  const inPerson = !!location || /\b(?:in[- ]person|at the .*\b(?:room|street|avenue|boulevard)\b)\b/i.test(text);
  const mode = online && inPerson ? "hybrid" : online ? "remote" : inPerson ? "in-person" : "unknown";
  const dialIn = [...new Set((text.match(PHONE_RE) || []).map(clean).filter(Boolean))].slice(0, 6);
  const passcode = text.match(/\b(?:passcode|password|meeting\s+password)\s*[:#-]?\s*([A-Za-z0-9._-]{3,})/i)?.[1] || null;
  return {
    mode,
    in_person_location: location,
    remote_join_url: joinUrl,
    dial_in: dialIn,
    passcode: clean(passcode),
  };
}

export function sourceSignalsFromHtml(html, sourceUrl = null) {
  const raw = String(html || "");
  const notice = divElementByClass(raw, "page-body");
  const body = textFromHtml(notice?.html || "");
  const noticeLinks = [...(notice?.html || "").matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)]
    .map((match) => publishedMeetingUrl(match[1], sourceUrl))
    .filter(Boolean);
  const attachmentSection = divElementByClassWithText(notice?.html || "", "portlet light", /\bAttachments\b/i);
  const attachmentLinks = [...(attachmentSection?.html || "").matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)]
    .map((match) => officialCityRecordAttachmentUrl(match[1], sourceUrl))
    .filter(Boolean);
  return { body, sourceLinks: [...new Set([...noticeLinks, ...attachmentLinks])] };
}
