import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  NODE_DEFAULT_STDIO_MAX_BUFFER_BYTES,
  WRANGLER_STDIO_MAX_BYTES,
  createWranglerInvoker,
  runWrangler,
} from "../tools/lib/wrangler_exec.mjs";

const execFileAsync = promisify(execFile);
const OVER_DEFAULT = NODE_DEFAULT_STDIO_MAX_BUFFER_BYTES + (256 * 1024);

test("Node's default execFile maxBuffer is 1 MiB", () => {
  assert.equal(NODE_DEFAULT_STDIO_MAX_BUFFER_BYTES, 1024 * 1024);
});

test("the stream-to-file wrangler runner retains stdout larger than 1 MiB", async () => {
  assert.ok(OVER_DEFAULT > NODE_DEFAULT_STDIO_MAX_BUFFER_BYTES);
  assert.ok(OVER_DEFAULT < WRANGLER_STDIO_MAX_BYTES);

  // Bare promisified execFile (the pre-fix D1 path) dies on >1 MiB stdout.
  await assert.rejects(
    () => execFileAsync(
      process.execPath,
      ["-e", `process.stdout.write("x".repeat(${OVER_DEFAULT}))`],
      { encoding: "utf8" },
    ),
    (error) => {
      assert.equal(error.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      return true;
    },
  );

  // The shared helper streams to a file, so the same payload succeeds.
  const result = await runWrangler([], {
    command: process.execPath,
    commandArgs: ["-e", `process.stdout.write("x".repeat(${OVER_DEFAULT})); process.stderr.write("ok");`],
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.length, OVER_DEFAULT);
  assert.equal(result.stderr, "ok");
});

test("createWranglerInvoker matches the adapter seam and the bound stays 32 MiB", () => {
  const viaInvoker = createWranglerInvoker({});
  assert.equal(typeof viaInvoker, "function");
  assert.ok(WRANGLER_STDIO_MAX_BYTES > NODE_DEFAULT_STDIO_MAX_BUFFER_BYTES);
  assert.equal(WRANGLER_STDIO_MAX_BYTES, 32 * 1024 * 1024);
});

test("runWrangler fails closed when retained stdout exceeds the 32 MiB bound", async () => {
  // Mirrors Deploy worker 37399462266: wrangler d1 execute --json dumped
  // ~68 MiB for one unpaged partition SELECT. Keep the bound; page the scan.
  const overBound = WRANGLER_STDIO_MAX_BYTES + 1;
  await assert.rejects(
    () => runWrangler([], {
      command: process.execPath,
      commandArgs: ["-e", `process.stdout.write("x".repeat(${overBound}))`],
    }),
    (error) => {
      assert.match(String(error?.message || error), /wrangler stdout exceeded bound/);
      assert.match(String(error?.message || error), new RegExp(`limit=${WRANGLER_STDIO_MAX_BYTES}`));
      return true;
    },
  );
});

test("runWrangler reaps a SIGTERM-ignoring child after ENOSPC and preserves the stream error", async () => {
  // Defects:
  // 1) awaiting child close before stream promises hung on full-disk writes;
  // 2) killChild skipped SIGKILL once child.killed was true after SIGTERM
  //    (Node: killed means signal sent, not that the process exited);
  // 3) finally removed the temp dir and returned before the child was reaped.
  // Keep the 32 MiB bound. Fail closed on ENOSPC/EIO with the original stream
  // error, escalate to SIGKILL, await close, then clean up.
  const { Writable } = await import("node:stream");
  const { existsSync } = await import("node:fs");
  const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), {
    code: "ENOSPC",
  });
  const createWriteStreamFn = () => new Writable({
    write(_chunk, _enc, cb) {
      cb(enospc);
    },
  });

  let spawnedPid = null;
  let captureDir = null;
  const started = performance.now(); // test-clock: allow-real-clock hang bound for teardown
  await assert.rejects(
    () => runWrangler([], {
      command: process.execPath,
      // Ignore SIGTERM; swallow EPIPE; keep writing so a hang would outlive us.
      commandArgs: ["-e", `
        process.on("SIGTERM", () => {});
        process.stdout.on("error", () => {});
        setInterval(() => {
          try { process.stdout.write("x".repeat(65536)); } catch (_) {}
        }, 0);
      `],
      createWriteStreamFn,
      termTimeoutMs: 50,
      onSpawn(child, dir) {
        spawnedPid = child.pid;
        captureDir = dir;
      },
    }),
    (error) => {
      assert.equal(error?.code, "ENOSPC", `must preserve stream error, got ${error}`);
      return true;
    },
  );
  assert.ok(
    performance.now() - started < 5000, // test-clock: allow-real-clock hang bound for teardown
    "ENOSPC must reject promptly instead of hanging on child close",
  );
  assert.ok(spawnedPid, "onSpawn must observe the child pid");
  // Child must be reaped — kill(pid, 0) throws ESRCH when gone.
  assert.throws(
    () => process.kill(spawnedPid, 0),
    (error) => error?.code === "ESRCH",
    `child pid ${spawnedPid} must be reaped after ENOSPC teardown`,
  );
  assert.equal(
    captureDir && existsSync(captureDir),
    false,
    "temp capture dir must be removed only after the child is reaped",
  );
});

