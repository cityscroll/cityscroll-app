import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROOT } from "./lib/wave4-build.mjs";

const config = readFileSync(`${ROOT}/worker/wrangler.toml`, "utf8");
const source = readFileSync(`${ROOT}/worker/src/source_vault.mjs`, "utf8");
assert.match(config, /\[\[r2_buckets\]\]\s+binding = "SOURCE_VAULT"/);
assert.match(config, /SOURCE_VAULT_ENABLED = "false"/);
assert.match(source, /state: "quarantined"/);
assert.match(source, /state: "approved"/);
assert.match(source, /credentials_not_accepted/);
assert.match(source, /sha256: hash/);
assert.match(source, /rights_or_access_uncertain/);
assert.doesNotMatch(source, /accessKeyId|secretAccessKey|presigned/i);
console.log("R2 source-vault binding is isolated behind its kill switch and manifest quarantine");
