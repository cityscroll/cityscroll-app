// Technical notices use a dedicated mailbox, independent of user feedback routing.
export const OPS_ALERT_TO = "alerts@cityscroll.org";

export async function notifyOperator(env, { subject, text, html }) {
  const payload = {
    from: env.ALERTS_FROM || "CityScroll <alerts@cityscroll.org>",
    to: OPS_ALERT_TO,
    subject,
    text,
    html: html || `<pre style="white-space:pre-wrap">${String(text).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</pre>`,
  };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}