test("runWrangler awaits stdio close even when the child has already exited", async () => {
  // exitCode/signalCode are set on `exit`, which can precede stdio `close`.
  // Teardown must await the shared close promise — not return early on exit —
  // before removing the temp capture directory.
  const { createWriteStream, existsSync } = await import("node:fs");
  let pendingWrites = 0;
  let streamFinished = false;
  const createWriteStreamFn = (path) => {
    const out = createWriteStream(path);
    const originalWrite = out._write.bind(out);
    const originalFinal = out._final ? out._final.bind(out) : (_cb) => _cb();
    out._write = (chunk, enc, cb) => {
      pendingWrites += 1;
      // Delay drain so process.exit can race ahead of pipe close.
      setTimeout(() => { // test-clock: allow-real-clock delayed drain for exit-before-close
        originalWrite(chunk, enc, (error) => {
          pendingWrites -= 1;
          cb(error);
        });
      }, 40);
    };
    out._final = (cb) => {
      setTimeout(() => { // test-clock: allow-real-clock delayed final for exit-before-close
        originalFinal((error) => {
          streamFinished = true;
          cb(error);
        });
      }, 40);
    };
    return out;
  };

  let childRef = null;
  let captureDir = null;
  let exitSeen = false;
  let closeSeen = false;
  const resultPromise = runWrangler([], {
    command: process.execPath,
    commandArgs: [
      "-e",
      'process.stdout.write("x".repeat(200000)); process.stderr.write("ok"); process.exit(0);',
    ],
    createWriteStreamFn,
    onSpawn(child, dir) {
      childRef = child;
      captureDir = dir;
      child.once("exit", () => {
        exitSeen = true;
      });
      child.once("close", () => {
        closeSeen = true;
      });
    },
  });

  // Wait until the OS process has exited while streams may still be draining.
  await new Promise((resolve, reject) => {
    if (!childRef) {
      reject(new Error("onSpawn did not run"));
      return;
    }
    if (childRef.exitCode != null || childRef.signalCode != null) {
      resolve();
      return;
    }
    childRef.once("exit", () => resolve());
    childRef.once("error", reject);
  });
  assert.equal(exitSeen, true);
  assert.ok(
    !streamFinished || pendingWrites > 0,
    "stdio should still be draining after process exit",
  );

  const result = await resultPromise;
  assert.equal(result.status, 0);
  assert.equal(closeSeen, true);
  assert.equal(streamFinished, true);
  assert.equal(pendingWrites, 0);
  assert.equal(
    captureDir && existsSync(captureDir),
    false,
    "temp capture dir must be removed only after stdio close",
  );
});

test("D1 wrangler adapters use the shared invoker instead of bare execFileAsync", async () => {
  const { readFileSync } = await import("node:fs");
  const paths = [
    "tools/d1_production_delta.mjs",
    "tools/d1_generation_fence.mjs",
    "tools/d1_bounded_publisher.mjs",
    "tools/d1_publication_receipt.mjs",
  ];
  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    assert.match(text, /createWranglerInvoker/, `${path} must use createWranglerInvoker`);
    assert.doesNotMatch(
      text,
      /execFileAsync\("npx"/,
      `${path} must not keep the default execFileAsync npx wrangler invoke`,
    );
    assert.doesNotMatch(text, /from "node:child_process"/, `${path} should not import child_process directly`);
  }
});

