#!/usr/bin/env node

/**
 * Build the current NYC Administrative Code read model from American Legal
 * Publishing's bulk XML. The publisher's XML is split at chapter documents;
 * each document becomes a bounded public shard so no Pages file approaches the
 * per-file limit and the resident path never calls the publisher.
 */

import {
  createHash,
} from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

const SOURCE_SYSTEM = "american_legal_publishing";
const CORPUS_ID = "nyc-administrative-code";
const SOURCE_URL = "https://files.amlegal.com/pdffiles/NewYorkCity/Admin/XML.zip";
const LANDING_URL = "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCadmin/0-0-0-1";
const OBSERVED_AT = process.env.CITYSCROLL_ADMIN_CODE_OBSERVED_AT || new Date().toISOString();

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function clean(value, max = 8_000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(Number(number)))
    .replaceAll("&nbsp;", " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)]
    .map((match) => [match[1], decodeXml(match[2] ?? match[3] ?? "")]));
}

function appendCapture(capture, value) {
  if (capture) capture.parts.push(value);
}

function parseXml(xml) {
  const levels = [];
  const levelStack = [];
  let record = null;
  let capture = null;
  for (const match of xml.matchAll(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
    const token = match[0];
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<!")) continue;
    if (!token.startsWith("<")) {
      appendCapture(capture, decodeXml(token));
      continue;
    }
    const closing = /^<\s*\/\s*([\w-]+)/.exec(token);
    if (closing) {
      const name = closing[1].toUpperCase();
      if (name === "HEADING" && capture?.kind === "heading") {
        record.heading = capture.parts.join("");
        capture = null;
      } else if (name === "PARA" && capture?.kind === "para") {
        record?.paras.push(capture.parts.join(""));
        capture = null;
      } else if (name === "RECORD") {
        record = null;
      } else if (name === "LEVEL") {
        const level = levelStack.pop();
        if (level) {
          levelStack.at(-1)?.children.push(level);
          levels.push(level);
        }
      }
      continue;
    }
    const opening = /^<\s*([\w-]+)/.exec(token);
    if (!opening) continue;
    const name = opening[1].toUpperCase();
    const attrs = attributes(token);
    const selfClosing = /\/\s*>$/.test(token);
    if (name === "LEVEL") {
      const level = {
        style_name: attrs["style-name"] || "",
        level_depth: Number(attrs["level-depth"] || 0),
        records: [],
        children: [],
        parents: levelStack.slice(),
      };
      levelStack.push(level);
      if (selfClosing) {
        const closed = levelStack.pop();
        levelStack.at(-1)?.children.push(closed);
        levels.push(closed);
      }
    } else if (name === "RECORD") {
      record = { id: attrs.id || null, number: attrs.number || null, version: attrs.version || null, heading: "", paras: [] };
      levelStack.at(-1)?.records.push(record);
      if (selfClosing) record = null;
    } else if (name === "HEADING" && record) {
      capture = { kind: "heading", parts: [] };
      if (selfClosing) { record.heading = ""; capture = null; }
    } else if (name === "PARA" && record) {
      capture = { kind: "para", parts: [] };
      if (selfClosing) { record.paras.push(""); capture = null; }
    } else if (name === "LINEBRK") {
      appendCapture(capture, "\n");
    } else if (name === "TAB") {
      appendCapture(capture, "\t");
    }
  }
  return levels;
}

function sectionCitation(value) {
  const source = clean(value, 500).replace(/\s+/g, " ");
  const match = source.match(/§\s*([0-9]+[A-Za-z]?-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)/);
  return match ? match[1].toLowerCase() : null;
}

function levelName(styleName) {
  return clean(styleName, 80).toLowerCase().replace(/\s+-\s+/g, "-").replace(/\s+/g, "_");
}

function hierarchyCitation(value) {
  const text = clean(value, 500);
  const match = text.match(/(?:title|chapter|subchapter|article|part|appendix|subarticle)[^0-9]*([0-9]+[A-Za-z]?)/i);
  return match?.[1]?.toLowerCase() || null;
}

function hierarchyId(level, label, parents) {
  const citationParts = parents
    .map((parent) => hierarchyCitation(parent.label))
    .filter(Boolean);
  const own = hierarchyCitation(label);
  const suffix = [...citationParts, own].filter(Boolean).join("-")
    || clean(label, 160).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${CORPUS_ID}:${level}:${suffix}`;
}

function stripPublisherMarkers(value) {
  return clean(value, 50_000)
    .replace(/\[ALP\s+S-[^\]]+\]/gi, "")
    .replace(/\s*\(Am\.\s+L\.L\.[\s\S]*$/i, "")
    .replace(/\s*\(repealed[^)]*\)\s*$/i, "")
    .trim();
}

function hierarchyForSection(sectionLevel) {
  const parents = [];
  for (const parent of sectionLevel.parents) {
    const style = levelName(parent.style_name);
    if (!style || style === "normal_level") continue;
    const label = clean(parent.records[0]?.heading || parent.records[0]?.paras?.[0]);
    if (!label) continue;
    const id = hierarchyId(style, label, parents);
    parents.push({ level: style, label, id });
  }
  return parents;
}

function recordsUnder(level) {
  return [
    ...(level.records || []),
    ...(level.children || []).flatMap(recordsUnder),
  ];
}

function rowsFromXml(xml, sourceFile, sourceHash) {
  const levels = parseXml(xml);
  const rows = [];
  for (const sectionLevel of levels.filter((level) => levelName(level.style_name) === "section")) {
    const header = sectionLevel.records[0];
    const citation = sectionCitation(header?.heading || header?.paras?.[0]);
    if (!citation || !header?.id) continue;
    const heading = clean((header.heading || "").replace(/^§\s*[^ ]+\s*/i, ""))
      .replace(/\s*\[Repealed\]\s*$/i, "") || null;
    const currentText = recordsUnder(sectionLevel).slice(1)
      .flatMap((item) => item.paras || [])
      .map(stripPublisherMarkers)
      .filter((item) => item && !/^editor['’]s note:/i.test(item))
      .join("\n\n")
      .trim();
    const hierarchy = hierarchyForSection(sectionLevel);
    const parentId = hierarchy.at(-1)?.id || null;
    const sourceRef = `${SOURCE_SYSTEM}:admin-xml:${sourceFile}:${header.id}`;
    const sectionUrl = `https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCadmin/0-0-0-${header.id.replace(/^0-0-0-/, "")}`;
    rows.push({
      schema: "cityscroll.code_provision.v1",
      id: `${CORPUS_ID}:${citation}`,
      corpus_id: CORPUS_ID,
      citation: `§ ${citation}`,
      heading,
      parent_id: parentId,
      level: "section",
      status: /\[repealed\]/i.test(header.heading || "") ? "repealed" : "current",
      current_text: currentText,
      source: {
        url: sectionUrl,
        system: SOURCE_SYSTEM,
        source_ref: sourceRef,
        observed_at: OBSERVED_AT,
        content_hash: sha256(currentText),
        document_hash: sourceHash,
      },
      hierarchy,
    });
  }
  return rows.sort((left, right) => left.citation.localeCompare(right.citation, "en-US", { numeric: true }));
}

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    result[key.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}

const args = options(process.argv.slice(2));
const xmlDir = resolve(args["xml-dir"] || ".artifacts/admin-code-source/XML");
const outputDir = resolve(args["output-dir"] || "site/data/legal_code");
const shardDir = join(outputDir, "shards");
const files = readdirSync(xmlDir)
  .filter((file) => extname(file).toLowerCase() === ".xml")
  .sort((left, right) => left.localeCompare(right, "en-US", { numeric: true }));
if (!files.length) throw new Error(`No XML files found in ${xmlDir}`);
rmSync(shardDir, { recursive: true, force: true });
mkdirSync(shardDir, { recursive: true });

const allRows = [];
const shards = [];
let publisherCurrentThrough = null;
for (const file of files) {
  const sourcePath = join(xmlDir, file);
  const sourceBuffer = readFileSync(sourcePath);
  const sourceHash = sha256(sourceBuffer);
  const xml = sourceBuffer.toString("utf8");
  publisherCurrentThrough ||= xml.match(/Current through ([^<]+?)(?:<|\r?\n)/i)?.[1]?.trim() || null;
  const rows = rowsFromXml(xml, file, sourceHash);
  if (!rows.length) continue;
  const shardName = `${file.replace(/\.xml$/i, "")}.json`;
  const shardPath = join(shardDir, shardName);
  const shardPayload = {
    schema: "cityscroll.legal_code_shard.v1",
    corpus_id: CORPUS_ID,
    source_file: file,
    source_url: `${LANDING_URL}#${file.replace(/\.xml$/i, "")}`,
    observed_at: OBSERVED_AT,
    document_content_hash: sourceHash,
    rows,
  };
  writeFileSync(shardPath, `${JSON.stringify(shardPayload)}\n`);
  shards.push({ path: `shards/${shardName}`, source_file: file, count: rows.length, content_hash: sha256(JSON.stringify(shardPayload)) });
  allRows.push(...rows);
}

