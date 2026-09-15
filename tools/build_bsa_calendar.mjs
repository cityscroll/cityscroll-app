#!/usr/bin/env node

/** Refresh the retained BSA daily-session calendar from the official agenda. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseBsaAgendaPages } from "../site/bsa_calendar.mjs";
import { extractPdfCalendarText } from "./lib/pdf_calendar_text.mjs";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(ROOT, "site/data/bsa_calendar.json");
const UPCOMING_URL = "https://www.nyc.gov/site/bsa/public-hearings/upcoming-hearing-info.page";

function uniqueRegistrationLinks(html) {
  return [...new Set(
    [...String(html).matchAll(/https?:\/\/[^\s"'<>]*(?:zoomgov\.com|zoom\.us)[^\s"'<>]*/gi)]
      .map((match) => match[0].replaceAll("&amp;", "&").replace(/[),.;]+$/, ""))
      .filter((url) => /(?:register|registration)/i.test(url)),
  )];
}

async function fetchResponse(url, accept) {
  const response = await fetch(url, {
    headers: { Accept: accept, "User-Agent": "CityScrollBsaCalendar/1.0 (+https://cityscroll.org)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`BSA source returned HTTP ${response.status}: ${url}`);
  return response;
}

async function refresh() {
  const pageResponse = await fetchResponse(UPCOMING_URL, "text/html");
  const pageHtml = await pageResponse.text();
  const agendaMatch = pageHtml.match(/(?:https?:\/\/[^\s"'<>]+)?\/assets\/bsa\/downloads\/pdf\/lineup\/[^\s"'<>]+\.pdf/i);
  if (!agendaMatch) throw new Error("BSA upcoming-hearing page did not publish an agenda PDF");
  const agendaUrl = new URL(agendaMatch[0].replaceAll("&amp;", "&"), UPCOMING_URL).href;
  const pdfResponse = await fetchResponse(agendaUrl, "application/pdf");
  const text = extractPdfCalendarText(new Uint8Array(await pdfResponse.arrayBuffer()));
  if (!text.trim()) throw new Error("BSA agenda PDF produced no extractable text");
  const registrationLinks = uniqueRegistrationLinks(pageHtml);
  const pages = text.split("\f").map((pageText, index) => ({
    page: index + 1,
    text: pageText,
    remote_registration_url: registrationLinks[index] || null,
    source_url: agendaUrl,
  }));
  const sessions = parseBsaAgendaPages({
    pages,
    notice: { source_url: UPCOMING_URL, agenda_url: agendaUrl },
    publication_date: new Date().toISOString().slice(0, 10),
  });
  if (!sessions.length) throw new Error("BSA agenda PDF contained no dated sessions");
  return {
    schema: "cityscroll.bsa_calendar_materialization.v1",
    generated_at: new Date().toISOString(),
    source: { system: "bsa_calendar", url: UPCOMING_URL, agenda_url: agendaUrl },
    rows: sessions.map((session, index) => ({
      ...session,
      remote_registration_url: session.remote_registration_url || registrationLinks[index] || null,
    })),
  };
}

function checkArtifact() {
  if (!existsSync(OUT)) throw new Error(`missing ${OUT}`);
  const artifact = JSON.parse(readFileSync(OUT, "utf8"));
  if (artifact.schema !== "cityscroll.bsa_calendar_materialization.v1") throw new Error("BSA artifact schema is invalid");
  if (!Array.isArray(artifact.rows) || !artifact.rows.length) throw new Error("BSA artifact has no retained sessions");
  if (!artifact.rows.every((row) => row.event_date && row.source_url && Array.isArray(row.agenda_items))) {
    throw new Error("BSA artifact has an incomplete session row");
  }
  console.log(`BSA calendar artifact is current rows=${artifact.rows.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    checkArtifact();
  } else {
    writeFileSync(OUT, `${JSON.stringify(await refresh(), null, 2)}\n`);
    console.log(`wrote ${OUT}`);
  }
}
