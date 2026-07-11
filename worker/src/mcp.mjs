// POST /mcp — stateless remote MCP server (Streamable HTTP, single JSON-RPC response
// per POST; spec-valid for tools-only servers). Adapted from Dev Doshi's crol-alert.
//
// Tools give AI assistants the same capabilities the site offers people:
//   search_notices / get_notice  — the D1 notices mirror (no model call, cheap)
//   preview_watch                — plain English → lens filter → live results (LLM, metered)
//   create_watch                 — plain English → DOUBLE-OPT-IN confirm email (LLM, metered)
// No list/delete tools: watch management stays behind the emailed unsubscribe links,
// so knowing an address never reveals or controls its subscriptions (privacy first).
//
// Spend defenses (every paid path fails closed): optional MCP_BEARER_TOKEN; per-IP daily
// request limit; shared daily LLM ceiling (NL_METER `m:mcp:<day>`, MCP_MAX_CALLS_PER_DAY);
// per-sender confirm-email limit (same 5/day as /subscribe).

import { searchNotices, toRecord } from "./lib/notices.mjs";
import { parseLensFilter } from "./nl.mjs";
import { LENSES } from "./lib/filter.mjs";
import { compileSub } from "./lib/compile.mjs";
import { describeFilter } from "./lib/confirm_email.mjs";
import { isValidEmail, buildSubscription } from "./lib/subscriptions.mjs";
import { signToken } from "optin-token";
import { sendConfirm } from "./subscribe.mjs";
import { overSurfaceCap, overActorLimit } from "./lib/meter.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const CONFIRM_TTL = 24 * 3600;
const SUBSCRIBABLE = new Set(["money", "people", "land", "property", "rules", "meetings"]);

const TOOLS = [
  {
    name: "search_notices",
    description: "Search NYC City Record notices (the daily-refreshed mirror). Keyword terms are OR-matched; add structured filters to narrow. Amounts are validity-filtered (data-entry errors excluded); rolling placeholder deadlines are labeled, never shown as dates.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", description: "Keyword terms, space-separated (e.g. 'affordable housing')." },
        section: { type: "string", description: "Exact section, e.g. 'Procurement', 'Public Hearings and Meetings', 'Agency Rules'." },
        agency: { type: "string", description: "Agency name substring." },
        min_amount: { type: "number", description: "Minimum contract amount in dollars (Award notices only carry amounts)." },
        max_amount: { type: "number", description: "Maximum contract amount in dollars." },
        open_only: { type: "boolean", description: "Only notices whose due date hasn't passed." },
        exclude_rolling: { type: "boolean", description: "Drop pre-qualified-list placeholders (year-2090 'deadlines')." },
        limit: { type: "number", description: "Max results (default 15, cap 100)." },
      },
    },
  },
  {
    name: "get_notice",
    description: "Full detail for one City Record notice by its RequestID.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
    },
  },
  {
    name: "preview_watch",
    description: "Preview what a plain-English standing watch would deliver, without subscribing. Lens: money (procurement), land (rezonings), property, rules, meetings, people.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        lens: { type: "string", enum: [...SUBSCRIBABLE] },
        request: { type: "string", description: "Plain-English description, e.g. 'construction awards over $1M from Parks'." },
      },
      required: ["lens", "request"],
    },
  },
  {
    name: "create_watch",
    description: "Create a standing email watch from plain English. Sends a double-opt-in confirmation email — nothing is stored and no digests are sent until the address confirms.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        email: { type: "string" },
        lens: { type: "string", enum: [...SUBSCRIBABLE] },
        request: { type: "string", description: "Plain-English description of what to watch." },
        freq: { type: "string", enum: ["daily", "weekly"], description: "Digest frequency (default daily)." },
      },
      required: ["email", "lens", "request"],
    },
  },
];

function text(t) {
  return { content: [{ type: "text", text: t }] };
}
function toolError(t) {
  return { ...text(t), isError: true };
}

