// DOF Tax Lien Sale Lists: cycle reconstruction and transparent base rates.
//
// The publisher exposes one row per BBL and notice publication. A new 90-day
// publication starts a cycle; later 60/30/10-day and final-sale publications
// belong to it until the next 90-day publication. A missing final-sale list is
// retained as a program-level no-sale outcome, never imputed as a property sale.

export const TAX_LIEN_MODEL_VERSION = "1.0.0";
export const TAX_LIEN_MIN_TRAINING_CYCLES = 3;
export const TAX_LIEN_PHASES = Object.freeze([
  "notice_90",
  "notice_60",
  "notice_30",
  "notice_10",
  "sold",
]);

const PHASE_ORDER = new Map(TAX_LIEN_PHASES.map((stage, index) => [stage, index]));
const BOROUGH_NAMES = Object.freeze({
  "1": "Manhattan",
  "2": "Bronx",
  "3": "Brooklyn",
  "4": "Queens",
  "5": "Staten Island",
});

function isoDay(value) {
  const day = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))) {
    throw new TypeError(`invalid tax-lien publication date: ${value}`);
  }
  return day;
}

function rate(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;
}

export function normalizeTaxLienStage(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (/^90 days? notice$/.test(normalized)) return "notice_90";
  if (/^60 days? notice$/.test(normalized)) return "notice_60";
  if (/^30 days? notice$/.test(normalized)) return "notice_30";
  if (/^10 days? notice$/.test(normalized)) return "notice_10";
  if (normalized === "final sale" || /^sale\s*\(?[12]\)?$/.test(normalized)) return "sold";
  return null;
}

export function taxLienBbl(row) {
  const borough = String(row?.borough ?? "").replace(/\D/g, "");
  const block = String(row?.block ?? "").replace(/\D/g, "");
  const lot = String(row?.lot ?? "").replace(/\D/g, "");
  if (!/^[1-5]$/.test(borough) || !block || block.length > 5 || !lot || lot.length > 4) return null;
  return `${borough}${block.padStart(5, "0")}${lot.padStart(4, "0")}`;
}

function normalizedRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const stage = normalizeTaxLienStage(row?.cycle);
    const bbl = taxLienBbl(row);
    if (!stage || !bbl) return null;
    return {
      ...row,
      _index: index,
      month: isoDay(row.month),
      stage,
      bbl,
      borough: bbl[0],
    };
  }).filter(Boolean).sort((left, right) => left.month.localeCompare(right.month)
    || PHASE_ORDER.get(left.stage) - PHASE_ORDER.get(right.stage)
    || left.bbl.localeCompare(right.bbl)
    || left._index - right._index);
}

function reconstructCycles(rows) {
  const publications = new Map();
  for (const row of rows) {
    const key = `${row.month}|${row.stage}`;
    if (!publications.has(key)) publications.set(key, { month: row.month, stage: row.stage, rows: [] });
    publications.get(key).rows.push(row);
  }
  const ordered = [...publications.values()].sort((left, right) => left.month.localeCompare(right.month)
    || PHASE_ORDER.get(left.stage) - PHASE_ORDER.get(right.stage));
  const cycles = [];
  let current = null;
  for (const publication of ordered) {
    if (publication.stage === "notice_90") {
      current = {
        cycle_id: publication.month,
        publications: [],
        stages: Object.fromEntries(TAX_LIEN_PHASES.map((stage) => [stage, new Map()])),
      };
      cycles.push(current);
    }
    if (!current) continue;
    current.publications.push({
      stage: publication.stage,
      published_at: publication.month,
      count: publication.rows.length,
    });
    for (const row of publication.rows) current.stages[publication.stage].set(row.bbl, row);
  }
  return cycles;
}

