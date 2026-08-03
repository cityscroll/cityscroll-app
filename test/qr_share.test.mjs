import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { coarseLandFilter } = require("../site/location_awareness.js");
const { buildSearchDeepLink, canonicalSearchURL } = require("../site/nl_deeplink.js");
const indexSource = readFileSync(join(ROOT, "site", "index.html"), "utf8");
const qrSource = readFileSync(join(ROOT, "site", "qr_share.js"), "utf8");
const browserHarnessAvailable = spawnSync(
  "python3",
  ["-c", "import playwright"],
  { cwd: ROOT },
).status === 0;
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(qrSource, sandbox);

const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
};

function maskBit(mask, row, col) {
  if (mask === 0) return (row + col) % 2 === 0;
  if (mask === 1) return row % 2 === 0;
  if (mask === 2) return col % 3 === 0;
  if (mask === 3) return (row + col) % 3 === 0;
  if (mask === 4) return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
  if (mask === 5) return (row * col) % 2 + (row * col) % 3 === 0;
  if (mask === 6) return ((row * col) % 2 + (row * col) % 3) % 2 === 0;
  return ((row * col) % 3 + (row + col) % 2) % 2 === 0;
}

function functionModules(size, version) {
  const fixed = Array.from({ length: size }, () => Array(size).fill(false));
  const mark = (row, col) => {
    if (row >= 0 && col >= 0 && row < size && col < size) fixed[row][col] = true;
  };
  const rect = (top, left, height, width) => {
    for (let row = top; row < top + height; row += 1) {
      for (let col = left; col < left + width; col += 1) mark(row, col);
    }
  };

  rect(0, 0, 8, 8);
  rect(0, size - 8, 8, 8);
  rect(size - 8, 0, 8, 8);
  for (let cell = 8; cell < size - 8; cell += 1) {
    mark(6, cell);
    mark(cell, 6);
  }
  for (const row of ALIGNMENT[version] || []) {
    for (const col of ALIGNMENT[version] || []) {
      if (fixed[row][col]) continue;
      rect(row - 2, col - 2, 5, 5);
    }
  }
  for (let bit = 0; bit < 15; bit += 1) {
    mark(bit < 6 ? bit : bit < 8 ? bit + 1 : size - 15 + bit, 8);
    mark(8, bit < 8 ? size - bit - 1 : bit < 9 ? 7 : 15 - bit - 1);
  }
  mark(size - 8, 8);
  return fixed;
}

// A deliberately independent, byte-mode matrix reader. It identifies QR function
// modules, tries each standard data mask, then parses the byte payload from the
// unmasked data stream. The acceptance fixtures stay within one RS block.
function decodeMatrix(modules) {
  const size = modules.length;
  const version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 9);
  const fixed = functionModules(size, version);

  for (let mask = 0; mask < 8; mask += 1) {
    const bits = [];
    let row = size - 1;
    let direction = -1;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;
      while (true) {
        for (let offset = 0; offset < 2; offset += 1) {
          const x = col - offset;
          if (!fixed[row][x]) bits.push(Number(modules[row][x] !== maskBit(mask, row, x)));
        }
        row += direction;
        if (row < 0 || row >= size) {
          row -= direction;
          direction *= -1;
          break;
        }
      }
    }
    const read = (start, length) => {
      let value = 0;
      for (let i = 0; i < length; i += 1) value = (value << 1) | bits[start + i];
      return value;
    };
    if (read(0, 4) !== 4) continue;
    const countBits = version < 10 ? 8 : 16;
    const length = read(4, countBits);
    if (!length || 4 + countBits + length * 8 > bits.length) continue;
    let value = "";
    for (let i = 0; i < length; i += 1) {
      const byte = read(4 + countBits + i * 8, 8);
      if (byte < 0x20 || byte > 0x7e) {
        value = "";
        break;
      }
      value += String.fromCharCode(byte);
    }
    if (/^https:\/\//.test(value)) return value;
  }
  throw new Error("QR matrix did not contain a decodable URL");
}

