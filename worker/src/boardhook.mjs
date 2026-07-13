// POST /board-hook — the board-notification bridge (wave 6 T8; the fix for GitHub's
// seven-year projects-notification gap, see the internal gap report).
//
// An org webhook (projects_v2_item, org cityscroll) delivers item edits here. For a
// STATUS change on a real ISSUE in our project, we post one small comment on that
// issue — and everything downstream is GitHub-native: the notification lands in each
// member's own inbox/email per their own settings; the board history accrues on the
// issue timeline; the control surface is GitHub's Subscribe button. Draft items have
// no thread and are skipped (the issues-only discipline is the coverage rule).
//
// Guards (public endpoint): HMAC signature verification (X-Hub-Signature-256,
// BOARD_HOOK_SECRET) fails closed; project allowlist (BOARD_PROJECT_ID); daily
// surface cap; BOARD_HOOK_DRY="true" logs instead of posting.
//
// Payload notes (verified 2026-07): `changes.field_value.{field_name,from,to}` is
// inline since June 2024; the issue NUMBER is not — one GraphQL lookup on
// content_node_id is required.
//
// Auth (App-first, zero-downtime swap; ): when BOARDNOTIFY_APP_ID +
// BOARDNOTIFY_APP_PRIVATE_KEY + BOARDNOTIFY_INSTALLATION_ID are set, we mint a short-lived
// App JWT (RS256) and exchange it for an installation access token — the bridge posts as
// its own "board-notify" bot identity instead of a personal fine-grained PAT. Falls back
// to the static GITHUB_BOT_TOKEN when any App secret is absent, so provisioning the App
// (see  — the manifest-flow creation kit) is a non-breaking swap.
// Obtaining BOARDNOTIFY_INSTALLATION_ID: after installing the App on the org, GET
// /app/installations with a freshly-minted App JWT and take the `id` for the cityscroll
// install (see kit/INSTALL.md).
//
// cc-roster: mentions are the one mechanism that notifies org members regardless of their
// own subscription state to the issue, so BOARDNOTIFY_CC (comma-separated logins, no "@",
// default empty) is appended as an explicit "cc @a @b" line on every comment.

import { overSurfaceCap } from "./lib/meter.mjs";

const GH_API = "https://api.github.com";