function conversion(stageMap, soldMap) {
  let reachedSale = 0;
  for (const bbl of stageMap.keys()) if (soldMap.has(bbl)) reachedSale += 1;
  return {
    denominator: stageMap.size,
    reached_sale: reachedSale,
    left_before_sale: stageMap.size - reachedSale,
    probability_reach_sale: rate(reachedSale, stageMap.size),
    probability_leave_before_sale: rate(stageMap.size - reachedSale, stageMap.size),
  };
}

function cycleProjection(cycle) {
  const boroughs = {};
  for (const [code, name] of Object.entries(BOROUGH_NAMES)) {
    const sold = new Map([...cycle.stages.sold].filter(([bbl]) => bbl[0] === code));
    const stages = {};
    for (const stage of TAX_LIEN_PHASES.slice(0, -1)) {
      const stageRows = new Map([...cycle.stages[stage]].filter(([bbl]) => bbl[0] === code));
      stages[stage] = conversion(stageRows, sold);
    }
    boroughs[code] = { name, stages };
  }
  return {
    cycle_id: cycle.cycle_id,
    published_from: cycle.publications[0]?.published_at || cycle.cycle_id,
    published_to: cycle.publications.at(-1)?.published_at || cycle.cycle_id,
    program_outcome: cycle.stages.sold.size ? "final_sale_published" : "no_final_sale_publication",
    publications: cycle.publications,
    citywide: Object.fromEntries(TAX_LIEN_PHASES.slice(0, -1).map((stage) => [
      stage,
      conversion(cycle.stages[stage], cycle.stages.sold),
    ])),
    boroughs,
  };
}

function pooledProjection(cycles) {
  const pooled = Object.fromEntries(TAX_LIEN_PHASES.map((stage) => [stage, new Map()]));
  // Prefix cycle id so the same BBL in two programs remains two observations.
  for (const cycle of cycles) {
    for (const stage of TAX_LIEN_PHASES) {
      for (const [bbl, row] of cycle.stages[stage]) pooled[stage].set(`${cycle.cycle_id}:${bbl}`, row);
    }
  }
  const citywide = Object.fromEntries(TAX_LIEN_PHASES.slice(0, -1).map((stage) => [
    stage,
    conversion(pooled[stage], pooled.sold),
  ]));
  const boroughs = {};
  for (const [code, name] of Object.entries(BOROUGH_NAMES)) {
    const sold = new Map([...pooled.sold].filter(([, row]) => row.borough === code));
    boroughs[code] = {
      name,
      ...Object.fromEntries(TAX_LIEN_PHASES.slice(0, -1).map((stage) => {
        const stageRows = new Map([...pooled[stage]].filter(([, row]) => row.borough === code));
        return [stage, conversion(stageRows, sold)];
      })),
    };
  }
  return { citywide, boroughs };
}

function latestStage(cycle, bbl) {
  let latest = "notice_90";
  for (const stage of TAX_LIEN_PHASES) if (cycle.stages[stage].has(bbl)) latest = stage;
  return latest;
}

function holdoutProjection(cycle, schedule, generatedAt) {
  const sold = cycle.stages.sold;
  const byBbl = {};
  for (const [bbl, row] of cycle.stages.notice_90) {
    byBbl[bbl] = {
      stage: latestStage(cycle, bbl),
      outcome: sold.has(bbl) ? "sold_lien" : "left_before_sale",
      borough: BOROUGH_NAMES[row.borough],
      borough_code: row.borough,
      community_board: row.community_board || null,
      tax_class_code: row.tax_class_code || null,
      water_debt_only: row.water_debt_only || null,
    };
  }
  const saleDate = schedule?.sale_date || cycle.publications.find((row) => row.stage === "sold")?.published_at || null;
  const generatedDay = isoDay(generatedAt);
  return {
    ...cycleProjection(cycle),
    sale_date: saleDate,
    action_deadline: schedule?.action_deadline || null,
    status: saleDate && saleDate < generatedDay ? "expired" : "open",
    data_vintage: cycle.publications.at(-1)?.published_at || cycle.cycle_id,
    by_bbl: byBbl,
  };
}

