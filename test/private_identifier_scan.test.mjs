import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isolatedGitEnv } from "../tools/architecture_evidence_shards.mjs";
import {
  buildReceipt,
  loadTermSet,
  NORMALIZATION_RULES,
  NORMALIZATION_VERSION,
  normalizedViews,
  scanPrivateIdentifiers,
} from "../tools/private_identifier_scan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = join(ROOT, "tools/private_identifier_scan.mjs");

/**
 * An obviously synthetic sentinel. Every negative test below proves the gate on
 * this word, so the committed tree never has to carry a real private identifier
 * in order to demonstrate that detection works.
 */
const SENTINEL = "zzqxsentinel";

function detectedRule(text, term = SENTINEL) {
  const view = normalizedViews(text).find((row) => row.text.includes(term));
  return view ? view.rule : null;
}

function withScratch(fn) {
  const directory = mkdtempSync(join(tmpdir(), "private-identifier-scan-"));
  try {
    return fn(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Run git against the scratch fixture only.
 *
 * A Git hook exports GIT_DIR, GIT_WORK_TREE, and GIT_INDEX_FILE. Without
 * clearing them, `-C directory` changes directory while git still resolves
 * against the host repository, so a fixture commit would land in the repository
 * running the test. Every git call here is isolated for that reason.
 */
function scratchGit(directory, args) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", env: isolatedGitEnv() });
}

function commitScratch(directory, message) {
  scratchGit(directory, ["add", "-A"]);
  scratchGit(directory, ["commit", "-qm", message]);
}

function scratchRepo(directory, files) {
  execFileSync("git", ["init", "-q", directory], { env: isolatedGitEnv() });
  scratchGit(directory, ["config", "user.email", "test@example.invalid"]);
  scratchGit(directory, ["config", "user.name", "test"]);
  for (const [path, contents] of Object.entries(files)) {
    const filePath = join(directory, path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }
  commitScratch(directory, "fixture");
  return directory;
}

test("the normalization contract is versioned and enumerated", () => {
  assert.equal(NORMALIZATION_VERSION, "private-identifier-normalization.v1");
  for (const rule of ["literal", "json-unicode-escape", "percent-encoding", "base64-run"]) {
    assert.ok(NORMALIZATION_RULES.includes(rule), rule);
  }
});

test("a raw sentinel is detected", () => {
  assert.equal(detectedRule(`a ${SENTINEL} reference`), "literal");
});

test("a case-varied sentinel is detected", () => {
  assert.equal(detectedRule(`A ${SENTINEL.toUpperCase()} REFERENCE`), "literal");
  assert.ok(detectedRule(`Zzqx${SENTINEL.slice(4)}`));
});

test("a JSON unicode-escaped sentinel is detected", () => {
  const escaped = `\\u007a${SENTINEL.slice(1)}`;
  assert.equal(detectedRule(`"id": "${escaped}"`), "json-unicode-escape");
});

test("a braced unicode-escaped sentinel is detected", () => {
  const escaped = `\\u{7a}${SENTINEL.slice(1)}`;
  assert.equal(detectedRule(escaped), "braced-unicode-escape");
});

test("a hexadecimal-escaped sentinel is detected", () => {
  assert.equal(detectedRule(`\\x7a${SENTINEL.slice(1)}`), "hex-escape");
});

test("a percent-encoded sentinel is detected", () => {
  assert.equal(detectedRule(`%7A${SENTINEL.slice(1)}`), "percent-encoding");
});

test("a decimal HTML-entity sentinel is detected", () => {
  assert.equal(detectedRule(`&#122;${SENTINEL.slice(1)}`), "html-entity-decimal");
});

test("a hexadecimal HTML-entity sentinel is detected", () => {
  assert.equal(detectedRule(`&#x7a;${SENTINEL.slice(1)}`), "html-entity-hex");
});

test("a Unicode-normalized lookalike sentinel is detected", () => {
  // Fullwidth latin letters fold onto ASCII under NFKC.
  const fullwidth = [...SENTINEL].map((char) => String.fromCodePoint(char.codePointAt(0) - 0x61 + 0xff41)).join("");
  assert.notEqual(fullwidth, SENTINEL);
  assert.ok(detectedRule(fullwidth));
});

test("a base64-encoded sentinel is detected", () => {
  const encoded = Buffer.from(`a ${SENTINEL} reference`, "utf8").toString("base64");
  assert.equal(detectedRule(encoded), "base64-run");
});

test("a character-code sequence sentinel is detected", () => {
  const codes = [...SENTINEL].map((char) => char.codePointAt(0)).join(", ");
  assert.equal(detectedRule(`String.fromCharCode(${codes})`), "char-code-sequence");
});

test("a joined-fragment sentinel is detected", () => {
  const head = SENTINEL.slice(0, 4);
  const tail = SENTINEL.slice(4);
  assert.equal(detectedRule(`["${head}", "${tail}"].join("")`), "quoted-fragment-join");
  assert.equal(detectedRule(`const value = "${head}" + "${tail}";`), "quoted-fragment-join");
});

test("a layered encoding is detected when no single rule undoes it", () => {
  const layered = `%5Cu007a${SENTINEL.slice(1)}`;
  assert.ok(detectedRule(layered), "percent-then-unicode escape should resolve");
});

test("unrelated text does not match", () => {
  assert.equal(detectedRule("an ordinary line of documentation prose"), null);
  assert.equal(detectedRule(Buffer.from("unrelated content here").toString("base64")), null);
});

test("a matching path and a matching content line are both reported", () => {
  withScratch((directory) => {
    scratchRepo(directory, {
      [`docs/${SENTINEL}-notes.md`]: "ordinary prose\n",
      "docs/clean.md": `a ${SENTINEL} mention on line one\n`,
    });
    const result = scanPrivateIdentifiers({ root: directory, terms: [SENTINEL] });
    assert.equal(result.status, "FAIL");
    const surfaces = new Set(result.findings.map((row) => row.surface));
    assert.ok(surfaces.has("path"));
    assert.ok(surfaces.has("content"));
  });
});

test("a symlink target is scanned", () => {
  withScratch((directory) => {
    scratchRepo(directory, { "docs/clean.md": "ordinary prose\n" });
    symlinkSync(`../${SENTINEL}-target`, join(directory, "docs/link"));
    commitScratch(directory, "link");
    const result = scanPrivateIdentifiers({ root: directory, terms: [SENTINEL] });
    assert.equal(result.status, "FAIL");
    assert.ok(result.findings.some((row) => row.surface === "symlink-target"));
  });
});

test("a file with no familiar extension is scanned", () => {
  withScratch((directory) => {
    scratchRepo(directory, { "Makefile.local": `# a ${SENTINEL} mention\n`, "docs/clean.md": "prose\n" });
    const result = scanPrivateIdentifiers({ root: directory, terms: [SENTINEL] });
    assert.equal(result.status, "FAIL");
    assert.ok(result.findings.some((row) => row.path === "Makefile.local"));
  });
});

test("a scan reads the tree it was given even when git environment bindings are set", () => {
  withScratch((directory) => {
    scratchRepo(directory, { "docs/clean.md": `a ${SENTINEL} mention\n` });
    // A Git hook exports these. If the scanner honoured them it would enumerate
    // the host repository instead of the tree it was asked about, which is both a
    // wrong answer and, for anything that writes, a way to corrupt the host.
    const saved = { ...process.env };
    process.env.GIT_DIR = join(ROOT, ".git");
    process.env.GIT_WORK_TREE = ROOT;
    try {
      const result = scanPrivateIdentifiers({ root: directory, terms: [SENTINEL] });
      assert.equal(result.scanned_path_count, 1);
      assert.deepEqual(result.findings.map((row) => row.path), ["docs/clean.md"]);
    } finally {
      for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

test("a finding never echoes the term, the matched text, or a matching path", () => {
  withScratch((directory) => {
    scratchRepo(directory, {
      [`docs/${SENTINEL}-notes.md`]: `a ${SENTINEL} mention\n`,
    });
    const result = scanPrivateIdentifiers({ root: directory, terms: [SENTINEL] });
    const serialized = JSON.stringify(result.findings);
    assert.ok(!serialized.includes(SENTINEL), "public findings must not carry the term");
    assert.match(serialized, /redacted-path-1/);
    // The private inventory is the only place the detail survives.
    assert.ok(JSON.stringify(result.inventory).includes(SENTINEL));
  });
});

test("private mode fails closed when no term set is supplied", () => {
  const receipt = buildReceipt({
    mode: "private",
    revision: null,
    terms: [],
    result: { status: "PASS", findings: [], scanned_path_count: 0 },
    termError: null,
  });
  assert.equal(receipt.status, "FAIL");
  assert.match(receipt.reason, /requires an owner-supplied/i);
});

test("public mode reports SKIPPED rather than a pass when no term set is supplied", () => {
  const receipt = buildReceipt({
    mode: "public",
    revision: null,
    terms: [],
    result: { status: "PASS", findings: [], scanned_path_count: 0 },
    termError: null,
  });
  assert.equal(receipt.status, "SKIPPED");
  assert.equal(receipt.private_terms_supplied, false);
  assert.equal(receipt.credential_free, true);
});

test("an unreadable term set file is an error, not an empty term set", () => {
  const loaded = loadTermSet({ termsFile: join(tmpdir(), "no-such-private-identifier-terms"), env: {} });
  assert.equal(loaded.terms.length, 0);
  assert.match(loaded.error, /not readable/);
});

test("a term set file is read, trimmed, and comment-stripped", () => {
  withScratch((directory) => {
    const file = join(directory, "terms.txt");
    writeFileSync(file, `# a comment\n  ${SENTINEL.toUpperCase()}  \n\n`);
    const loaded = loadTermSet({ termsFile: file, env: {} });
    assert.deepEqual(loaded.terms, [SENTINEL]);
  });
});

test("the committed scanner contains no real private identifier, only the contract", () => {
  const source = readFileSync(SCANNER, "utf8");
  // The term set arrives at run time. Nothing term-specific may be committed.
  assert.ok(!/const\s+(?:TERMS|PRIVATE_TERMS|DENYLIST)\s*=\s*\[[^\]]*["'][a-z]/i.test(source));
  assert.match(source, /owner-controlled/);
});

test("the command-line entry point refuses to write its inventory into the repository", () => {
  withScratch((directory) => {
    const termsFile = join(directory, "terms.txt");
    writeFileSync(termsFile, `${SENTINEL}\n`);
    let stderr = "";
    let status = 0;
    try {
      execFileSync(process.execPath, [
        SCANNER,
        "--private",
        "--terms-file",
        termsFile,
        "--private-inventory",
        join(ROOT, "private-identifier-inventory.json"),
      ], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      stderr = error.stderr || "";
      status = error.status;
    }
    assert.equal(status, 2);
    assert.match(stderr, /refusing to write the private inventory inside the public repository/);
    assert.equal(existsSync(join(ROOT, "private-identifier-inventory.json")), false);
  });
});