test("runWrangler default processGroup stays non-detached (opt-in only)", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  let observed = null;
  const result = await runWrangler([], {
    command: process.execPath,
    // Stay alive long enough for onSpawn to read the process group.
    commandArgs: ["-e", "setTimeout(() => {}, 400); process.stdout.write(\"ok\")"],
    onSpawn(child) {
      let childPgid = null;
      let parentPgid = null;
      if (process.platform !== "win32") {
        childPgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(child.pid)], {
          encoding: "utf8",
        }).trim());
        parentPgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
          encoding: "utf8",
        }).trim());
      }
      observed = { pid: child.pid, childPgid, parentPgid };
    },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ok");
  assert.ok(observed?.pid);
  if (process.platform !== "win32") {
    assert.ok(Number.isFinite(observed.childPgid));
    assert.ok(Number.isFinite(observed.parentPgid));
    assert.equal(
      observed.childPgid,
      observed.parentPgid,
      "default runWrangler must keep the child in the parent process group (non-detached)",
    );
  }
  // Source-level: default parameter must be false (not platform-gated true).
  const src = readFileSync(new URL("../tools/lib/wrangler_exec.mjs", import.meta.url), "utf8");
  assert.match(src, /processGroup\s*=\s*false/);
  assert.doesNotMatch(src, /processGroup\s*=\s*process\.platform\s*!==\s*"win32"/);
});

test("isolated runWrangler abort: TERM-exit leader + TERM-ignore descendant settles via ref'd grace (T2)", async () => {
  // T2/L2: processGroup grace timer must stay ref'd. Require a READY marker
  // with the real descendant PID (+ pgid) after the TERM trap is installed,
  // then abort. Assert that PID existed and was reaped. No null-as-success.
  if (process.platform === "win32") return;
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "t2-pg-grace-"));
  const readyPath = join(dir, "ready");
  const descPath = join(dir, "desc.mjs");
  const leaderPath = join(dir, "leader.mjs");
  const runnerPath = join(dir, "runner.mjs");
  const wranglerHref = new URL("../tools/lib/wrangler_exec.mjs", import.meta.url).href;

  writeFileSync(descPath, `
    import { writeFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    process.on("SIGTERM", () => {});
    const pgid = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
    writeFileSync(process.env.READY_PATH, JSON.stringify({ pid: process.pid, pgid: Number(pgid) }));
    setInterval(() => {}, 40);
  `);
  writeFileSync(leaderPath, `
    import { spawn } from "node:child_process";
    const g = spawn(process.execPath, [${JSON.stringify(descPath)}], {
      env: process.env,
      stdio: "ignore",
      detached: false,
    });
    g.unref();
    setInterval(() => process.stdout.write("."), 80);
  `);
  writeFileSync(runnerPath, `
    import { readFileSync, existsSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    import { runWrangler } from ${JSON.stringify(wranglerHref)};
    const readyPath = ${JSON.stringify(readyPath)};
    const leaderPath = ${JSON.stringify(leaderPath)};
    const ac = new AbortController();
    const waitReady = async (timeoutMs = 3000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (existsSync(readyPath)) {
          const info = JSON.parse(readFileSync(readyPath, "utf8"));
          if (Number.isInteger(info.pid) && info.pid > 0 && Number.isInteger(info.pgid) && info.pgid > 0) {
            return info;
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("descendant READY marker missing");
    };
    let leaderPid = null;
    const childEnv = { ...process.env, READY_PATH: readyPath };
    const run = runWrangler([], {
      command: process.execPath,
      commandArgs: [leaderPath],
      env: childEnv,
      signal: ac.signal,
      termTimeoutMs: 200,
      processGroup: true,
      onSpawn(child) {
        leaderPid = child.pid;
        waitReady().then((info) => {
          if (info.pgid !== leaderPid) {
            console.error("pgid_mismatch", info, "leader", leaderPid);
            process.exit(7);
          }
          console.log("t2_descendant_ready", info.pid, "pgid", info.pgid);
          ac.abort();
        }).catch((error) => {
          console.error("t2_ready_failed", error);
          process.exit(5);
        });
      },
    });
    try {
      await run;
      console.error("expected_reject");
      process.exit(2);
    } catch (error) {
      if (!/cancelled|aborted/i.test(String(error?.message || error))) {
        console.error("unexpected_error", error);
        process.exit(3);
      }
    }
    const info = JSON.parse(readFileSync(readyPath, "utf8"));
    if (!Number.isInteger(info.pid) || info.pid <= 0) {
      console.error("missing_descendant_pid", info);
      process.exit(6);
    }
    // Small settle after teardown before the liveness probe.
    await new Promise((r) => setTimeout(r, 50));
    let alive = true;
    try { process.kill(info.pid, 0); }
    catch (error) {
      if (error?.code === "ESRCH") alive = false;
      else throw error;
    }
    if (alive) {
      try {
        console.error("descendant_ps", execFileSync("ps", ["-o", "pid,pgid,state,command", "-p", String(info.pid)], { encoding: "utf8" }));
      } catch (e) {
        console.error("descendant_ps_err", e.message);
      }
      // Last-resort evidence: force-kill and still fail the proof.
      try { process.kill(-info.pgid, "SIGKILL"); } catch { /* ignore */ }
      try { process.kill(info.pid, "SIGKILL"); } catch { /* ignore */ }
      console.error("descendant_pid_still_alive", info.pid);
      process.exit(4);
    }
    console.log("t2_pg_grace_settled", info.pid);
  `);

  const child = spawnSync(process.execPath, [runnerPath], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, READY_PATH: readyPath },
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(
    child.status,
    0,
    `T2 isolated grace proof failed (status=${child.status}):\n${child.stdout}\n${child.stderr}`,
  );
  assert.match(child.stdout, /t2_descendant_ready \d+/);
  assert.match(child.stdout, /t2_pg_grace_settled \d+/);
});

