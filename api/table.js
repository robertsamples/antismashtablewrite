/**
 * GET /api/table?url=<antiSMASH results URL>[&format=json]
 *
 * Vercel-style handler (req, res). server.js reuses it for plain Node hosting.
 */

import { collectJob, HttpError } from "../lib/antismash.js";
import { buildWorkbookBuffer, suggestedFilename } from "../lib/workbook.js";

function readParams(req) {
  if (req.query && typeof req.query === "object" && !Array.isArray(req.query)) {
    return {
      url: req.query.url,
      format: req.query.format,
      filename: req.query.filename,
    };
  }
  const parsed = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));
  return {
    url: parsed.searchParams.get("url"),
    format: parsed.searchParams.get("format"),
    filename: parsed.searchParams.get("filename"),
  };
}

export default async function handler(req, res) {
  if (req.method && !["GET", "HEAD", "POST"].includes(req.method)) {
    res.statusCode = 405;
    res.setHeader("allow", "GET, HEAD, POST");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const { url, format, filename } = readParams(req);

  // A binary download is noise in a search index, and a crawler walking ?url= variants would
  // fire real requests at the antiSMASH servers. Keep this endpoint out of the index.
  res.setHeader("x-robots-tag", "noindex, nofollow");

  try {
    const result = await collectJob(url);

    if (String(format || "").toLowerCase() === "json") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "public, max-age=0, s-maxage=3600");
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    const buffer = await buildWorkbookBuffer(result);
    const name = (filename || suggestedFilename(result.job)).replace(/[^A-Za-z0-9._-]+/g, "-");

    res.statusCode = 200;
    res.setHeader(
      "content-type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("content-disposition", 'attachment; filename="' + name + '"');
    res.setHeader("content-length", String(buffer.length));
    res.setHeader("cache-control", "public, max-age=0, s-maxage=3600");
    res.end(req.method === "HEAD" ? undefined : buffer);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : "Unexpected error building the table.";
    if (status >= 500) console.error(err);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: message }));
  }
}
