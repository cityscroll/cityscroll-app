// Source-preserving adapters for the public MTA annual contract corpus and
// Construction & Development recent-award pages.

import {
  computeSourceRecordHash,
  SOURCE_RECORD_INSERT_SQL,
  sourceRecordDualWriteEnabled,
} from "./source_records.mjs";

export const MTA_SOURCE_RECORD_DUAL_WRITE_FLAG = "MTA_SOURCE_RECORD_DUAL_WRITE";
export const MTA_ANNUAL_SOURCE_SYSTEM = "mta_annual_contracts";
export const MTA_CD_AWARDS_SOURCE_SYSTEM = "mta_cd_awards";
export const MTA_ANNUAL_DATASET = "twsw-2mqa";
export const MTA_ANNUAL_SOURCE_URL = "https://data.ny.gov/Transportation/MTA-Procurements-Beginning-2018/twsw-2mqa";
export const MTA_CD_AWARDS_SOURCE_URL = "https://www.mta.info/agency/construction-and-development/contracting/recent-awards";
export const MTA_PARENT_INSTITUTION_ID = "metropolitan-transportation-authority";

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function amount(value) {
  const parsed = Number(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceHash(row) {
  return text(row?.raw_response_sha256 || row?.content_hash, "unknown");
}

export function mtaAnnualContractSourceSystemId(row) {
  return `contract:${text(row?.transaction_number || row?.contract_id, "no-contract-id")}`;
}

export function mtaCdAwardSourceSystemId(row) {
  return `award:${text(row?.contract_number || row?.contract_id, "no-contract-id")}`;
}

/**
 * Normalize one Socrata row while retaining its source-native fields.
 * The description is the only entity evidence in this dataset; the caller
 * supplies the reviewed operating-entity resolution for the fixture/adapter.
 */
export function normalizeMtaAnnualContractRow(row, {
  procuringInstitutionId,
  sourceAgencyLabel,
  retrievedAt,
  metadata = {},
} = {}) {
  const transaction = text(row?.transaction_number);
  if (!transaction) return null;
  const agency = text(sourceAgencyLabel, "Metropolitan Transportation Authority");
  const normalized = {
    ...row,
    source_system: MTA_ANNUAL_SOURCE_SYSTEM,
    source_dataset: MTA_ANNUAL_DATASET,
    source_record_id: transaction,
    observation_type: "contract",
    publisher_institution_id: MTA_PARENT_INSTITUTION_ID,
    procuring_institution_id: text(procuringInstitutionId) || null,
    source_agency_label: agency,
    agency_name: agency,
    vendor_name: text(row?.vendor_name) || null,
    title: text(row?.procurement_description) || null,
    contract_id: transaction,
    contract_amount: amount(row?.contract_amount),
    award_date: text(row?.award_date) || null,
    official_source_url: MTA_ANNUAL_SOURCE_URL,
    retrieved_at: text(retrievedAt) || null,
    snapshot_metadata: metadata,
    mta_parent_institution_id: MTA_PARENT_INSTITUTION_ID,
    entity_refs_all: [
      `agency:id:${text(procuringInstitutionId)}`,
      `agency:id:${MTA_PARENT_INSTITUTION_ID}`,
    ].filter((ref) => !ref.endsWith(":")),
  };
  return normalized;
}

/** Parse the public C&D accordion entries into award observations. */
export function parseMtaCdRecentAwardsHtml(html, { retrievedAt, metadata = {} } = {}) {
  const source = String(html || "");
  const yearBlocks = [...source.matchAll(/<h2[^>]*>\s*(\d{4}) awards\s*<\/h2>([\s\S]*?)(?=<h2|$)/gi)];
  const rows = [];
  for (const [, year, block] of yearBlocks) {
    for (const match of block.matchAll(/<summary[^>]*>[\s\S]*?>([^<]*?)<\/div>[\s\S]*?<div[^>]*class="[^"]*field--name-field-accordion-text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)) {
      const title = match[1].replace(/\s+/g, " ").trim();
      const details = match[2].replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
      const contract = title.match(/^(A\d{5,})\b/i)?.[1] || null;
      const firm = details.match(/Firm:\s*([^·]+?)(?=Firm Phone|Award Date|$)/i)?.[1]?.trim() || null;
      const awardDate = details.match(/Award Date:\s*([^·]+?)(?=Award Amount|Goals|$)/i)?.[1]?.trim() || null;
      const awardAmount = details.match(/Award Amount:\s*\$?([\d,]+(?:\.\d+)?)/i)?.[1] || null;
      if (!contract || !firm || !awardDate || !awardAmount) continue;
      rows.push({
        source_system: MTA_CD_AWARDS_SOURCE_SYSTEM,
        source_dataset: "mta-cd-recent-awards",
        source_record_id: contract,
        observation_type: "award",
        publisher_institution_id: MTA_PARENT_INSTITUTION_ID,
        procuring_institution_id: "mta-construction-and-development",
        source_agency_label: "MTA Construction & Development",
        agency_name: "MTA Construction & Development",
        contract_number: contract,
        contract_id: contract,
        title,
        procurement_description: title,
        vendor_name: firm,
        award_date: awardDate,
        contract_amount: amount(awardAmount),
        award_amount: amount(awardAmount),
        award_year: year,
        official_source_url: MTA_CD_AWARDS_SOURCE_URL,
        retrieved_at: text(retrievedAt) || null,
        snapshot_metadata: metadata,
        mta_parent_institution_id: MTA_PARENT_INSTITUTION_ID,
        entity_refs_all: [
          "agency:id:mta-construction-and-development",
          `agency:id:${MTA_PARENT_INSTITUTION_ID}`,
        ],
      });
    }
  }
  return rows;
}

export function buildMtaSourceRecord({ sourceSystem, sourceSystemId, rawRow, normalizedRow, contentHash } = {}) {
  if (!sourceSystem || !sourceSystemId || !rawRow || !normalizedRow) return null;
  return {
    source_system: sourceSystem,
    source_system_id: sourceSystemId,
    content_hash: contentHash || sourceHash(normalizedRow),
    raw_snapshot: rawRow,
    normalized_snapshot: normalizedRow,
    ingested_at: normalizedRow.retrieved_at || null,
  };
}

/** Fail-soft dual-write of retained MTA observations into source_records. */
export async function dualWriteMtaObservations(env, records, ingestedAt) {
  if (!sourceRecordDualWriteEnabled(env, MTA_SOURCE_RECORD_DUAL_WRITE_FLAG)) {
    return { written: 0, skipped: "flag-off" };
  }
  if (!env?.DB) return { written: 0, skipped: "no-db" };
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!list.length) return { written: 0, skipped: "empty" };
  let insert;
  try {
    insert = env.DB.prepare(SOURCE_RECORD_INSERT_SQL);
  } catch {
    return { written: 0, skipped: "no-schema" };
  }
  try {
    const at = ingestedAt || new Date().toISOString();
    const statements = await Promise.all(list.map(async (record) => {
      const raw = record.raw_snapshot || record.raw || {};
      const normalized = record.normalized_snapshot || record.normalized || raw;
      return insert.bind(
        record.source_system,
        record.source_system_id,
        record.content_hash || await computeSourceRecordHash(raw),
        JSON.stringify(raw),
        JSON.stringify(normalized),
        record.ingested_at || at,
      );
    }));
    await env.DB.batch(statements);
    return { written: statements.length, skipped: null };
  } catch {
    return { written: 0, failed: true };
  }
}
