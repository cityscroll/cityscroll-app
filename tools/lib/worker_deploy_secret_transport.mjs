/**
 * Secret-transport policy helpers for Cloudflare Worker deploy/mutator launches.
 * Detect unsafe launcher / shell command shapes. Never logs or returns token values.
 */

const TOKEN_ASSIGN_RE = /(?:^|[\s;|&])(?:env\s+)?CLOUDFLARE_API_TOKEN=/;
const TOKEN_SHAPE_RE = /cfut_[A-Za-z0-9]{16,}/;
const BEARER_ARGV_RE = /Authorization:\s*Bearer\s+\S+/i;

/**
 * True when a launcher admission / shell command string would place the
 * deploy token on argv (for example `env CLOUDFLARE_API_TOKEN=... cmd`).
 */
export function admissionCommandExposesDeployToken(command) {
  const text = String(command || "");
  if (TOKEN_ASSIGN_RE.test(text)) return true;
  if (TOKEN_SHAPE_RE.test(text)) return true;
  if (BEARER_ARGV_RE.test(text)) return true;
  return false;
}

/**
 * True when a curl argv list embeds Authorization Bearer on argv instead of
 * reading it from `-H @file`.
 */
export function curlArgvExposesBearerToken(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : [String(argv || "")];
  for (const arg of list) {
    if (BEARER_ARGV_RE.test(arg)) return true;
    if (TOKEN_SHAPE_RE.test(arg)) return true;
    if (/^Authorization:\s*Bearer/i.test(arg)) return true;
  }
  return false;
}

/**
 * Build the safe launcher payload argv for a wrangler/curl child.
 * Returns an array suitable for a wrapper-first command: `wrapper -- child...`.
 */
export function buildSafeDeployChildArgv({
  wrapperPath,
  childArgv,
} = {}) {
  if (!wrapperPath) throw new Error("wrapperPath is required");
  if (!Array.isArray(childArgv) || childArgv.length === 0) {
    throw new Error("childArgv must be a non-empty array");
  }
  for (const arg of childArgv) {
    if (admissionCommandExposesDeployToken(String(arg))) {
      throw new Error("childArgv must not embed deploy token material");
    }
  }
  const argv = [wrapperPath, "--", ...childArgv.map(String)];
  const joined = argv.join(" ");
  if (admissionCommandExposesDeployToken(joined)) {
    throw new Error("safe deploy argv unexpectedly failed the admission policy");
  }
  return argv;
}

/**
 * Build a curl argv that loads Authorization from a header file (`-H @path`).
 * Never embeds Bearer material on argv.
 */
export function buildCurlArgvWithAuthHeaderFile({
  authHeaderFile,
  url,
  extraArgs = [],
} = {}) {
  if (!authHeaderFile) throw new Error("authHeaderFile is required");
  if (!url) throw new Error("url is required");
  const argv = ["curl", "-fsS", "-H", `@${authHeaderFile}`, ...extraArgs.map(String), String(url)];
  if (curlArgvExposesBearerToken(argv)) {
    throw new Error("curl argv unexpectedly embeds bearer material");
  }
  return argv;
}
