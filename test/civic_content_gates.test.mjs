// Characterization tests for the civic-content-gates suite extraction.
//
// Field cases pin the real gate behaviours that must not drift under extraction:
//   1. link_text flags a naked "click here"
//   2. control_labels separates terse actions from status/context copy
//   3. i18n_keys fails when a shipping language is missing an English key
//   4. reading_level.py accepts the card-style `--max-grade 7 about.html` path
//   5. suite runner reports per-gate VERDICT lines for before/after comparison
//   6. no_disclaimer_slop flags defensive copy while preserving honest boundaries
//
// Hermetic fixtures — never mutates site/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "civic-content-gates");
const STANDARDS = join(ROOT, "test", "standards");

function runPython(args, { cwd = ROOT, env = {} } = {}) {
  return spawnSync("python3", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: PKG + (process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ""), ...env },
  });
}

function writeMinimalI18n(dir, { en = {}, shipping = ["es"], langFiles = {} } = {}) {
  // Mirror production i18n.js: en is inline; each shipping language lives in
  // i18n/lang/<lang>.js and is require()'d from a Node-only shim at the bottom so
  // gates that load only i18n.js still see every dictionary.
  const enBody = Object.entries(en)
    .map(([k, v]) => `    ${k}: ${JSON.stringify(v)},`)
    .join("\n");
  const shippingLit = shipping.map((s) => `"${s}"`).join(", ");
  mkdirSync(join(dir, "i18n", "lang"), { recursive: true });
  for (const lang of shipping) {
    const keys = langFiles[lang] ?? en;
    const body = Object.entries(keys)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`)
      .join("\n");
    writeFileSync(
      join(dir, "i18n", "lang", `${lang}.js`),
      `(function (W) {\n` +
        `  W.STRINGS = W.STRINGS || {};\n` +
        `  W.STRINGS[${JSON.stringify(lang)}] = W.STRINGS[${JSON.stringify(lang)}] || {};\n` +
        `  Object.assign(W.STRINGS[${JSON.stringify(lang)}], {\n${body}\n  });\n` +
        `})(typeof window !== "undefined" ? window : global);\n`
    );
  }
  writeFileSync(
    join(dir, "i18n.js"),
    `const SHIPPING_LANGS = [${shippingLit}];\n` +
      `const STRINGS = {\n  en: {\n${enBody}\n  }\n};\n` +
      `(function (W) {\n` +
      `  W.STRINGS = W.STRINGS || {};\n` +
      `  W.STRINGS.en = STRINGS.en;\n` +
      `  W.SHIPPING_LANGS = SHIPPING_LANGS;\n` +
      `})(typeof window !== "undefined" ? window : global);\n` +
      `if (typeof module !== "undefined" && module.exports !== undefined && typeof require === "function") {\n` +
      `  const path = require("path");\n` +
      `  SHIPPING_LANGS.forEach(function (lang) {\n` +
      `    require(path.join(__dirname, "i18n", "lang", lang + ".js"));\n` +
      `  });\n` +
      `}\n`
  );
}

test("link_text: field case — flags naked 'click here', passes descriptive text", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccg-link-"));
  try {
    writeMinimalI18n(dir, { en: { more: "Read the full notice" }, shipping: ["es"] });
    writeFileSync(
      join(dir, "about.html"),
      `<!doctype html><html><body>` +
        `<a href="/x">click here</a>` +
        `<a href="/y">Read the full notice</a>` +
        `</body></html>\n`
    );
    // Call the gate module directly (characterization of rule logic, not CLI intermix).
    // --page is also exercised so the CLI path stays covered on every runner.
    const badApi = runPython([
      "-c",
      "import sys; from pathlib import Path; " +
        "sys.path.insert(0, sys.argv[1]); " +
        "from civic_content_gates import link_text; " +
        "sys.exit(link_text.run(Path(sys.argv[2]), pages=['about.html']))",
      PKG, dir,
    ]);
    assert.notEqual(badApi.status, 0, `expected fail; stdout=${badApi.stdout} stderr=${badApi.stderr}`);
    assert.match(badApi.stderr + badApi.stdout, /click here/);

    const badCli = runPython([
      "-m", "civic_content_gates", "check", "link_text",
      "--root", dir, "--page", "about.html",
    ]);
    assert.notEqual(badCli.status, 0, `CLI expected fail; stderr=${badCli.stderr} stdout=${badCli.stdout}`);
    assert.match(badCli.stderr + badCli.stdout, /click here/);

    writeFileSync(
      join(dir, "about.html"),
      `<!doctype html><html><body><a href="/x">Read the full notice</a></body></html>\n`
    );
    const good = runPython([
      "-m", "civic_content_gates", "check", "link_text",
      "--root", dir, "--page", "about.html",
    ]);
    assert.equal(good.status, 0, `expected pass; stderr=${good.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control_labels: rejects long/status controls while allowing full accessible names", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccg-controls-"));
  try {
    writeMinimalI18n(dir, {
      en: {
        long_action: "Attend or follow the public hearing",
        status_action: "Public comment is closed",
        terse_action: "Follow hearing",
      },
      shipping: ["es"],
      langFiles: {
        es: {
          long_action: "Asistir o seguir la audiencia pública",
          status_action: "Los comentarios están cerrados",
          terse_action: "Seguir audiencia",
        },
      },
    });

    writeFileSync(
      join(dir, "index.html"),
      `<button class="act" data-i18n="long_action">Attend or follow the public hearing</button>\n`,
    );
    const long = runPython([
      "-m", "civic_content_gates", "check", "control_labels", "--root", dir,
    ]);
    assert.notEqual(long.status, 0, "five-plus visible words must fail");
    assert.match(long.stderr + long.stdout, /6 words/);

    writeFileSync(
      join(dir, "index.html"),
      `<button class="act" data-i18n="status_action">Public comment is closed</button>\n`,
    );
    const status = runPython([
      "-m", "civic_content_gates", "check", "control_labels", "--root", dir,
    ]);
    assert.notEqual(status.status, 0, "status phrasing must not masquerade as a control");
    assert.match(status.stderr + status.stdout, /status phrasing/);

    writeFileSync(
      join(dir, "index.html"),
      `<button class="act" data-i18n="terse_action" ` +
        `aria-label="Attend or follow the public hearing">Follow hearing</button>` +
        `<span role="status">Public comment is closed</span>\n`,
    );
    const good = runPython([
      "-m", "civic_content_gates", "check", "control_labels", "--root", dir,
    ]);
    assert.equal(good.status, 0, `terse visible action plus separate status should pass: ${good.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control_labels: filter chips use pressed state instead of action-copy lint", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccg-filter-chips-"));
  try {
    writeMinimalI18n(dir, {
      en: { filter_value: "Open Requests for Proposals (RFPs) — accepting now" },
      shipping: ["es"],
      langFiles: { es: { filter_value: "Solicitudes de propuestas abiertas — aceptando ahora" } },
    });
    writeFileSync(
      join(dir, "index.html"),
      `<button type="button" class="ui-filter-chip" aria-pressed="true" data-i18n="filter_value">Open Requests for Proposals (RFPs) — accepting now</button>\n`,
    );
    const result = runPython([
      "-m", "civic_content_gates", "check", "control_labels", "--root", dir,
    ]);
    assert.equal(result.status, 0, `filter-chip value labels should be checked by their grammar gate: ${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("i18n_keys: field case — fails when a shipping language misses an English key", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccg-i18n-"));
  try {
    writeMinimalI18n(dir, {
      en: { hello: "Hello", world: "World" },
      shipping: ["es"],
      langFiles: { es: { hello: "Hola" } }, // missing world
    });
    const bad = runPython([
      "-c",
      "import sys; from pathlib import Path; " +
        "sys.path.insert(0, sys.argv[1]); " +
        "from civic_content_gates import i18n_keys; " +
        "sys.exit(i18n_keys.run(Path(sys.argv[2])))",
      PKG, dir,
    ]);
    assert.notEqual(bad.status, 0, `expected fail; stderr=${bad.stderr}`);
    assert.match(bad.stderr + bad.stdout, /world/);

    writeMinimalI18n(dir, {
      en: { hello: "Hello", world: "World" },
      shipping: ["es"],
      langFiles: { es: { hello: "Hola", world: "Mundo" } },
    });
    const good = runPython([
      "-c",
      "import sys; from pathlib import Path; " +
        "sys.path.insert(0, sys.argv[1]); " +
        "from civic_content_gates import i18n_keys; " +
        "sys.exit(i18n_keys.run(Path(sys.argv[2])))",
      PKG, dir,
    ]);
    assert.equal(good.status, 0, `expected pass; stderr=${good.stderr} stdout=${good.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reading_level.py: card-style path --max-grade 7 about.html is accepted", () => {
  // Only checks CLI wiring + exit-code surface; skips if readable-or-else is absent.
  const probe = spawnSync("readable-or-else", ["--help"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    // Soft-skip: the consolidated path still has to parse args without crashing.
    const help = runPython([join(STANDARDS, "reading_level.py"), "--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /max-grade/);
    return;
  }

  // Grade-1 prose must pass --max-grade 7; nonsense dense jargon should fail a low ceiling.
  const dir = mkdtempSync(join(tmpdir(), "ccg-rl-"));
  try {
    const easy =
      "<!doctype html><html><body><main><p>" +
      "The city posts notices every day. You can read them here. " +
      "Search for a street. Get an email when something new shows up." +
      "</p></main></body></html>";
    writeFileSync(join(dir, "about.html"), easy);
    const easyRun = runPython([
      join(STANDARDS, "reading_level.py"),
      "--root", dir,
      "--max-grade", "7",
      "about.html",
    ]);
    assert.equal(easyRun.status, 0, `easy prose should pass; out=${easyRun.stdout} err=${easyRun.stderr}`);

    const hard =
      "<!doctype html><html><body><main><p>" +
      "Notwithstanding the aforementioned multiparty intergovernmental interagency " +
      "procurement solicitation prequalification methodologies, subsequent contractual " +
      "indemnification stipulations necessitate comprehensive jurisprudential reconsideration " +
      "prior to any discretionary administrative adjudication whatsoever regarding the same." +
      "</p></main></body></html>";
    writeFileSync(join(dir, "about.html"), hard);
    const hardRun = runPython([
      join(STANDARDS, "reading_level.py"),
      "--root", dir,
      "--max-grade", "7",
      "about.html",
    ]);
    assert.notEqual(hardRun.status, 0, `hard prose should fail grade 7; out=${hardRun.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("suite runner: machine VERDICT lines cover every default member (minus reading_level when skipped)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccg-suite-"));
  try {
    // Minimal site that passes the non-reading-level members when pages are limited.
    writeMinimalI18n(dir, {
      en: {
        about_h_content: "About our content",
        about_p_content_html: "Site copy is drafted with Claude and reviewed by a human.",
      },
      shipping: ["es"],
      langFiles: {
        es: {
          about_h_content: "Sobre nuestro contenido",
          about_p_content_html: "El texto del sitio se redacta con IA y lo revisa una persona.",
        },
      },
    });
    const pages = [
      "index.html", "about.html", "data.html", "stats.html",
      "api.html", "changelog.html", "standards.html",
    ];
    for (const page of pages) {
      const title =
        page === "index.html"
          ? "CityScroll · track city notices"
          : `${page.replace(".html", "")} · CityScroll`;
      // Meta descriptions must be 120-160 chars.
      const desc =
        "CityScroll turns the City Record into a searchable feed of contracts, hearings, " +
        "and land-use notices you can follow in plain language today.";
      assert.ok(desc.length >= 120 && desc.length <= 160, `desc length ${desc.length}`);
      let body = `<h1>Welcome</h1><p>Plain page copy for ${page}.</p>`;
      if (page === "about.html") {
        body +=
          `<h2 data-i18n="about_h_content">About our content</h2>` +
          `<p data-i18n-html="about_p_content_html">Site copy is drafted with Claude and reviewed by a human.</p>`;
      }
      writeFileSync(
        join(dir, page),
        `<!doctype html><html><head>` +
          `<title>${title}</title>` +
          `<meta name="description" content="${desc}">` +
          `</head><body>${body}</body></html>\n`
      );
    }
    // Empty allowlist is fine when there are no findings.
    writeFileSync(join(dir, "allowlist.txt"), "# empty\n");

    const result = runPython([
      "-m", "civic_content_gates", "run",
      "--root", dir,
      "--allowlist", join(dir, "allowlist.txt"),
      "--skip-reading-level",
      "--machine",
    ]);
    assert.equal(result.status, 0, `suite should pass fixture; out=${result.stdout}\nerr=${result.stderr}`);
    for (const name of [
      "link_text", "control_labels", "i18n_keys", "nyc_copy_lint",
      "heading_punctuation", "page_metadata", "genai_disclosure", "no_disclaimer_slop",
    ]) {
      assert.match(result.stdout, new RegExp(`VERDICT ${name} exit=0`));
    }
    assert.doesNotMatch(result.stdout, /VERDICT reading_level/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no_disclaimer_slop: warns, blocks on request, and preserves honest copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccg-disclaimer-slop-"));
  try {
    mkdirSync(join(dir, "generated"), { recursive: true });
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><body><main>` +
        `<p>This is a navigational aid, not an authoritative determination.</p>` +
        `<p>No open results in this scope.</p>` +
        `<p>Source: City Record. This published layer is evidence, not a live query.</p>` +
        `</main></body></html>\n`,
    );
    writeFileSync(
      join(dir, "i18n.js"),
      `const STRINGS = { en: { bad: "This is legal context, not a prediction." } };\n`,
    );
    writeFileSync(
      join(dir, "generated", "template.mjs"),
      `export const copy = \"This check compares claims. It does not choose a winner or merge identities.\";\n`,
    );

    const warn = runPython([
      "-m", "civic_content_gates", "check", "no_disclaimer_slop",
      "--root", dir, "--no-disclaimer-slop-mode", "warn",
    ]);
    assert.equal(warn.status, 0, `warn mode stays non-blocking: ${warn.stderr}`);
    assert.match(warn.stdout, /navigational-aid disclaimer/);
    assert.match(warn.stdout, /positive plain statement/);
    assert.match(warn.stdout, /generated\/template\.mjs/);
    assert.doesNotMatch(warn.stdout, /No open results in this scope/);
    assert.doesNotMatch(warn.stdout, /published layer is evidence/);

    const block = runPython([
      "-m", "civic_content_gates", "check", "no_disclaimer_slop",
      "--root", dir, "--no-disclaimer-slop-mode", "block",
    ]);
    assert.notEqual(block.status, 0, "block mode rejects unreviewed findings");

    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><body><main>` +
        `<!-- no-disclaimer-slop: ignore — reviewed source boundary -->` +
        `<p>This is a guide, not a verdict.</p>` +
        `</main></body></html>\n`,
    );
    writeFileSync(
      join(dir, "i18n.js"),
      `const STRINGS = { en: { bad: \"This is legal context, not a prediction.\" // no-disclaimer-slop: ignore — legal wording\n } };\n`,
    );
    writeFileSync(join(dir, "generated", "template.mjs"), "export const copy = \"Plain guide text.\";\n");
    const ignored = runPython([
      "-m", "civic_content_gates", "check", "no_disclaimer_slop",
      "--root", dir, "--no-disclaimer-slop-mode", "block",
    ]);
    assert.equal(ignored.status, 0, `reviewed inline exceptions should pass: ${ignored.stderr}`);

    writeFileSync(join(dir, "index.html"), "<p>This is a guide, not a verdict.</p>\n");
    const allowlist = join(dir, "allowlist.txt");
    writeFileSync(allowlist, "defensive_hedge_shape\tThis is a guide, not a verdict.\n");
    const listed = runPython([
      "-m", "civic_content_gates", "check", "no_disclaimer_slop",
      "--root", dir,
      "--no-disclaimer-slop-mode", "block",
      "--no-disclaimer-slop-allowlist", allowlist,
    ]);
    assert.equal(listed.status, 0, `reviewed file exceptions should pass: ${listed.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("house wrappers: test/standards paths still invoke the package (live site, no verdict drift)", () => {
  // Live-site smoke: each extracted wrapper must exit 0 against the real site, matching
  // the pre-extraction green baseline committed under docs/evidence/civic-content-gates/.
  const gates = [
    ["link_text.py"],
    ["control_labels.py"],
    ["i18n_keys.py"],
    ["heading_punctuation.py"],
    ["page_metadata.py"],
    ["genai_disclosure.py"],
    ["nyc_copy_lint.py", "--gate"],
  ];
  for (const [script, ...args] of gates) {
    const r = runPython([join(STANDARDS, script), ...args]);
    assert.equal(r.status, 0, `${script} should pass live site; stderr=${r.stderr}\nstdout=${r.stdout}`);
  }
});
