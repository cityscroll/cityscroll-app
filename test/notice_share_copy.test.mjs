import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { noticeDocumentPath, noticeDocumentUrl } from "../site/notice_permalink.mjs";
import { renderedCopyDefects } from "../site/rendered_copy_lint.mjs";
import { buildMemberBlurb } from "../site/rules_member_blurb.mjs";

test("rendered-copy lint detects immediate repetition and slot suffix collisions", () => {
  const defects = renderedCopyDefects("It is listed as a notice notice.", {
    slots: [{ name: "type", value: "notice", suffix: "notice" }],
  });
  assert.deepEqual(
    defects.map((defect) => defect.code),
    ["immediate-word-repetition", "slot-suffix-tautology"],
  );
});

test("member blurb omits generic classification and safely phrases notice-ending types", () => {
  const generic = buildMemberBlurb({
    request_id: "generic-1",
    agency_name: "Example Agency",
    short_title: "Annual regulatory agenda",
    type_of_notice_description: "Notice",
  });
  const specific = buildMemberBlurb({
    request_id: "specific-1",
    agency_name: "Example Agency",
    short_title: "Public information update",
    type_of_notice_description: "Public Notice",
  });

  assert.ok(generic?.text && specific?.text);
  assert.doesNotMatch(generic.text, /listed as|It is (?:a|an) notice\b/i);
  assert.match(specific.text, /It is a public notice\./i);
  assert.deepEqual(renderedCopyDefects(generic.text), []);
  assert.deepEqual(renderedCopyDefects(specific.text), []);
});

test("notice share generators emit canonical document permalinks", () => {
  assert.equal(noticeDocumentPath("20251015011"), "/notices/20251015011");
  assert.equal(
    noticeDocumentUrl("20251015011", "https://cityscroll.org/legacy/path"),
    "https://cityscroll.org/notices/20251015011",
  );

  const blurb = buildMemberBlurb({
    request_id: "20251015011",
    agency_name: "Consumer and Worker Protection",
    short_title: "NOA Immigration Assistance Provider Penalty Schedule",
    type_of_notice_description: "Notice",
  }, { stage: "adopted" });
  assert.equal(blurb?.fields.notice_url, "https://cityscroll.org/notices/20251015011");
  assert.doesNotMatch(blurb?.text || "", /#notice\//);

  const shareExpression = /copyText|clipboard\.writeText|permalinkFor|noticeUrl|noticeLink|navigator\.share/;
  const roots = ["../site", "../worker/src"].map((relative) =>
    fileURLToPath(new URL(relative, import.meta.url))
  );
  for (const file of roots.flatMap(sourceFiles)) {
    const source = readFileSync(file, "utf8");
    const stale = source.split("\n").filter((line) => shareExpression.test(line) && /#notice\//.test(line));
    assert.deepEqual(stale, [], `${file} must not mint legacy notice URLs from share expressions`);
  }
});

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:mjs|js)$/.test(entry.name) ? [path] : [];
  });
}
