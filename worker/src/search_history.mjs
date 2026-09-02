// GET|POST /search-history — a recognized account's own recent searches.
//
// Modeled on /following/personal: credentialed allowlisted CORS, identity from
// the existing email session, no second login path, and no browser-supplied
// account selector. The reader's browser asks about "my" history and the Worker
// decides whose that is.
//
// The route is a continuation of Search, never a dependency of it. Every failure
// mode — anonymous, expired recognition, missing cookie, unavailable storage,
// malformed stored state — answers promptly with an empty, bounded body so the
// browser can fall back to its own local behavior.
//
// What crosses back to the browser is deliberately small: query text, place
// context, a canonical Search URL, and when the search ran. Never the email,
// the subscriber id, the visitor id, a network observation, a stored result
// list, or any operator field.

import {
  SEARCH_HISTORY_MAX_ENTRIES,
  SEARCH_HISTORY_MAX_REQUEST_BYTES,
  SEARCH_HISTORY_SCHEMA,
  normalizeSearchHistoryRequest,
  projectSearchHistoryEntry,
} from "../../capabilities/search_history.mjs";
import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { readSearchHistory, mutateSearchHistory } from "./lib/search_history.mjs";
import { deriveSubscriberId } from "./lib/subscriptions.mjs";
import { emailFromRequest } from "./session.mjs";

const CORS_OPTS = Object.freeze({
  methods: "GET, POST, OPTIONS",
  headers: "Content-Type",
  maxAge: "86400",
  credentials: true,
});

/**
 * `Vary: Origin, Cookie` is what keeps a shared cache from ever handing one
 * reader's history to another; `no-store` is what keeps it out of a cache in
 * the first place. Both are stated on every response, including the failures.
 */
function historyHeaders(cors) {
  return new Headers({
    ...cors,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Origin, Cookie",
  });
}

function historyResponse(body, status, cors) {
  return new Response(JSON.stringify(body), { status, headers: historyHeaders(cors) });
}

function payload({ ok, state, entries = [], reason = null }) {
  const body = {
    ok,
    schema: SEARCH_HISTORY_SCHEMA,
    state,
    limit: SEARCH_HISTORY_MAX_ENTRIES,
    entries: entries.map(projectSearchHistoryEntry),
  };
  if (reason) body.reason = reason;
  return body;
}

/**
 * Resolve the account from the existing session. A recognition failure is
 * indistinguishable from being anonymous on purpose: the route must never
 * become an oracle for whether a given browser holds a valid session.
 */
async function recognizedSubscriber(req, env) {
  try {
    const email = await emailFromRequest(req, env);
    if (!email) return null;
    return await deriveSubscriberId(email);
  } catch {
    return null;
  }
}

async function readBody(req) {
  const declaredLength = Number(req.headers.get("Content-Length") || 0);
  if (declaredLength > SEARCH_HISTORY_MAX_REQUEST_BYTES) return { reason: "too-large" };
  let raw;
  try {
    raw = await req.text();
  } catch {
    return { reason: "unreadable" };
  }
  // An undeclared oversized payload is bounded by the same ceiling.
  if (raw.length > SEARCH_HISTORY_MAX_REQUEST_BYTES) return { reason: "too-large" };
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { reason: "bad-json" };
  }
}

export async function handleSearchHistory(req, env) {
  const origin = req.headers.get("Origin") || req.headers.get("origin") || "";
  const cors = corsHeaders(origin, env, CORS_OPTS);
  if (!isAllowedRequestOrigin(origin, env)) {
    return historyResponse(payload({ ok: false, state: "unavailable", reason: "origin" }), 403, cors);
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: historyHeaders(cors) });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    const response = historyResponse(
      payload({ ok: false, state: "unavailable", reason: "method" }),
      405,
      cors,
    );
    response.headers.set("Allow", "GET, POST, OPTIONS");
    return response;
  }

  // A malformed body is rejected before the session is read, so an unparseable
  // request can never be used to probe whether this browser is recognized.
  let request = null;
  if (req.method === "POST") {
    const body = await readBody(req);
    if (body.reason) {
      return historyResponse(
        payload({ ok: false, state: "unavailable", reason: body.reason }),
        body.reason === "too-large" ? 413 : 400,
        cors,
      );
    }
    request = normalizeSearchHistoryRequest(body.value);
    if (!request.ok) {
      return historyResponse(
        payload({ ok: false, state: "unavailable", reason: request.reason }),
        400,
        cors,
      );
    }
  }

  const subscriberId = await recognizedSubscriber(req, env);
  if (!subscriberId) {
    // Anonymous, expired, or missing cookie: the reader keeps local behavior and
    // nothing is written. Recognition is the authorization boundary, so a search
    // run in this state is not this account's search and never becomes one.
    return historyResponse(payload({ ok: true, state: "unrecognized" }), 200, cors);
  }

  const nowMs = Date.now();
  if (req.method === "GET") {
    const current = await readSearchHistory(env, subscriberId, { nowMs });
    if (!current.available) {
      return historyResponse(payload({ ok: false, state: "unavailable", reason: "storage" }), 200, cors);
    }
    return historyResponse(payload({ ok: true, state: "recognized", entries: current.entries }), 200, cors);
  }

  const result = await mutateSearchHistory(env, subscriberId, request, { nowMs });
  if (!result.stored) {
    // The change did not land. Say so rather than echoing an accepted-looking
    // body: a browser that believes a removal succeeded would show it again.
    return historyResponse(
      payload({ ok: false, state: "unavailable", reason: "storage", entries: result.entries }),
      200,
      cors,
    );
  }
  return historyResponse(payload({ ok: true, state: "recognized", entries: result.entries }), 200, cors);
}
