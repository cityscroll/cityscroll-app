import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const require=createRequire(import.meta.url);
const { EXPORT_CLASS_POLICY }=require("../site/export_workflows.js");
const routing=readFileSync(new URL("../site/app/routing.mjs",import.meta.url),"utf8");
const history=readFileSync(new URL("../site/app/money-history.mjs",import.meta.url),"utf8");

function detailMounts(source,prefix){
  return [...source.matchAll(new RegExp(`<div id="${prefix}([a-z0-9]+)"([^>]*)>`,`g`))]
    .map(match=>({id:`${prefix}${match[1]}`,attrs:match[2]}));
}

test("every rendered notice enrichment mount declares an export data class",()=>{
  const mounts=detailMounts(routing,"n").concat(detailMounts(history,"d"))
    .filter(mount=>/^(?:n|d)(?:plain|context|actions|addr|mwbe|rules|lifecycle|regdwell|suboutreach|dollars|subsidy|aboaward|commercial|disposition|propertyxd|taxlien|franchise|land|meet|external|prior|forecast|chain|xlate)$/.test(mount.id));
  assert.ok(mounts.length>=25,"the detector must walk the full notice detail surface");
  for(const mount of mounts){
    assert.match(mount.attrs,/\bdata-export-class="[a-z_]+"/,`${mount.id} must declare its rendered data class`);
  }
});

test("every rendered data class has workbook coverage or a documented exclusion",()=>{
  const classes=new Set([...routing.matchAll(/data-export-class="([a-z_]+)"/g),...history.matchAll(/data-export-class="([a-z_]+)"/g)].map(match=>match[1]));
  assert.ok(classes.size>=20,"notice parity contract should cover the joined data-class census");
  for(const dataClass of classes){
    const policy=EXPORT_CLASS_POLICY[dataClass];
    assert.ok(policy,`${dataClass} needs export coverage or an explicit exclusion`);
    assert.ok((Array.isArray(policy.sheets)&&policy.sheets.length)||policy.excluded,`${dataClass} policy is incomplete`);
  }
  assert.match(EXPORT_CLASS_POLICY.unofficial_translation.excluded,/Unofficial translations/);
});