test("runWrangler abort drains a TERM-ignoring descendant process group", async () => {
  // W1: npx-like leader + grandchild that ignores SIGTERM must be group-killed.
  if (process.platform === "win32") return;

  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wrangler-pg-"));
  const marker = join(dir, "alive");
  const leaderScript = join(dir, "leader.mjs");
  // Grandchild stays in the leader's process group (like npx→wrangler),
  // ignores SIGTERM, and keeps touching an alive marker until SIGKILL.
  writeFileSync(leaderScript, `
    import { spawn } from "node:child_process";
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => {});
      const marker = process.env.ALIVE_MARKER;
      const tick = () => { try { writeFileSync(marker, String(Date.now())); } catch {} };
      tick();
      setInterval(tick, 50);
    `)}], {
      env: { ...process.env, ALIVE_MARKER: ${JSON.stringify(marker)} },
      stdio: "ignore",
      // Inherit the leader process group — do not detach into a new one.
      detached: false,
    });
    child.unref();
    setInterval(() => process.stdout.write("."), 100);
  `);

  const ac = new AbortController();
  let leaderPid = null;
  const started = performance.now(); // test-clock: allow-real-clock abort drain bound
  const run = runWrangler([], {
    command: process.execPath,
    commandArgs: [leaderScript],
    signal: ac.signal,
    termTimeoutMs: 80,
    processGroup: true,
    onSpawn(child) {
      leaderPid = child.pid;
      setTimeout(() => ac.abort(), 120).unref?.(); // test-clock: allow-real-clock abort after spawn
    },
  });

  await assert.rejects(
    () => run,
    (error) => {
      assert.match(String(error?.message || error), /cancelled|aborted/i);
      return true;
    },
  );
  assert.ok(performance.now() - started < 5000, "abort must settle promptly"); // test-clock: allow-real-clock
  assert.ok(leaderPid, "leader pid observed");
  assert.throws(
    () => process.kill(leaderPid, 0),
    (error) => error?.code === "ESRCH",
    `leader pid ${leaderPid} must be reaped`,
  );
  // Descendant must stop refreshing the alive marker after group drain.
  await new Promise((r) => setTimeout(r, 200)); // test-clock: allow-real-clock quiet window
  let before;
  try {
    before = Number((await import("node:fs")).readFileSync(marker, "utf8"));
  } catch {
    before = null;
  }
  await new Promise((r) => setTimeout(r, 250)); // test-clock: allow-real-clock quiet window
  let after;
  try {
    after = Number((await import("node:fs")).readFileSync(marker, "utf8"));
  } catch {
    after = null;
  }
  assert.ok(
    before == null || after == null || after === before,
    `TERM-ignoring descendant must be quiet after group drain (before=${before} after=${after})`,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("runWrangler bounds stderr the same way as stdout", async () => {
  const overBound = WRANGLER_STDIO_MAX_BYTES + 1;
  await assert.rejects(
    () => runWrangler([], {
      command: process.execPath,
      commandArgs: ["-e", `process.stderr.write("y".repeat(${overBound}))`],
    }),
    (error) => {
      assert.match(String(error?.message || error), /wrangler stderr exceeded bound/);
      assert.match(String(error?.message || error), new RegExp(`limit=${WRANGLER_STDIO_MAX_BYTES}`));
      return true;
    },
  );
});
