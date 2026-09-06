import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const GUARD = new URL("../tools/check_stale_repo_name.mjs", import.meta.url);
const ALLOWLIST = new URL("../.github/legacy-name-allowlist.txt", import.meta.url);
const PROBE = new URL("../.legacy-name-guard-probe.txt", import.meta.url);
const legacyName = ["crol", "-", "list"].join("");
const reservedMarker = ["card-seal", "5rk8-qj2m-xv91"].join(":");

function runGuard(env) {
  return execFileSync(process.execPath, [GUARD.pathname], { cwd: ROOT, encoding: "utf8", stdio: "pipe", env: { ...process.env, ...env } });
}

function headSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT_PATH, encoding: "utf8" }).trim();
}

function mainMergeBaseSha() {
  return execFileSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: ROOT_PATH, encoding: "utf8" }).trim();
}

function withAllowlist(mutate, fn) {
  const original = readFileSync(ALLOWLIST, "utf8");
  writeFileSync(ALLOWLIST, mutate(original));
  try {
    return fn();
  } finally {
    writeFileSync(ALLOWLIST, original);
  }
}

test("the checked-in compatibility inventory is accepted", () => {
  assert.match(runGuard(), /guard passed/i);
});

test("the classification manifest preserves canonical register identifiers", () => {
  const output = runGuard({ LEGACY_ALLOWLIST_BASE_SHA: mainMergeBaseSha() });
  assert.match(output, /guard passed/i);
  assert.doesNotMatch(output, /covers content that does not exist/);
});

