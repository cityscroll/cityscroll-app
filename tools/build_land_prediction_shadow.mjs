import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateLandPredictionPromotionGate } from "../worker/src/lib/land_prediction_shadow.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const sourcePath = resolve(root, "warehouse/receipts/proof/lup2_c7_stance_backtest_latest.json");
const modelPackPath = resolve(root, "warehouse/fixtures/land-use-prediction-v2/stance_backtest.v1.json");
const outputPath = resolve(root, "warehouse/receipts/proof/lup2_c9_shadow_latest.json");
const c7 = JSON.parse(readFileSync(sourcePath, "utf8"));
const modelPack = JSON.parse(readFileSync(modelPackPath, "utf8"));
const receipt = {
  ...evaluateLandPredictionPromotionGate({
    ...c7,
    model_pack: {
      schema: modelPack.dataset.predictor_schema,
      predictor_model_version: modelPack.dataset.predictor_model_version,
      feature_schema: modelPack.dataset.feature_schema,
      fingerprint: modelPack.dataset.fingerprint
    }
  }),
  source: "warehouse/receipts/proof/lup2_c7_stance_backtest_latest.json",
  comparison_schema: "cityscroll.land_prediction_shadow_comparison.v1",
  fixture: "test/fixtures/land_prediction_shadow/gold.v1.json",
  generated_at: "2026-08-31T00:00:00.000Z"
};
const text = `${JSON.stringify(receipt, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(outputPath, "utf8") !== text) throw new Error("LUP2-C9 receipt is stale");
} else writeFileSync(outputPath, text);