function fmtRecord(r, i) {
  const meta = [r.section, r.notice_type, r.category, r.contract_amount_display, r.vendor].filter(Boolean).join(" · ");
  const lines = [`${i + 1}. ${r.date || "—"} · ${r.agency || "—"} · ${r.title || "(untitled)"}`];
  if (meta) lines.push(`   ${meta}`);
  if (r.due_date) lines.push(`   bid due ${r.due_date}`);
  else if (r.deadline_note) lines.push(`   ${r.deadline_note}`);
  if (r.snippet) lines.push(`   ${r.snippet}`);
  lines.push(`   RequestID ${r.request_id} · https://crol-list.org/index.html#notice/${r.request_id}`);
  return lines.join("\n");
}

async function fetchSodaRows(url, params) {
  const r = await fetch(`${url}?${new URLSearchParams(params).toString()}`);
  if (!r.ok) throw new Error(`open-data ${r.status}`);
  return r.json();
}

async function runPreview(env, lens, request) {
  const mcpCap = Number(env.MCP_MAX_CALLS_PER_DAY) || 200;
  if (await overSurfaceCap(env.NL_METER, "mcp", mcpCap)) {
    return { error: "Daily capacity for plain-English parsing is exhausted — try tomorrow, or use search_notices with structured filters (not metered)." };
  }
  const parsed = await parseLensFilter(env, lens, request);
  if (parsed.degraded) return { error: `Couldn't parse that request (${parsed.reason}). Try plainer wording.` };
  const q = compileSub({ lens, filter: parsed.filter }, new Date().toISOString().slice(0, 10));
  if (!q) return { error: `The '${lens}' lens can't be replayed as a standing watch yet.` };
  let rows = await fetchSodaRows(q.url, q.params);
  if (q.postFilter) rows = rows.filter(q.postFilter);
  return { filter: parsed.filter, label: describeFilter(lens, parsed.filter), kind: q.kind, rows: rows.slice(0, 10) };
}

function previewText(p) {
  const head = `Understood as: ${p.label}`;
  if (!p.rows.length) return `${head}\n\nNo current matches — a watch would alert when new matching notices post.`;
  const items = p.rows.map((r, i) => {
    const bits = [r.start_date ? String(r.start_date).slice(0, 10) : "—", r.agency_name, r.short_title, r.contract_amount ? "$" + Number(r.contract_amount).toLocaleString("en-US") : "", r.due_date ? "due " + String(r.due_date).slice(0, 10) : ""].filter(Boolean);
    return `${i + 1}. ${bits.join(" · ")}`;
  });
  return `${head}\n\nRecent matches (${p.rows.length} shown):\n` + items.join("\n");
}

