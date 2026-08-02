/**
 * Build procurement lifecycle field cases for coherence scorecard + tests.
 * Pure assembly only — no node:test so the CLI can import without running tests.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleLifecycle } from "../../../src/lib/checkbook_lifecycle.mjs";
import { enrichLifecycleWithPassport } from "../../../src/lib/passport_lifecycle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const META = JSON.parse(readFileSync(join(HERE, "procurement_cases.json"), "utf8"));

/** Build the fixture lifecycles used by the scorecard + rate metrics. */
export function buildProcurementCoherenceCases() {
  const lookupOk = { pending: "ok", registered: "ok", spending: "ok" };

  const coherentSolicitation = assembleLifecycle(
    {
      request_id: "20250110001",
      agency_name: "Sanitation",
      type_of_notice_description: "Solicitation",
      start_date: "2025-01-10",
      short_title: "Collection Services",
      pin: "08250R0001001",
    },
    [{
      id: "C-1001", vendor: "ACME CORP", pin: "08250R0001001", status: "pending",
      current: 5000000, original: 5000000, received: "2025-03-15", start: "2025-03-01",
    }],
    [{
      id: "C-1001", vendor: "ACME CORP", pin: "08250R0001001", status: "registered",
      current: 5000000, original: 5000000, spent: 1500000,
      registered: "2025-04-01", start: "2025-03-01", end: "2028-03-01",
    }],
    [
      { id: "P1", contractId: "C-1001", amount: 750000, date: "2025-06-01", year: "2025" },
      { id: "P2", contractId: "C-1001", amount: 750000, date: "2025-08-20", year: "2025" },
    ],
    { lookupStatus: lookupOk },
  );

  const orphanedAward = assembleLifecycle(
    {
      request_id: "20260623008",
      agency_name: "Transportation",
      type_of_notice_description: "Award",
      start_date: "2026-06-29",
      short_title: "Bridge design",
      pin: "84124P0003001",
      vendor_name: "HNTB",
      contract_amount: "100",
    },
    [],
    [{
      id: "CT184120268807929", vendor: "HNTB", pin: "84124P0003001",
      current: 100, original: 100, spent: 0, registered: "2026-06-22", start: "2024-10-11",
    }],
    [],
    { lookupStatus: lookupOk },
  );

  const paymentExceeds = assembleLifecycle(
    {
      request_id: "20250115099",
      agency_name: "Parks",
      type_of_notice_description: "Award",
      start_date: "2025-01-15",
      short_title: "Overpaid path",
      pin: "84625R0001001",
      vendor_name: "OVER LLC",
      contract_amount: "100000",
    },
    [],
    [{
      id: "CT-OVER", vendor: "OVER LLC", pin: "84625R0001001",
      current: 100000, original: 100000, spent: 250000,
      registered: "2025-02-01", start: "2025-01-20",
    }],
    [
      { id: "PX1", contractId: "CT-OVER", amount: 150000, date: "2025-03-01", year: "2025" },
      { id: "PX2", contractId: "CT-OVER", amount: 100000, date: "2025-04-01", year: "2025" },
    ],
    {
      lookupStatus: lookupOk,
      currentSolicitation: {
        status: "ok",
        rows: [{
          request_id: "20241201001",
          agency_name: "Parks",
          type_of_notice_description: "Solicitation",
          start_date: "2024-12-01",
          short_title: "Overpaid path package",
          pin: "84625R0001001",
        }],
      },
    },
  );

  // True out-of-order on the same publication clock (not CR-pub vs registration).
  const outOfOrder = assembleLifecycle(
    {
      request_id: "20250301050",
      agency_name: "Health",
      type_of_notice_description: "Award",
      start_date: "2025-01-10",
      short_title: "Date inversion",
      pin: "81625R0002001",
      vendor_name: "DATE LLC",
      contract_amount: "50000",
    },
    [],
    [{
      id: "CT-DATE", vendor: "DATE LLC", pin: "81625R0002001",
      current: 50000, original: 50000, spent: 0,
      registered: "2025-03-01", start: "2025-02-01",
    }],
    [],
    {
      lookupStatus: lookupOk,
      // Solicitation package dated AFTER the award publication → real disorder.
      currentSolicitation: {
        status: "ok",
        rows: [{
          request_id: "20250601001",
          agency_name: "Health",
          type_of_notice_description: "Solicitation",
          start_date: "2025-06-01",
          short_title: "Date inversion package",
          pin: "81625R0002001",
        }],
      },
    },
  );

  const coherentAwardWithPackage = assembleLifecycle(
    {
      request_id: "20240723114",
      agency_name: "Housing",
      type_of_notice_description: "Award",
      start_date: "2024-07-23",
      short_title: "Housing options",
      pin: "07123E0076001",
      vendor_name: "Housing Options",
      contract_amount: "5000000",
    },
    [],
    [{
      id: "CT107120248803393", vendor: "HOUSING OPTIONS", pin: "07123E0076001",
      current: 5000000, original: 5000000, spent: 344000,
      // Registration before CR award publication — used to false-flag out_of_order.
      registered: "2024-06-15", start: "2024-06-01",
    }],
    [
      { id: "PH1", contractId: "CT107120248803393", amount: 344000, date: "2024-09-15", year: "2025" },
    ],
    {
      lookupStatus: lookupOk,
      currentSolicitation: {
        status: "ok",
        rows: [{
          request_id: "20240110001",
          agency_name: "Housing",
          type_of_notice_description: "Solicitation",
          start_date: "2024-01-10",
          short_title: "Housing options package",
          pin: "07123E0076001",
        }],
      },
    },
  );

  // Award with no CR/OCP solicitation — RFx recovers and drops orphaned_award.
  const awardRfxBase = assembleLifecycle(
    {
      request_id: "20260515020",
      agency_name: "Transportation",
      type_of_notice_description: "Award",
      start_date: "2026-05-15",
      short_title: "Signal redesign",
      pin: "84125B0005001",
      vendor_name: "IBI",
      contract_amount: "250000",
    },
    [],
    [{
      id: "CT-RFX", vendor: "IBI", pin: "84125B0005001",
      current: 250000, original: 250000, spent: 0,
      registered: "2026-04-01", start: "2026-03-01",
    }],
    [],
    { lookupStatus: lookupOk },
  );
  const awardRfxRecovery = enrichLifecycleWithPassport(awardRfxBase, {
    request_id: "20260515020",
    agency_name: "Transportation",
    type_of_notice_description: "Award",
    pin: "84125B0005001",
  }, {
    contracts: [],
    rfx: [{
      epin: "84125B0005",
      epin_norm: "84125B0005",
      procurement_name: "Signal redesign",
      agency: "Transportation",
      rfx_status: "Closed",
      release_date: "01/10/2025",
      due_date: "02/28/2025",
      rfp_id: "55555",
    }],
    lookupStatus: { contracts: "ok", rfx: "ok" },
  });

  const byId = {
    "coherent-solicitation-path": coherentSolicitation,
    "orphaned-award-no-solicitation": orphanedAward,
    "payment-exceeds-award": paymentExceeds,
    "out-of-order-solicitation-after-award": outOfOrder,
    "coherent-award-with-solicitation-package": coherentAwardWithPackage,
    "award-rfx-solicitation-recovery": awardRfxRecovery,
  };

  return META.cases.map((meta) => ({
    ...meta,
    pin: byId[meta.id]?.pin || null,
    type_of_notice_description: META.cases.find((c) => c.id === meta.id)
      ? (meta.id.includes("solicitation-path") ? "Solicitation" : "Award")
      : "Award",
    lifecycle: byId[meta.id],
  }));
}
