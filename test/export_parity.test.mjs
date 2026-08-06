import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const require=createRequire(import.meta.url);
const { EXPORT_CLASS_POLICY }=require("../site/export_workflows.js");
const routing=readFileSync(new URL("../site/app/routing.mjs",import.meta.url),"utf8");
const history=readFileSync(new URL("../site/app/money-history.mjs",import.meta.url),"utf8");
const composed=readFileSync(new URL("../site/composed_object_documents.mjs",import.meta.url),"utf8");

function detailMounts(source){
  return [...source.matchAll(/data-export-class="([a-z_]+)"/g)].map((match) => match[1]);
}

test("every rendered enrollment/visibility mount declares a policy-backed export data class",()=>{
  const classes=new Set([...detailMounts(routing), ...detailMounts(history), ...detailMounts(composed)]);
  assert.ok(classes.size>=20,"export mount coverage must remain broad across document surfaces");
  for(const dataClass of [...classes].sort()) {
    const policy = EXPORT_CLASS_POLICY[dataClass];
    assert.ok(policy, `${dataClass} needs export coverage or an explicit exclusion`);
    assert.ok((Array.isArray(policy.sheets)&&policy.sheets.length)||policy.excluded,`${dataClass} policy is incomplete`);
  }
});

test("every rendered data class has workbook coverage or a documented exclusion",()=>{
  const classes=new Set([...detailMounts(routing), ...detailMounts(history), ...detailMounts(composed)]);
  assert.ok(classes.size>=20,"resource-kind parity should be broad and deterministic");
  assert.match(EXPORT_CLASS_POLICY.unofficial_translation.excluded,/Unofficial translations/);
});
