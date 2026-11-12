// Public entity-register readers: DOS on-demand, IRS EO BMF NY, DOL contractor registry, SCA firms.
export {
  REGISTER_IDS,
  ENTITY_CLASSES,
  RECORD_KEYS,
  FLAGS,
  makeRecord,
  validateRecord,
  addressFrom,
  nonEmpty,
} from "./read_contract.mjs";

export { parseCsv, parseCsvRecords } from "./csv.mjs";

export { entityClassOf, loadEntityClassMap } from "./entity_class.mjs";

export {
  DOS_REGISTER,
  DOS_DATASET_ID,
  DOS_RESOURCE_URL,
  DOS_LANDING_URL,
  DOS_FIELDS,
  DOS_BLOCKS,
  DOS_LIMITS,
  REFUSAL,
  andFolded,
  tokenize,
  prepareName,
  soqlString,
  buildNameQuery,
  buildIdQuery,
  buildExactBatchQuery,
  mapDosRow,
  classifyRows,
  classifyFailure,
  lookupDosByName,
  lookupDosById,
} from "./dos_entities.mjs";

export {
  IRS_COLUMNS,
  normalizeIrsCsv,
  normalizeIrsRecord,
  nonNullCounts,
} from "./irs_eo_bmf.mjs";

export {
  normalizeDolRow,
  normalizeScaRows,
  stripComputed,
} from "./table_registers.mjs";

export {
  ARTIFACT_SCHEMA,
  buildArtifact,
  loadArtifact,
  lookupById,
  lookupByStem,
  lookupByName,
} from "./register_index.mjs";
