import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { lookupBblCentroid } from "../site/bbl_mappluto_centroids.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const landSrc = readFileSync(new URL("../site/app/land.mjs", import.meta.url), "utf8");

function extractFunction(source, name){
  let start = source.indexOf(`async function ${name}(`);
  if(start === -1){
    start = source.indexOf(`function ${name}(`);
    if(start === -1) throw new Error(`function ${name} not found`);
  }
  let cursor = source.indexOf("(", start);
  if(cursor === -1) throw new Error(`could not parse ${name}`);
  let parenDepth = 0;
  let mode = "code";
  let quote = "";
  let escaped = false;
  let templateExprDepth = 0;
  for(; cursor < source.length; cursor += 1){
    const ch = source[cursor];
    const prev = source[cursor - 1];

    if(mode === "lineComment"){
      if(ch === "\n") mode = "code";
      continue;
    }
    if(mode === "blockComment"){
      if(prev === "*" && ch === "/") mode = "code";
      continue;
    }
    if(mode === "string"){
      if(escaped){
        escaped = false;
        continue;
      }
      if(ch === "\\"){
        escaped = true;
        continue;
      }
      if(ch === quote) mode = "code";
      continue;
    }
    if(mode === "template"){
      if(escaped){
        escaped = false;
        continue;
      }
      if(ch === "\\"){
        escaped = true;
        continue;
      }
      if(ch === "`" && templateExprDepth === 0){
        mode = "code";
      }else if(ch === "{" && prev === "$"){
        templateExprDepth += 1;
      }else if(ch === "}" && templateExprDepth > 0){
        templateExprDepth -= 1;
      }
      continue;
    }

    if(ch === "/" && source[cursor + 1] === "/"){
      mode = "lineComment";
      cursor += 1;
      continue;
    }
    if(ch === "/" && source[cursor + 1] === "*"){
      mode = "blockComment";
      cursor += 1;
      continue;
    }
    if(ch === "\"" || ch === "'" || ch === "`"){
      mode = ch === "`" ? "template" : "string";
      quote = ch;
      continue;
    }
    if(ch === "(") parenDepth += 1;
    if(ch === ")"){
      parenDepth -= 1;
      if(parenDepth === 0) break;
    }
  }
  let i = source.indexOf("{", cursor);
  if(i === -1) throw new Error(`could not parse ${name}`);
  let depth = 0;
  mode = "code";
  quote = "";
  escaped = false;
  templateExprDepth = 0;
  for(; i < source.length; i += 1){
    const ch = source[i];
    const prev = source[i - 1];

    if(mode === "lineComment"){
      if(ch === "\n"){ mode = "code"; }
      continue;
    }
    if(mode === "blockComment"){
      if(prev === "*" && ch === "/"){ mode = "code"; }
      continue;
    }
    if(mode === "string"){
      if(escaped){
        escaped = false;
        continue;
      }
      if(ch === "\\"){
        escaped = true;
        continue;
      }
      if(ch === quote){ mode = "code"; quote = ""; }
      if(ch === "\n" && quote !== "`"){ mode = "code"; quote = ""; }
      continue;
    }
    if(mode === "template"){
      if(escaped){
        escaped = false;
        continue;
      }
      if(ch === "\\"){
        escaped = true;
        continue;
      }
      if(ch === "`" && templateExprDepth === 0){
        mode = "code";
      }else if(ch === "{" && prev === "$"){
        templateExprDepth += 1;
      }else if(ch === "}" && templateExprDepth > 0){
        templateExprDepth -= 1;
      }
      continue;
    }

    if(ch === "/" && source[i + 1] === "/"){
      mode = "lineComment";
      i += 1;
      continue;
    }
    if(ch === "/" && source[i + 1] === "*"){
      mode = "blockComment";
      i += 1;
      continue;
    }
    if(ch === "'" || ch === "\"" || ch === "`"){
      mode = ch === "`" ? "template" : "string";
      quote = ch;
      continue;
    }
    if(ch === "{"){
      depth += 1;
      continue;
    }
    if(ch === "}"){
      depth -= 1;
      if(depth === 0){
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`could not extract ${name}`);
}
const cleanText = (value) => String(value ?? "").replace(/\s+/g," ").trim();

const {
  toFiniteCoordinates,
  toFinitePoint,
  normalizeLandBbl,
  collectProjectBbls,
  collectAddressCandidates,
  resolveLandMapLocation,
} = new Function(
  "cleanText",
  "lookupBblCentroid",
  [
    extractFunction(landSrc, "toFiniteCoordinates"),
    extractFunction(landSrc, "toFinitePoint"),
    extractFunction(landSrc, "normalizeLandBbl"),
    extractFunction(landSrc, "collectProjectBbls"),
    extractFunction(landSrc, "collectAddressCandidates"),
    extractFunction(landSrc, "resolveLandMapLocation"),
    "return {toFinitePoint, normalizeLandBbl, collectProjectBbls, collectAddressCandidates, resolveLandMapLocation};",
  ].join("\n")
)(
  cleanText,
  lookupBblCentroid
);

test("exact location preference uses authoritative point from project/outcome", async()=>{
  const record = {project_name:"1550 Bedford Avenue Rezoning", latitude:40.7101, longitude:-73.96};
  const result = await resolveLandMapLocation(record, null, {});
  assert.equal(result.status, "exact");
  assert.equal(result.precision, "exact");
  assert.equal(result.lat, 40.7101);
  assert.equal(result.lon, -73.96);
});

test("BBL-derived location resolves exact from property address", async()=>{
  const record = {project_name:"Sample Rezoning", bbls:["1010101010"]};
  const propertyPayload = {
    property_rows:[{
      property_location:{
        addresses:[{bbl:"1010101010", latitude:40.73061, longitude:-73.935242, label:"301 W 1st Ave"}],
      },
    }],
  };
  const result = await resolveLandMapLocation(record, null, {propertyPayload});
  assert.equal(result.status, "exact");
  assert.equal(result.precision, "exact");
  assert.equal(result.lat, 40.73061);
  assert.equal(result.lon, -73.935242);
  assert.equal(result.label, "301 W 1st Ave");
});

test("local signal candidate path remains approximate when only street/plan-name hints exist", async()=>{
  const record = {project_name:"1550 Bedford & Dean Street Rezoning"};
  const outcome = {
    open_data:{borough:"Brooklyn"},
  };
  const geocoder = (q)=>{
    if(q.includes("1550 BEDFORD")){
      return Promise.resolve({status:"matched", lat:40.7125, lon:-73.963, label:"1550 Bedford Ave"});
    }
    if(/brooklyn/i.test(q)){
      return Promise.resolve({status:"matched", lat:40.7, lon:-73.95, label:"Brooklyn"});
    }
    return Promise.resolve({status:"no-match"});
  };
  const result = await resolveLandMapLocation(record, outcome, {geocode:geocoder});
  assert.equal(result.status, "approximate");
  assert.equal(result.precision, "approximate");
  assert.ok(Number.isFinite(result.lat));
  assert.ok(Number.isFinite(result.lon));
});

test("BBL-derived location resolves exact from geometry point when address is unavailable", async()=>{
  const record = {project_name:"Sample Rezoning", bbls:["2020202020"]};
  const propertyPayload = {
    property_rows:[{
      property_location:{
        bbl:"2020202020",
        geometry:{type:"Point", coordinates:[-73.99,40.72]},
      },
    }],
  };
  const result = await resolveLandMapLocation(record, null, {propertyPayload});
  assert.equal(result.status, "exact");
  assert.equal(result.precision, "exact");
  assert.equal(result.lat, 40.72);
  assert.equal(result.lon, -73.99);
});

test("address-only path returns approximate and does not fail hard on lookup misses", async()=>{
  const record = {project_name:"1550 Bedford Avenue Rezoning", borough:"Brooklyn"};
  const calls = [];
  const geocoder = (q)=>{
    calls.push(q);
    return Promise.resolve({
      status:q.includes("1550 Bedford") ? "matched" : "nope",
      lat:40.699,
      lon:-73.95,
      label:"1550 Bedford Ave",
    });
  };
  const result = await resolveLandMapLocation(record, null, {geocode:geocoder});
  assert.equal(result.status, "approximate");
  assert.equal(result.precision, "approximate");
  assert.equal(result.lat, 40.699);
  assert.ok(calls.length > 0);
});

test("borough-only evidence does not produce coordinate placement", async()=>{
  const record = {project_name:"Brooklyn Rezoning", borough:"Brooklyn"};
  const outcome = {
    open_data:{borough:"Brooklyn", community_district:"K09"},
  };
  const result = await resolveLandMapLocation(record, outcome, {});
  assert.equal(result.status, "unresolved");
  assert.equal(result.reason, "no-resolution");
});

test("no usable resolution returns unresolved location, borough/local coarse does not surface map placement", async()=>{
  const record = {project_name:"Blind Spot Rezoning"};
  const result = await resolveLandMapLocation(record, null, {});
  assert.equal(result.status, "unresolved");
  assert.equal(result.reason, "no-resolution");
});

test("project/address evidence extraction includes DOB filing and normalized project fallback candidates", ()=>{
  const outcome = {
    dob:{filings:[{house_no:"1550",street_name:"BEDFORD AVENUE",borough:"BROOKLYN"}]},
    open_data:{borough:"Brooklyn"},
  };
  const record = {project_name:"1550 Bedford Avenue Rezoning", borough:"Brooklyn"};
  const candidates = collectAddressCandidates(record, outcome);
  assert.ok(candidates.some((value)=>/1550 BEDFORD AVENUE/i.test(value)));
  assert.ok(candidates.some((value)=>/New York/i.test(value)));
  const deduped = new Set(candidates).size;
  assert.equal(deduped, candidates.length);
});
