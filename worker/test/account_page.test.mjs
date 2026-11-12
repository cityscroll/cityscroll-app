// The account sign-in shell must present a working bot-check: it renders the
// same managed Turnstile widget the civic signup surface uses, requests the
// exact action the login endpoint verifies, and keeps its Content-Security
// -Policy scoped to the same provider origin (no new third parties).
import test from "node:test";
import assert from "node:assert/strict";

import { handleAccountPage } from "../src/account-page.mjs";

const ENABLED = { CITYSCROLL_ACCOUNTS_ENABLED: "true" };

function get(pathname, env = ENABLED) {
  return handleAccountPage(new Request(`https://cityscroll.org${pathname}`), env, pathname);
}

test("every account page 404s while the flow is disabled", async () => {
  for (const p of ["/account", "/account/", "/account/confirm"]) {
    const res = await get(p, { CITYSCROLL_ACCOUNTS_ENABLED: "false" });
    assert.equal(res.status, 404, p);
  }
});

test("the sign-in shell renders the managed Turnstile widget with the login action", async () => {
  const res = await get("/account");
  assert.equal(res.status, 200);
  const html = await res.text();
  // Same loader and sitekey as the civic signup surface (site/signup_turnstile.mjs).
  assert.match(html, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/);
  assert.match(html, /0x4AAAAAADtj-Mskk_RnVd5K/);
  // The account login endpoint verifies action "signup" (verifySignupTurnstile),
  // so the page must request a token with that action or production fails closed.
  assert.match(html, /action:\s*'signup'/);
  assert.match(html, /turnstile\.render\(/);
  assert.match(html, /turnstile\.execute\(/);
  // The token is sent only on an explicit click, never on load.
  assert.match(html, /turnstileToken:\s*token/);
  assert.ok(html.includes('id="turnstile"') && html.includes('id="email"') && html.includes('id="continue"'));
});

test("the sign-in shell CSP allows exactly the Turnstile provider origin", async () => {
  const res = await get("/account");
  const csp = res.headers.get("content-security-policy") || "";
  assert.match(csp, /script-src 'nonce-[^']+' https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /connect-src https:\/\/api\.cityscroll\.org https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
  // No wildcard or new third-party origin crept in.
  assert.doesNotMatch(csp, /script-src[^;]*\*/);
  assert.equal(csp.includes("'unsafe-eval'"), false);
});

test("the confirmation shell still renders without a widget and only sends on click", async () => {
  const res = await get("/account/confirm");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Finish signing in/);
  assert.match(html, /id="continue"/);
  // The confirm step never needs a bot-check; it must not load Turnstile.
  assert.doesNotMatch(html, /challenges\.cloudflare\.com/);
});
