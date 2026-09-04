/**
 * Plain Node host (Render, Fly, Railway, a VM, `node server.js` locally).
 * Serves public/ and routes /api/table to the same handler Vercel uses.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import handler from "./api/table.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

async function serveStatic(req, res, pathname) {
  const rel = normalize(pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
  if (rel.startsWith("..")) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(join(PUBLIC_DIR, rel));
    res.statusCode = 200;
    res.setHeader("content-type", MIME[extname(rel)] || "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Not found");
  }
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));
  if (pathname === "/api/table") return handler(req, res);
  return serveStatic(req, res, pathname);
}).listen(PORT, () => {
  console.log("antismash-table-write listening on http://localhost:" + PORT);
});