export function buildTaxLienSaleModel(rows, options = {}) {
  const generatedAt = options.generated_at || new Date().toISOString();
  const cycles = reconstructCycles(normalizedRows(rows));
  if (!cycles.length) throw new TypeError("tax-lien rows contain no 90-day cycle");
  const holdoutId = options.holdout_cycle || cycles.at(-1).cycle_id;
  const holdout = cycles.find((cycle) => cycle.cycle_id === holdoutId);
  if (!holdout) throw new TypeError(`unknown tax-lien holdout cycle: ${holdoutId}`);
  const trainingCycles = cycles.filter((cycle) => cycle.cycle_id < holdoutId);
  if (trainingCycles.length < TAX_LIEN_MIN_TRAINING_CYCLES) {
    throw new TypeError(
      `tax-lien model requires at least ${TAX_LIEN_MIN_TRAINING_CYCLES} historical cycles before ${holdoutId}; got ${trainingCycles.length}`,
    );
  }
  const pooled = pooledProjection(trainingCycles);
  const projectedCycles = trainingCycles.map(cycleProjection);
  return {
    schema_version: 1,
    model_name: "tax_lien_sale_progression",
    model_version: TAX_LIEN_MODEL_VERSION,
    generated_at: generatedAt,
    training: {
      cycle_count: trainingCycles.length,
      cycle_ids: trainingCycles.map((cycle) => cycle.cycle_id),
      train_from: trainingCycles[0].cycle_id,
      train_to: trainingCycles.at(-1).publications.at(-1).published_at,
      cycles: projectedCycles,
      citywide: pooled.citywide,
      boroughs: pooled.boroughs,
    },
    holdout: holdoutProjection(holdout, options.schedules?.[holdoutId], generatedAt),
  };
}

/** Counts by borough and NTA for every reconstructed cycle (descriptive lens). */
export function buildTaxLienAreaAggregates(rows, ntaByBbl = new Map()) {
  const cycles = reconstructCycles(normalizedRows(rows));
  return cycles.map((cycle) => {
    const boroughs = Object.fromEntries(Object.entries(BOROUGH_NAMES).map(([code, name]) => [code, {
      code,
      name,
      listed_90: 0,
      sold_lien: 0,
      left_before_sale: 0,
    }]));
    const ntas = new Map();
    let ntaMatched = 0;
    for (const [bbl] of cycle.stages.notice_90) {
      const sold = cycle.stages.sold.has(bbl);
      const borough = boroughs[bbl[0]];
      borough.listed_90 += 1;
      borough[sold ? "sold_lien" : "left_before_sale"] += 1;
      const nta = ntaByBbl.get(bbl);
      if (!nta) continue;
      ntaMatched += 1;
      if (!ntas.has(nta.code)) ntas.set(nta.code, {
        code: nta.code,
        name: nta.name,
        borough: nta.borough || borough.name,
        listed_90: 0,
        sold_lien: 0,
        left_before_sale: 0,
      });
      const bucket = ntas.get(nta.code);
      bucket.listed_90 += 1;
      bucket[sold ? "sold_lien" : "left_before_sale"] += 1;
    }
    const finalize = (bucket) => ({
      ...bucket,
      sold_share: rate(bucket.sold_lien, bucket.listed_90),
      left_before_sale_share: rate(bucket.left_before_sale, bucket.listed_90),
    });
    return {
      cycle_id: cycle.cycle_id,
      program_outcome: cycle.stages.sold.size ? "final_sale_published" : "no_final_sale_publication",
      data_vintage: cycle.publications.at(-1)?.published_at || cycle.cycle_id,
      boroughs: Object.values(boroughs).map(finalize),
      ntas: [...ntas.values()].map(finalize).sort((left, right) => right.listed_90 - left.listed_90
        || left.name.localeCompare(right.name)),
      nta_coverage: {
        matched: ntaMatched,
        total: cycle.stages.notice_90.size,
        rate: rate(ntaMatched, cycle.stages.notice_90.size),
      },
    };
  });
}
