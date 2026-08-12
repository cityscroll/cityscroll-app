// Conservative hearing logistics extraction shared by the Worker and rule surfaces.
// A mode is a source-backed fact only when the notice says so or publishes a
// recognizable video-conference join URL. Generic URLs do not imply online attendance.

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;
const ONLINE_HOST_RE = /(?:zoom(?:gov)?\.com|zoom\.us|teams\.microsoft\.com|webex\.com|meet\.google\.com)\b/i;
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

function onlineUrl(value) {
  const url = normalizeUrl(value);
  return url && ONLINE_HOST_RE.test(url) ? url : null;
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

export function sourceSignalsFromHtml(html) {
  const raw = String(html || "");
  const sourceLinks = [...raw.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1].replace(/&amp;/gi, "&"))
    .map(normalizeUrl)
    .filter(Boolean);
  const body = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return { body, sourceLinks: [...new Set(sourceLinks)] };
}
