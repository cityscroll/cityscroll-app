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
// content_node_id is required (GITHUB_BOT_TOKEN, fine-grained: Issues RW on the repo).

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

export function formatComment({ from, to, mover }) {
  return `Board: **${from || "(no status)"} → ${to}** — moved by ${mover}.\n\n` +
    `<sub>Automated board notification. Manage via this issue's Subscribe button; ` +
    `board: https://github.com/orgs/cityscroll/projects/1</sub>`;
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

  const body = formatComment(c);
  if (env.BOARD_HOOK_DRY === "true") {
    console.log(`board-hook DRY: would comment on ${c.contentNodeId}: ${c.from} -> ${c.to} (by ${c.mover})`);
    return Response.json({ ok: true, dry: true, from: c.from, to: c.to });
  }
  if (!env.GITHUB_BOT_TOKEN) return new Response("no bot token", { status: 503 });

  try {
    const issue = await lookupIssue(env.GITHUB_BOT_TOKEN, c.contentNodeId);
    await postComment(env.GITHUB_BOT_TOKEN, issue, body);
    console.log(`board-hook: commented on ${issue.owner}/${issue.repo}#${issue.number}: ${c.from} -> ${c.to}`);
    return Response.json({ ok: true, issue: issue.number });
  } catch (e) {
    console.error("board-hook error:", String(e?.message || e));
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 502 });
  }
}