export async function verifySignature(secret, rawBody, sigHeader) {
  if (!secret || !sigHeader || !sigHeader.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expected = "sha256=" + hex;
  // constant-time-ish compare (same length strings)
  if (expected.length !== sigHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sigHeader.charCodeAt(i);
  return diff === 0;
}

// Decide whether a webhook payload merits a comment. Returns null (skip, with a
// reason) or { contentNodeId, from, to, mover }.
export function classify(payload, projectId) {
  if (!payload || payload.action !== "edited") return { skip: "not-an-edit" };
  const item = payload.projects_v2_item;
  if (!item) return { skip: "no-item" };
  if (projectId && item.project_node_id !== projectId) return { skip: "other-project" };
  if (item.content_type !== "Issue") return { skip: "draft-or-pr" }; // drafts have no thread
  const ch = payload.changes && payload.changes.field_value;
  if (!ch || ch.field_name !== "Status") return { skip: "not-a-status-change" };
  const from = ch.from && (ch.from.name || ch.from) || null;
  const to = ch.to && (ch.to.name || ch.to) || null;
  if (!to || from === to) return { skip: "no-transition" };
  return {
    contentNodeId: item.content_node_id,
    from: typeof from === "string" ? from : null,
    to: typeof to === "string" ? to : null,
    mover: (payload.sender && payload.sender.login) || "someone",
  };
}

// "a, @b,,c" -> ["a", "b", "c"] — tolerates stray "@"s and whitespace/empties from
// however the var got typed into `wrangler secret put` / the dashboard.
export function parseCcRoster(raw) {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
}

export function formatComment({ from, to, mover }, cc = []) {
  let body = `Board: **${from || "(no status)"} → ${to}** — moved by ${mover}.`;
  if (cc.length) body += `\n\ncc ${cc.map((u) => `@${u}`).join(" ")}`;
  body += `\n\n<sub>Automated board notification. Manage via this issue's Subscribe button; ` +
    `board: https://github.com/orgs/cityscroll/projects/1</sub>`;
  return body;
}

// --- GitHub App auth: JWT (RS256, WebCrypto) -> installation access token ---------

function base64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

function derLength(n) {
  return n <= 0xff ? [0x81, n] : [0x82, (n >> 8) & 0xff, n & 0xff];
}

// GitHub App private keys download as PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto's
// importKey only accepts PKCS#8. Wrap the PKCS#1 DER in the fixed PKCS#8 envelope
// (version 0 + the rsaEncryption AlgorithmIdentifier + the PKCS#1 bytes as an OCTET STRING).
function pkcs1ToPkcs8(pkcs1Der) {
  const octetString = new Uint8Array([0x04, ...derLength(pkcs1Der.length), ...pkcs1Der]);
  const algId = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const body = new Uint8Array([...version, ...algId, ...octetString]);
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

async function importAppPrivateKey(pem) {
  const der = pemToDer(pem);
  const pkcs8 = pem.includes("BEGIN RSA PRIVATE KEY") ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey(
    "pkcs8", pkcs8.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
}

// iat set 60s in the past (clock-drift guard) and exp 9min out (under GitHub's 10min
// ceiling) per GitHub's App-JWT docs. `now` is injectable for tests.
export async function buildAppJwt(appId, privateKeyPem, now = Math.floor(Date.now() / 1000)) {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const enc = (obj) => base64url(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const key = await importAppPrivateKey(privateKeyPem);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

async function fetchInstallationToken(appId, privateKeyPem, installationId) {
  const jwt = await buildAppJwt(appId, privateKeyPem);
  const r = await fetch(`${GH_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${jwt}`,
      "user-agent": "crol-board-notify",
      "accept": "application/vnd.github+json",
    },
  });
  if (!r.ok) throw new Error(`installation token ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const d = await r.json();
  return d.token;
}

// Zero-downtime swap: prefer the App installation token; fall back to the static
// GITHUB_BOT_TOKEN when App secrets aren't configured (pre-install, or mid-rollout).
// Returns null (not a token) when neither is configured — caller fails closed on that.
export async function resolveToken(env) {
  if (env.BOARDNOTIFY_APP_ID && env.BOARDNOTIFY_APP_PRIVATE_KEY && env.BOARDNOTIFY_INSTALLATION_ID) {
    return fetchInstallationToken(env.BOARDNOTIFY_APP_ID, env.BOARDNOTIFY_APP_PRIVATE_KEY, env.BOARDNOTIFY_INSTALLATION_ID);
  }
  return env.GITHUB_BOT_TOKEN || null;
}

async function lookupIssue(token, nodeId) {
  const r = await fetch(`${GH_API}/graphql`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "crol-board-notify",
    },
    body: JSON.stringify({
      query: `query($id: ID!) { node(id: $id) { ... on Issue { number repository { name owner { login } } } } }`,
      variables: { id: nodeId },
    }),
  });
  if (!r.ok) throw new Error(`graphql ${r.status}`);
  const d = await r.json();
  const n = d.data && d.data.node;
  if (!n || !n.number) throw new Error("content node is not an issue");
  return { owner: n.repository.owner.login, repo: n.repository.name, number: n.number };
}

async function postComment(token, { owner, repo, number }, body) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "crol-board-notify",
      "accept": "application/vnd.github+json",
    },
    body: JSON.stringify({ body }),
  });
  if (!r.ok) throw new Error(`comment ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

export async function handleBoardHook(req, env) {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!env.BOARD_HOOK_SECRET) return new Response("not configured", { status: 503 }); // fail closed

  const raw = await req.text();
  const ok = await verifySignature(env.BOARD_HOOK_SECRET, raw, req.headers.get("x-hub-signature-256") || "");
  if (!ok) return new Response("bad signature", { status: 401 });

  let payload;
  try { payload = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  const c = classify(payload, env.BOARD_PROJECT_ID || null);
  if (c.skip) {
    console.log("board-hook skip:", c.skip);
    return Response.json({ ok: true, skipped: c.skip });
  }

  const cap = Number(env.BOARD_HOOK_MAX_PER_DAY) || 100;
  if (await overSurfaceCap(env.NL_METER, "boardhook", cap)) {
    console.warn("board-hook: daily cap reached — dropping notification");
    return Response.json({ ok: true, skipped: "daily-cap" });
  }

  const body = formatComment(c, parseCcRoster(env.BOARDNOTIFY_CC));
  if (env.BOARD_HOOK_DRY === "true") {
    console.log(`board-hook DRY: would comment on ${c.contentNodeId}: ${c.from} -> ${c.to} (by ${c.mover})`);
    return Response.json({ ok: true, dry: true, from: c.from, to: c.to });
  }

  let token;
  try {
    token = await resolveToken(env);
  } catch (e) {
    console.error("board-hook auth error:", String(e?.message || e));
    return Response.json({ ok: false, error: "auth: " + String(e?.message || e) }, { status: 502 });
  }
  if (!token) return new Response("no bot token", { status: 503 });

  try {
    const issue = await lookupIssue(token, c.contentNodeId);
    await postComment(token, issue, body);
    console.log(`board-hook: commented on ${issue.owner}/${issue.repo}#${issue.number}: ${c.from} -> ${c.to}`);
    return Response.json({ ok: true, issue: issue.number });
  } catch (e) {
    console.error("board-hook error:", String(e?.message || e));
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 502 });
  }
}
