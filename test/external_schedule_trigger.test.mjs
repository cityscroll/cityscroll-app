// The scheduler heartbeat has exactly one producer: the trigger that runs the
// external schedule cycle. Nothing else in the repository can prove liveness,
// so a trigger that cannot start, cannot authenticate, or cannot run often
// enough presents as a bare "scheduler heartbeat missing" with no further
// evidence — the alert the site owner received. These cases pin the trigger's
// side of that contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SCHEDULER_HEARTBEAT_MAX_AGE_MS } from "../worker/src/reliability_watchdogs.mjs";

const TEMPLATE_PATH = new URL("../ops/launchd/com.cityscroll.external-schedules.plist.template", import.meta.url);
const INSTALLER_PATH = new URL("../tools/install_external_schedule_launchd.sh", import.meta.url);

const template = readFileSync(TEMPLATE_PATH, "utf8");
const installer = readFileSync(INSTALLER_PATH, "utf8");

function plistString(key) {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(template);
  return match ? match[1] : null;
}

function plistInteger(key) {
  const match = new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`).exec(template);
  return match ? Number(match[1]) : null;
}

test("the trigger runs often enough to keep a heartbeat inside the watchdog window", () => {
  const intervalSeconds = plistInteger("StartInterval");
  assert.ok(Number.isFinite(intervalSeconds) && intervalSeconds > 0, "the trigger declares no StartInterval");
  // Two full intervals have to fit inside the window, so one skipped or slow
  // cycle is a late heartbeat rather than a scheduler the watchdog calls dead.
  assert.ok(
    intervalSeconds * 2 * 1000 <= SCHEDULER_HEARTBEAT_MAX_AGE_MS,
    `StartInterval ${intervalSeconds}s leaves no margin inside the ${SCHEDULER_HEARTBEAT_MAX_AGE_MS / 60000}m heartbeat window`,
  );
});

test("the trigger names every input the cycle cannot inherit from a login shell", () => {
  // A launchd agent starts with no login shell: an input the trigger does not
  // name is simply absent, and the cycle then reports a named failure instead
  // of publishing. These three are what publishing a heartbeat requires.
  for (const key of [
    "CROL_EXTERNAL_SCHEDULE_STATE_DIR",
    "CITYSCROLL_ADMIN_KEY_FILE",
    "CITYSCROLL_SCHEDULER_HEARTBEAT_URL",
  ]) {
    assert.match(template, new RegExp(`<key>${key}</key>`), `the trigger does not name ${key}`);
  }
  assert.equal(plistString("CITYSCROLL_SCHEDULER_HEARTBEAT_URL"), "https://api.cityscroll.org/admin/reliability/scheduler");
  // The credential is a file path, never an inline secret in a checked-in template.
  assert.match(template, /<key>CITYSCROLL_ADMIN_KEY_FILE<\/key>\s*<string>__[A-Z_]+__<\/string>/);
});

test("the trigger names its interpreter absolutely instead of searching a PATH", () => {
  // launchd starts an agent with the system default PATH, which does not carry
  // a user- or package-manager-installed Node. Looking the interpreter up by
  // name exits 127 before any code runs, and the only symptom anywhere is the
  // heartbeat the watchdog reports missing.
  const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(template);
  assert.ok(program, "the trigger declares no ProgramArguments");
  const [interpreter] = [...program[1].matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  assert.ok(interpreter, "the trigger declares no interpreter");
  assert.equal(/^\/usr\/bin\/env$/.test(interpreter), false, "the trigger resolves its interpreter through PATH");
  assert.match(interpreter, /^(?:\/|__[A-Z0-9_]+__)/, "the interpreter is neither absolute nor a substituted placeholder");
  // The installer refuses rather than shipping a trigger that cannot start.
  assert.match(installer, /command -v node/);
  assert.match(installer, /exit 1/);
});

test("the installer fills every placeholder the trigger declares", () => {
  // A placeholder added to the template but not to the installer ships a plist
  // with a literal __PLACEHOLDER__ in it. launchd rejects or misroutes that
  // agent, the cycle never runs, and the only symptom anywhere is a heartbeat
  // the watchdog reports missing.
  const placeholders = [...new Set([...template.matchAll(/__[A-Z0-9_]+__/g)].map((match) => match[0]))];
  assert.ok(placeholders.length > 0, "the template declares no placeholders");
  const unsubstituted = placeholders.filter((placeholder) => !installer.includes(placeholder));
  assert.deepEqual(unsubstituted, [], `the installer leaves ${unsubstituted.join(", ")} in the deployed trigger`);
});

test("the trigger starts on load so a restarted host republishes without waiting", () => {
  assert.match(template, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(template, /<key>Label<\/key>\s*<string>com\.cityscroll\.external-schedules<\/string>/);
});