test("matrix decodes to the exact bare canonical landing URL", () => {
  const url = "https://cityscroll.org/";
  assert.equal(decodeMatrix(sandbox.QRShare.matrix(url)), url);
});

test("filtered, entity, located, and saved-preset URLs survive matrix encoding exactly", () => {
  const urls = [
    "https://cityscroll.org/#vendor/Acme%20Gardens",
    "https://cityscroll.org/#land?boro=Queens",
    "https://cityscroll.org/#land?boro=Queens&cd=Q04",
    "https://cityscroll.org/#land?boro=Queens&cd=Q04&council=25",
    "https://cityscroll.org/#rules?q=sidewalk",
  ];
  for (const url of urls) assert.equal(decodeMatrix(sandbox.QRShare.matrix(url)), url);
});

test("located Land QR equals Copy link's coarse-area canonical URL", () => {
  const filter = coarseLandFilter({
    borough: "Queens",
    neighbourhood: "Elmhurst",
    label: "40-12 83 Street, Elmhurst, NY, USA",
    bbl: "4014930012",
    block: "401493",
    communityDistrict: "Q04",
    councilDistrict: "25",
  }, "active");
  const hash = buildSearchDeepLink("land", filter);
  const copyLinkOutput = canonicalSearchURL(
    { origin: "https://cityscroll.org", pathname: "/" },
    hash,
  );

  assert.equal(copyLinkOutput, "https://cityscroll.org/#land?boro=Queens&cd=Q04&council=25");
  assert.equal(decodeMatrix(sandbox.QRShare.matrix(copyLinkOutput)), copyLinkOutput);
  assert.doesNotMatch(copyLinkOutput, /(?:lat|latitude|lon|longitude|40\.7473|-73\.8832|4014930012)/i);
});

test("Copy link and QR receive the same canonical URL value", () => {
  assert.match(indexSource, /copy\.addEventListener\("click",\(\)=>copyText\(url, copy\)\);\s*bindQRShare\(root\.querySelector\("\[data-qr-share\]"\), url\)/);
  assert.match(indexSource, /if\(copy\) copy\.addEventListener\("click",\(\)=>copyText\(url, copy\)\);\s*bindQRShare\(root\.querySelector\("\[data-qr-share\]"\), url\)/);
  assert.match(indexSource, /copyText\(link, \$\("#ecopy"\)\)\);\s*bindQRShare\(\$\("#eqr"\), link\)/);
});

test("QR stays composed with Excel and print controls in notice action rows", () => {
  assert.match(indexSource, /id="dcopy"[\s\S]{0,200}qrButtonHTML\("dqr","act"\)[\s\S]{0,200}id="dxlsx"[\s\S]{0,200}id="dprint"/);
  assert.match(indexSource, /id="ncopy"[\s\S]{0,200}qrButtonHTML\("nqr","act"\)[\s\S]{0,500}id="nxlsx"[\s\S]{0,200}id="nprint"/);
  assert.match(indexSource, /bindQRShare\(\$\("#dqr"\), detailURL\);[\s\S]{0,200}exportNoticeXlsx\(r, chain\)[\s\S]{0,200}printCurrentView\("notice", detailURL\)/);
  assert.match(indexSource, /bindQRShare\(\$\("#nqr"\), link\);[\s\S]{0,200}exportNoticeXlsx\(r,await loadChain\(r\)\)[\s\S]{0,200}printCurrentView\("notice",link\)/);
});

test("headless interaction checks and committed 390/1440 captures pass", {
  timeout: 120_000,
  skip: browserHarnessAvailable ? false : "Playwright runs in the accessibility job",
}, () => {
  execFileSync("python3", ["test/functional/capture_qr_share.py", "--verify-only"], {
    cwd: ROOT,
    stdio: "inherit",
  });
});
