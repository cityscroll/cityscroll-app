// Inbound email signup: a person emails SUBSCRIBE_ADDRESS in plain English; we parse
// it into a lens filter, reply with a double-opt-in confirm link + a preview of recent
// matches. Adapted from Dev Doshi's crol-alert inbound.ts onto crol-list's stateless
// token flow (nothing stored until /confirm is clicked).
//
// Spend defenses (this handler triggers an LLM call per email — the classic
// denial-of-wallet hole): daily surface ceiling (NL_METER `m:inbound:<day>`,
// INBOUND_MAX_PER_DAY, default 100), per-sender daily limit (5), input size cap,
// auto-reply/loop guards, and fail-closed when secrets are missing.

import PostalMime from "postal-mime";
import { parseLensFilter } from "./nl.mjs";
import { isValidEmail, buildSubscription, redactEmail } from "./lib/subscriptions.mjs";
import { describeFilter } from "./lib/confirm_email.mjs";
import { compileSub } from "./lib/compile.mjs";
import { signToken } from "optin-token";
import { sendConfirm } from "./subscribe.mjs";
import { overSurfaceCap, overActorLimit } from "./lib/meter.mjs";

const CONFIRM_TTL = 24 * 3600;
const MAX_BODY = 2000; // characters of email text we look at

// Cheap lens router — the LLM parses fields WITHIN a lens, so pick the lens first.
// Money is the default (procurement is the primary use case).
export function pickLens(text) {
  const t = String(text).toLowerCase();
  if (/rezon|zoning|land.?use|ulurp|variance/.test(t)) return "land";
  if (/hearing|meeting|testif/.test(t)) return "meetings";
  if (/\brule|regulation|comment period/.test(t)) return "rules";
  if (/auction|property disposition|city-owned|surplus/.test(t)) return "property";
  return "money";
}

// True for senders we must never auto-reply to (loops, bounces, ourselves).
export function shouldIgnore(from, headers = new Map()) {
  const f = String(from || "").toLowerCase();
  if (!f || f.endsWith("@crol-list.org")) return true;
  if (/mailer-daemon|no-?reply|postmaster|bounce/.test(f)) return true;
  const auto = headers.get?.("auto-submitted") || "";
  if (auto && auto.toLowerCase() !== "no") return true;
  return false;
}

export async function handleInboundEmail(message, env) {
  // Fail closed: without these, we can neither confirm nor reply safely.
  if (!env.TOKEN_SECRET || !env.RESEND_API_KEY) return;

  const parsed = await PostalMime.parse(message.raw);
  const headers = new Map((parsed.headers || []).map((h) => [String(h.key).toLowerCase(), String(h.value)]));
  const from = String(message.from || parsed.from?.address || "").toLowerCase().trim();
  if (shouldIgnore(from, headers) || !isValidEmail(from)) return;

  const subject = parsed.subject || "";
  const bodyText = (parsed.text || (parsed.html || "").replace(/<[^>]+>/g, " ")).trim();
  const request = `${subject}\n\n${bodyText}`.trim().slice(0, MAX_BODY);
  if (!request) return;

  // Ceilings BEFORE the model call.
  if (await overActorLimit(env.SUBS, "inbound", from, 5)) {
    console.warn(`inbound: per-sender limit hit for ${redactEmail(from)}`);
    return; // silent: replying would let a flooder farm replies
  }
  const cap = Number(env.INBOUND_MAX_PER_DAY) || 100;
  if (await overSurfaceCap(env.NL_METER, "inbound", cap)) {
    console.warn("inbound: daily surface cap reached");
    return;
  }

  const lens = pickLens(request);
  const parsedFilter = await parseLensFilter(env, lens, request);
  if (parsedFilter.degraded) {
    await reply(env, from, subject,
      "Sorry — we couldn't turn that into a watch. Try describing what you want, e.g.:\n\n" +
      '  "construction contract awards over $500k"\n' +
      '  "rezoning notices in Brooklyn"\n' +
      '  "upcoming public hearings about transportation"\n\n' +
      "Or build it on the site: https://crol-list.org/");
    return;
  }

  const filter = parsedFilter.filter;
  const sub = buildSubscription({ email: from, lens, filter, freq: "daily" });
  const token = await signToken(env.TOKEN_SECRET, { e: sub.email, l: lens, f: filter, c: "email", q: sub.freq }, { ttlSeconds: CONFIRM_TTL });
  const base = env.CONFIRM_BASE || "https://api.crol-list.org";
  const confirmUrl = `${base}/confirm?token=${encodeURIComponent(token)}`;

  // The confirm email itself carries the "we understood you as…" description
  // (confirmEmailHtml renders lens + filter + freq), completing double opt-in.
  try {
    await sendConfirm(env, sub.email, lens, filter, sub.freq, confirmUrl);
    console.log(`inbound: confirm sent to ${redactEmail(from)} — ${describeFilter(lens, filter)}`);
  } catch (e) {
    console.error("inbound: confirm send failed:", String(e?.message || e));
  }
}

// Plain-text reply from the app's own identity (never as a person — MISSION identity
// discipline). Preview of matches is intentionally omitted here: the confirm email
// describes the watch, and /confirm's landing shows what it covers.
async function reply(env, to, subject, text) {
  const fromHdr = env.ALERTS_FROM || "CROL-List <alerts@crol-list.org>";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: fromHdr, to, subject: "Re: " + (subject || "your CROL-List request"), text }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}`);
}
