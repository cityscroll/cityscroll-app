import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { handleNearYou } from "../worker/src/near_you.mjs";

const root = join(process.cwd(), "site");
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/near-you" || url.pathname === "/near-you/" || url.pathname === "/near-you/deferred.json") {
    const upstream = await handleNearYou(new Request(url, { method: request.method }));
    let body = request.method === "HEAD" ? "" : await upstream.text();
    const base = `http://${request.headers.host}`;
    body = body.replaceAll("https://cityscroll.org", base);
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    response.end(body);
    return;
  }
  const relative = normalize(url.pathname).replace(/^[/\\]+/, "").replace(/^([.][.][/\\])+/, "");
  try {
    const body = await readFile(join(root, relative === "/" ? "index.html" : relative));
    const contentType = url.pathname.endsWith(".mjs")
      ? "text/javascript"
      : url.pathname.endsWith(".css")
        ? "text/css"
        : url.pathname.endsWith(".json")
          ? "application/json"
          : "text/html";
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
