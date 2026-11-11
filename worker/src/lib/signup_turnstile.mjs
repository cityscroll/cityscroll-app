// A browser enrollment must carry a fresh Turnstile proof. Keep this check at
// the write boundary: a client-side widget alone cannot protect Resend spend.
import { isAllowedRequestOrigin } from "./cors.mjs";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Cloudflare-documented dummy secrets for automated testing only
// (https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
// Production must keep a real widget secret; these never ship as production env.
export const TURNSTILE_TESTING_PASS_SECRET = "1x0000000000000000000000000000000AA";
export const TURNSTILE_TESTING_FAIL_SECRET = "2x0000000000000000000000000000000AA";
export const TURNSTILE_TESTING_SPENT_SECRET = "3x0000000000000000000000000000000AA";

const TURNSTILE_TESTING_SECRETS = new Set([
  TURNSTILE_TESTING_PASS_SECRET,
  TURNSTILE_TESTING_FAIL_SECRET,
  TURNSTILE_TESTING_SPENT_SECRET,
]);

export function isDocumentedTurnstileTestingSecret(secret) {
  return typeof secret === "string" && TURNSTILE_TESTING_SECRETS.has(secret);
}

function approvedHostname(hostname) {
  if (typeof hostname !== "string" || !hostname) return false;
  try {
    const origin = new URL(`https://${hostname}`);
    return origin.hostname === hostname && isAllowedRequestOrigin(origin.origin);
  } catch {
    return false;
  }
}

export async function verifySignupTurnstile(req, env, body) {
  if (!env.TURNSTILE_SECRET) return { ok: false, reason: "not-configured", status: 503 };
  const token = body?.turnstileToken || body?.["cf-turnstile-response"];
  if (typeof token !== "string" || !token || token.length > 2048) {
    return { ok: false, reason: "bot-check", status: 403 };
  }
  const params = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const ip = req.headers.get("CF-Connecting-IP");
  if (ip) params.set("remoteip", ip);
  try {
    const response = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("siteverify unavailable");
    const result = await response.json();
    if (result.success === true) {
      // Documented testing secrets omit action/cdata and always report hostname
      // example.com. Accept success alone only for those exact secrets.
      if (isDocumentedTurnstileTestingSecret(env.TURNSTILE_SECRET)) {
        return { ok: true };
      }
      if (result.action === "signup" && approvedHostname(result.hostname)) {
        return { ok: true };
      }
    }
    return { ok: false, reason: "bot-check", status: 403 };
  } catch {
    return { ok: false, reason: "bot-check-unavailable", status: 503 };
  }
}