test("a novel unallowlisted reference fails the guard", () => {
  writeFileSync(PROBE, `new ${legacyName} reference\n`);
  try {
    assert.throws(() => runGuard(), new RegExp(`legacy-name-guard-probe.*${legacyName}`));
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

test("a novel legacy-name reference fails the guard", () => {
  writeFileSync(PROBE, `new ${legacyName} reference\n`);
  try {
    assert.throws(() => runGuard(), new RegExp(`legacy-name-guard-probe.*${legacyName}`, "i"));
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

test("the reserved content marker always fails the guard", () => {
  writeFileSync(PROBE, `reserved ${reservedMarker}\n`);
  try {
    assert.throws(() => runGuard(), new RegExp(`legacy-name-guard-probe.*${reservedMarker}`));
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

test("allowlist rewrite refuses a novel occurrence", () => {
  writeFileSync(PROBE, `new ${legacyName} reference\n`);
  try {
    assert.throws(
      () => execFileSync(process.execPath, [GUARD.pathname, "--write"], { cwd: ROOT, encoding: "utf8", stdio: "pipe" }),
      new RegExp(`legacy-name-guard-probe.*${legacyName}`),
    );
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

// --- Allowlist growth guard: an entry may only cover content already present
// at the merge-base of main (PR 1417 added banned lines and the allowlist
// entries covering them in the same change; the guard passed it). ---

test("a same-PR allowlist entry covering a same-PR new line fails the guard", () => {
  writeFileSync(PROBE, `new ${legacyName} reference\n`);
  const probeName = ".legacy-name-guard-probe.txt";
  const digest = Buffer.from(`new ${legacyName} reference`, "utf8").toString("base64");
  try {
    withAllowlist(
      (original) => `${original}${probeName}\t${digest}\t# test: same-PR cover attempt.\n`,
      () => {
        assert.throws(
          () => runGuard({ LEGACY_ALLOWLIST_BASE_SHA: headSha() }),
          /covers content that does not exist at the merge-base of main/,
        );
      },
    );
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

test("a 'future:' entry covering a same-PR new line still fails the guard", () => {
  writeFileSync(PROBE, `new ${legacyName} reference\n`);
  const probeName = ".legacy-name-guard-probe.txt";
  const digest = Buffer.from(`new ${legacyName} reference`, "utf8").toString("base64");
  try {
    withAllowlist(
      (original) => `${original}future:${probeName}\t${digest}\t# test: future-prefixed same-PR cover attempt.\n`,
      () => {
        assert.throws(
          () => runGuard({ LEGACY_ALLOWLIST_BASE_SHA: headSha() }),
          /covers content that does not exist at the merge-base of main/,
        );
      },
    );
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

test("an allowlist entry covering a pre-existing line passes and prints a growth summary", () => {
  const targetPath = "README.md";
  const existingLine = readFileSync(new URL(`../${targetPath}`, import.meta.url), "utf8").split(/\r?\n/)[0];
  const digest = Buffer.from(existingLine, "utf8").toString("base64");
  withAllowlist(
    (original) => `${original}future:${targetPath}\t${digest}\t# test: pre-existing line, legitimate legacy exception.\n`,
    () => {
      const output = runGuard({ LEGACY_ALLOWLIST_BASE_SHA: headSha() });
      assert.match(output, /guard passed/i);
      assert.match(output, /ALLOWLIST GROWTH: 1 new entry added, covering 1 file/);
      assert.match(output, new RegExp(`\\+ ${targetPath}  `));
    },
  );
});

test("a same-PR wildcard entry covering a modified pre-existing file fails the guard", () => {
  const targetPath = "README.md";
  const targetUrl = new URL(`../${targetPath}`, import.meta.url);
  const original = readFileSync(targetUrl, "utf8");
  writeFileSync(targetUrl, `${original}new ${legacyName} reference\n`);
  try {
    withAllowlist(
      (allowlist) => `${allowlist}${targetPath}\t*\t# test: same-PR wildcard cover attempt.\n`,
      () => {
        assert.throws(
          () => runGuard({ LEGACY_ALLOWLIST_BASE_SHA: headSha() }),
          /covers content that does not exist at the merge-base of main/,
        );
      },
    );
  } finally {
    writeFileSync(targetUrl, original);
  }
});

test("a wildcard entry covering an untouched pre-existing file passes the growth guard", () => {
  const targetPath = "README.md";
  withAllowlist(
    (original) => `${original}future:${targetPath}\t*\t# test: untouched pre-existing file, whole-file exemption.\n`,
    () => {
      const output = runGuard({ LEGACY_ALLOWLIST_BASE_SHA: headSha() });
      assert.match(output, /guard passed/i);
      assert.match(output, /ALLOWLIST GROWTH: 1 new entry added, covering 1 file/);
    },
  );
});

test("a PR that does not touch the allowlist is unaffected by the growth guard", () => {
  const output = runGuard({ LEGACY_ALLOWLIST_BASE_SHA: headSha() });
  assert.match(output, /guard passed/i);
  assert.doesNotMatch(output, /ALLOWLIST GROWTH/);
});

test("growth guard fails closed when the merge-base cannot be resolved", () => {
  const targetPath = "README.md";
  const existingLine = readFileSync(new URL(`../${targetPath}`, import.meta.url), "utf8").split(/\r?\n/)[0];
  const digest = Buffer.from(existingLine, "utf8").toString("base64");
  withAllowlist(
    (original) => `${original}future:${targetPath}\t${digest}\t# test: unresolved base.\n`,
    () => {
      assert.throws(
        () => runGuard({ LEGACY_ALLOWLIST_BASE_SHA: "0000000000000000000000000000000000000000" }),
        /unable to resolve a merge-base/,
      );
    },
  );
});

test("an old-format pin matches by content even when its recorded line number is stale", () => {
  const probeName = ".legacy-name-guard-probe.txt";
  const line = `kept ${legacyName} reference`;
  const digest = Buffer.from(line, "utf8").toString("base64");
  writeFileSync(PROBE, `unrelated insertion\n${line}\n`);
  try {
    withAllowlist(
      (original) => `${original}${probeName}\t1\t${digest}\t# test: stale line number in old format.\n`,
      () => {
        assert.match(runGuard(), /guard passed/i);
      },
    );
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

test("an unrelated insertion above a pinned line does not require an allowlist edit", () => {
  const probeName = ".legacy-name-guard-probe.txt";
  const line = `kept ${legacyName} reference`;
  const digest = Buffer.from(line, "utf8").toString("base64");
  writeFileSync(PROBE, `${line}\n`);
  try {
    withAllowlist(
      (original) => `${original}${probeName}\t${digest}\t# test: content-addressed pin.\n`,
      () => {
        writeFileSync(PROBE, `unrelated insertion\n${line}\n`);
        assert.match(runGuard(), /guard passed/i);
      },
    );
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

test("an added unpinned copy of a pinned line fails the guard", () => {
  const probeName = ".legacy-name-guard-probe.txt";
  const line = `kept ${legacyName} reference`;
  const digest = Buffer.from(line, "utf8").toString("base64");
  writeFileSync(PROBE, `${line}\n${line}\n`);
  try {
    withAllowlist(
      (original) => `${original}${probeName}\t${digest}\t# test: single-occurrence pin.\n`,
      () => {
        assert.throws(() => runGuard(), new RegExp(`legacy-name-guard-probe.*${legacyName}`));
      },
    );
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

test("a declared count covers repeated identical lines and rejects an extra copy", () => {
  const probeName = ".legacy-name-guard-probe.txt";
  const line = `kept ${legacyName} reference`;
  const digest = Buffer.from(line, "utf8").toString("base64");
  writeFileSync(PROBE, `${line}\n${line}\n`);
  try {
    withAllowlist(
      (original) => `${original}${probeName}\t${digest}\tcount=2\t# test: two-occurrence pin.\n`,
      () => {
        assert.match(runGuard(), /guard passed/i);
        writeFileSync(PROBE, `${line}\n${line}\n${line}\n`);
        assert.throws(() => runGuard(), new RegExp(`legacy-name-guard-probe.*${legacyName}`));
      },
    );
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

test("removing a pinned occurrence is reported as stale", () => {
  const probeName = ".legacy-name-guard-probe.txt";
  const line = `kept ${legacyName} reference`;
  const digest = Buffer.from(line, "utf8").toString("base64");
  writeFileSync(PROBE, `${line}\n`);
  try {
    withAllowlist(
      (original) => `${original}${probeName}\t${digest}\t# test: pin that will go missing.\n`,
      () => {
        unlinkSync(PROBE);
        assert.throws(() => runGuard(), /stale entries/);
      },
    );
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

test("duplicate content pins for one file must declare a single count", () => {
  const probeName = ".legacy-name-guard-probe.txt";
  const line = `kept ${legacyName} reference`;
  const digest = Buffer.from(line, "utf8").toString("base64");
  writeFileSync(PROBE, `${line}\n${line}\n`);
  try {
    withAllowlist(
      (original) => `${original}${probeName}\t${digest}\t# test: first pin.\n${probeName}\t${digest}\t# test: duplicate pin.\n`,
      () => {
        assert.throws(() => runGuard(), /duplicate content pin/);
      },
    );
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});
