#!/usr/bin/env node

// Wrangler rewrites Cron Trigger configuration on every deploy. Cloudflare documents
// up to 15 minutes of propagation after a trigger change, so keep production deploys
// away from the 13:00 UTC digest. The five-minute margin also covers normal upload time.

const START_MINUTE_UTC = 12 * 60 + 40;
const END_MINUTE_UTC = 13 * 60 + 5;
const HEARTBEAT_MS = 60_000;

export function digestDeployDelayMs(now = new Date()) {
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const secondMs = (now.getUTCSeconds() * 1000) + now.getUTCMilliseconds();
  if (minute < START_MINUTE_UTC || minute >= END_MINUTE_UTC) return 0;
  return ((END_MINUTE_UTC - minute) * 60_000) - secondMs;
}

export async function waitForDigestCronWindow({ now = () => new Date(), sleep = defaultSleep, log = console.log } = {}) {
  let remaining = digestDeployDelayMs(now());
  if (remaining <= 0) {
    log("Digest cron deploy guard: outside 12:40-13:05 UTC; continuing.");
    return 0;
  }

  const initial = remaining;
  while (remaining > 0) {
    log(`Digest cron deploy guard: waiting ${Math.ceil(remaining / 60_000)} minute(s) before deploy.`);
    await sleep(Math.min(HEARTBEAT_MS, remaining));
    remaining = digestDeployDelayMs(now());
  }
  log("Digest cron deploy guard: protected window cleared; continuing.");
  return initial;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await waitForDigestCronWindow();
}