async function callTool(env, req, name, args) {
  switch (name) {
    case "search_notices": {
      if (!env.DB) return toolError("The notices mirror is unavailable right now.");
      const terms = String(args.query || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
      const res = await searchNotices(env.DB, {
        termGroups: terms.length ? [terms] : [],
        section: args.section || null,
        agency: args.agency || null,
        minAmount: typeof args.min_amount === "number" ? args.min_amount : null,
        maxAmount: typeof args.max_amount === "number" ? args.max_amount : null,
        openOnly: !!args.open_only,
        excludeRollingDeadlines: !!args.exclude_rolling,
        limit: typeof args.limit === "number" ? args.limit : 15,
      });
      if (!res.results.length) return text("No matches in the mirror (it holds recent notices; the site searches the full record).");
      return text(res.results.map(fmtRecord).join("\n\n"));
    }
    case "get_notice": {
      if (!env.DB) return toolError("The notices mirror is unavailable right now.");
      const id = String(args.request_id || "").trim();
      if (!id) return toolError("request_id is required.");
      const row = await env.DB.prepare("SELECT * FROM notices WHERE request_id = ?").bind(id).first();
      if (!row) return text(`No notice ${id} in the mirror. Full record: https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`);
      return text(JSON.stringify(toRecord(row), null, 1));
    }
    case "preview_watch": {
      const lens = String(args.lens || "");
      if (!SUBSCRIBABLE.has(lens)) return toolError("lens must be one of: " + [...SUBSCRIBABLE].join(", "));
      const p = await runPreview(env, lens, String(args.request || ""));
      if (p.error) return toolError(p.error);
      return text(previewText(p));
    }
    case "create_watch": {
      if (!env.TOKEN_SECRET || !env.RESEND_API_KEY) return toolError("Watch creation isn't configured on this deployment.");
      const email = String(args.email || "").trim();
      const lens = String(args.lens || "");
      if (!isValidEmail(email)) return toolError("A valid email address is required.");
      if (!SUBSCRIBABLE.has(lens)) return toolError("lens must be one of: " + [...SUBSCRIBABLE].join(", "));
      // Same per-address ceiling as the web form — confirm emails cost sends.
      if (await overActorLimit(env.SUBS, "mcpsub", email, 5)) return toolError("Daily limit reached for that address — try tomorrow.");
      const p = await runPreview(env, lens, String(args.request || ""));
      if (p.error) return toolError(p.error);
      const sub = buildSubscription({ email, lens, filter: p.filter, freq: args.freq === "weekly" ? "weekly" : "daily" });
      const token = await signToken(env.TOKEN_SECRET, { e: sub.email, l: lens, f: p.filter, c: "email", q: sub.freq }, { ttlSeconds: CONFIRM_TTL });
      const base = env.CONFIRM_BASE || new URL(req.url).origin;
      const confirmUrl = `${base}/confirm?token=${encodeURIComponent(token)}`;
      try {
        await sendConfirm(env, sub.email, lens, p.filter, sub.freq, confirmUrl);
      } catch {
        return toolError("The confirmation email couldn't be sent — try again later.");
      }
      return text(`Understood as: ${p.label} (${sub.freq}).\nA confirmation email was sent to ${sub.email} — the watch starts only after it's confirmed (double opt-in).\n\n${previewText(p)}`);
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function rpc(id, result, error) {
  return error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
}

export async function handleMcp(req, env) {
  if (env.MCP_BEARER_TOKEN) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${env.MCP_BEARER_TOKEN}`) return new Response("Unauthorized", { status: 401 });
  }
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // Cheap per-IP daily ceiling before any work (public endpoint, no Turnstile here).
  const ip = req.headers.get("CF-Connecting-IP") || "";
  const ipCap = Number(env.MCP_MAX_PER_IP_DAY) || 300;
  if (await overActorLimit(env.SUBS, "mcpip", ip, ipCap)) {
    return Response.json(rpc(null, undefined, { code: -32000, message: "Daily request limit reached." }), { status: 429 });
  }

  let msg;
  try {
    msg = await req.json();
  } catch {
    return Response.json(rpc(null, undefined, { code: -32700, message: "Parse error" }), { status: 400 });
  }
  const { id, method, params } = msg || {};

  // Notifications (no id) — acknowledge, no body.
  if (id === undefined || id === null) return new Response(null, { status: 202 });

  try {
    switch (method) {
      case "initialize":
        return Response.json(rpc(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "crol-list", version: "1.0.0" },
        }));
      case "ping":
        return Response.json(rpc(id, {}));
      case "tools/list":
        return Response.json(rpc(id, { tools: TOOLS }));
      case "tools/call": {
        const name = String(params?.name || "");
        const args = (params?.arguments) || {};
        const result = await callTool(env, req, name, args);
        return Response.json(rpc(id, result));
      }
      default:
        return Response.json(rpc(id, undefined, { code: -32601, message: `Method not found: ${method}` }));
    }
  } catch (e) {
    return Response.json(rpc(id, undefined, { code: -32603, message: String(e?.message || e) }));
  }
}
