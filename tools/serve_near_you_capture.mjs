import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { handleNearYou } from "../worker/src/near_you.mjs";
import { buildNearYou } from "./build_worker_route_read_models.mjs";

const root = join(process.cwd(), "site");
// Exercise the same retained membership slices as the deployed route, not its
// tiny no-binding floor fixture (which cannot prove neighborhood relevance).
const activity = JSON.parse(await readFile(join(root, "data/district_activity.json"), "utf8"));
const geography = JSON.parse(await readFile(join(root, "data/community_board_geography_lookup.json"), "utf8"));
const materialized = buildNearYou(activity, geography, "capture");
const values = new Map(materialized.entries.map(({key, value}) => [key, value]));
values.set("route-read-model:near-you:manifest:v1", JSON.stringify(materialized.manifest));
const env = { ALERT_STATE: { get: async (key) => values.get(key) ?? null } };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/near-you" || url.pathname === "/near-you/" || url.pathname === "/near-you/deferred.json") {
    const upstream = await handleNearYou(new Request(url, { method: request.method }), env);
    let body = request.method === "HEAD" ? "" : await upstream.text();
    const base = `http://${request.headers.host}`;
    body = body.replaceAll("https://cityscroll.org", base);
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    response.end(body);
    return;
  }
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "").replace(/^([.][.][/\\])+/, "");
  try {
    const body = await readFile(join(root, relative === "/" ? "index.html" : relative));
    const contentType = /\.(mjs|js)$/.test(url.pathname)
      ? "text/javascript"
      : url.pathname.endsWith(".css")
        ? "text/css"
        : url.pathname.endsWith(".json")
          ? "application/json"
          : url.pathname.endsWith(".pbf") ? "application/x-protobuf" : "text/html";
    response.writeHead(200, { "content-type": contentType });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(`http://127.0.0.1:${address.port}`);
});