const citations = {};
const duplicates = [];
for (const [index, row] of allRows.entries()) {
  if (citations[row.citation]) duplicates.push({ citation: row.citation, first: citations[row.citation], duplicate: row.id });
  else citations[row.citation] = { shard: shards.find((shard) => shard.source_file === row.source.source_ref.split(":admin-xml:")[1].split(":")[0])?.path || null, id: row.id, row_index: index };
}
const manifest = {
  schema: "cityscroll.legal_corpus_manifest.v1",
  corpus: {
    id: CORPUS_ID,
    name: "New York City Administrative Code",
    jurisdiction: "NYC",
    instrument_kind: "municipal_code",
  },
  source: {
    system: SOURCE_SYSTEM,
    landing_url: LANDING_URL,
    bulk_url: SOURCE_URL,
    asset_kind: "bulk_xml_zip",
    observed_at: OBSERVED_AT,
    content_hash: args["source-zip-hash"] || null,
    publisher_current_through: publisherCurrentThrough,
    structure: {
      split_level: "Chapter",
      levels: ["Title", "Chapter", "Subchapter", "Appendix", "Part", "Article", "Subarticle", "Section"],
      document_count: files.length,
      shard_count: shards.length,
    },
  },
  counts: {
    provisions: new Set(allRows.map((row) => row.id)).size,
    observations: allRows.length,
    duplicates: duplicates.length,
  },
  shards,
  citations,
  duplicate_citations: duplicates,
};
writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// Search receives a deliberately compact projection. Full provision text stays
// in the chapter shards and is loaded only by an exact detail route.
const searchRows = [...new Map(allRows.map((row) => [row.id, row])).values()].map((row) => ({
  schema: "cityscroll.search_document.v1",
  object_ref: row.id,
  object_type: "legal_code",
  domain: "legal",
  canonical_href: `/administrative-code/${row.citation.slice(2)}/`,
  title: `Administrative Code ${row.citation}${row.heading ? ` — ${row.heading}` : ""}`,
  summary: row.heading || "Current NYC Administrative Code provision",
  search_text: [row.citation, row.id, row.heading, row.current_text.slice(0, 600)].filter(Boolean).join(" "),
  source_family: "nyc_administrative_code",
  source_observation_refs: [row.source.source_ref],
  process_role: null,
  classification: {
    method: "exact_american_legal_publishing_xml_projection",
    basis: "Current Administrative Code bulk XML section record",
  },
  provenance: {
    producer: "admin_code_search_document.v1",
    source_system: SOURCE_SYSTEM,
    source_freshness: { observed_at: row.source.observed_at },
    lifecycle: { state: row.status },
    identity: { code: row.citation },
  },
  outcome: "indexed",
  coverage_state: "matched",
}));
writeFileSync(join(outputDir, "search.json"), `${JSON.stringify({
  schema: "cityscroll.legal_code_search_index.v1",
  generated_at: OBSERVED_AT,
  source: SOURCE_SYSTEM,
  source_observation: { observed_at: OBSERVED_AT, content_hash: args["source-zip-hash"] || null },
  indexed_count: searchRows.length,
  documents: searchRows,
}, null, 2)}\n`);
console.log(`wrote ${allRows.length} provisions across ${shards.length} shards to ${outputDir}`);
