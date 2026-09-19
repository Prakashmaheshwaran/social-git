import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

interface Asset { body: Buffer; contentType: string; cacheControl: string }

const asset = (path: string, contentType: string, cacheControl = "public, max-age=300"): Asset => ({
  body: readFileSync(new URL(`../web/${path}`, import.meta.url)),
  contentType,
  cacheControl,
});

const index = asset("index.html", "text/html; charset=utf-8", "no-store");
const apiDocs = asset("api-docs.html", "text/html; charset=utf-8", "no-store");
const assets = new Map<string, Asset>([
  ["/app/assets/app.js", asset("app.js", "text/javascript; charset=utf-8")],
  ["/app/assets/client.js", asset("client.js", "text/javascript; charset=utf-8")],
  ["/app/assets/view.js", asset("view.js", "text/javascript; charset=utf-8")],
  ["/app/assets/one-time-secrets.js", asset("one-time-secrets.js", "text/javascript; charset=utf-8")],
  ["/app/assets/styles.css", asset("styles.css", "text/css; charset=utf-8")],
  ["/docs/assets/api-docs.js", asset("api-docs.js", "text/javascript; charset=utf-8")],
  ["/docs/assets/api-docs-view.js", asset("api-docs-view.js", "text/javascript; charset=utf-8")],
  ["/docs/assets/api-docs.css", asset("api-docs.css", "text/css; charset=utf-8")],
]);

/** Serve only the product UI namespace. API and probe routes remain untouched. */
export function serveWebApplication(request: IncomingMessage, response: ServerResponse, pathname: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (pathname === "/") {
    response.statusCode = 302;
    response.setHeader("location", "/app/");
    response.setHeader("cache-control", "no-store");
    response.end();
    return true;
  }
  if (pathname === "/app") {
    response.statusCode = 308;
    response.setHeader("location", "/app/");
    response.end();
    return true;
  }
  if (pathname === "/docs") {
    response.statusCode = 308;
    response.setHeader("location", "/docs/");
    response.end();
    return true;
  }
  const selected = assets.get(pathname)
    ?? (["/app/", "/app/index.html"].includes(pathname) ? index : undefined)
    ?? (["/docs/", "/docs/index.html"].includes(pathname) ? apiDocs : undefined);
  if (!selected) return false;
  response.statusCode = 200;
  response.setHeader("content-type", selected.contentType);
  response.setHeader("content-length", selected.body.byteLength);
  response.setHeader("cache-control", selected.cacheControl);
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  if (request.method === "HEAD") response.end();
  else response.end(selected.body);
  return true;
}
