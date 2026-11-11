// Shared transactional email transport (Resend), factored out of the welcome
// sender so that the welcome mail and the new common-account login mail use one
// provider, one error classification, and one suppression authority.
//
// This is transport only: callers own their own subject, HTML, suppression check,
// and idempotency-key policy. It never enrolls a recipient in a watch or digest.
//
// Error classification is preserved exactly from the original welcome sender:
// network, parse, 408/409, and 5xx failures are `indeterminate` (safe to retry
// the same idempotency key); other non-2xx responses are `rejected`.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Send one transactional email through the engine's existing Resend sender.
 *
 * @param {object} env - worker env; reuses ALERTS_FROM and RESEND_API_KEY.
 * @param {object} message
 * @param {string|string[]} message.to - recipient(s).
 * @param {string} message.subject
 * @param {string} message.html
 * @param {string|null} [message.idempotencyKey] - provider dedupe key (kept ~24h).
 * @param {object} [message.headers] - extra message headers (e.g. List-Unsubscribe).
 * @returns {Promise<object>} the provider response body on acceptance.
 * @throws {Error & {deliveryStatus:"indeterminate"|"rejected"}} on failure.
 */
export async function sendTransactionalEmail(env, { to, subject, html, idempotencyKey = null, headers = undefined } = {}) {
  // The sender is operational configuration (set in wrangler [vars]), never a
  // hardcoded address: ALERTS_FROM is the engine's canonical transactional sender.
  const from = env.ALERTS_FROM || env.ALERTS_REPLY_TO;
  const requestHeaders = {
    "content-type": "application/json",
    authorization: `Bearer ${env.RESEND_API_KEY}`,
  };
  if (idempotencyKey) requestHeaders["Idempotency-Key"] = idempotencyKey;

  const body = { from, to, subject, html };
  if (headers) body.headers = headers;

  let response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
  } catch (error) {
    error.deliveryStatus = "indeterminate";
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`Resend ${response.status}: ${await response.text()}`);
    error.deliveryStatus =
      response.status === 408 || response.status === 409 || response.status >= 500 ? "indeterminate" : "rejected";
    throw error;
  }
  try {
    return await response.json();
  } catch (error) {
    error.deliveryStatus = "indeterminate";
    throw error;
  }
}
