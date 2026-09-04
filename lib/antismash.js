/**
 * Fetch an antiSMASH results job and turn its regions (gene clusters) into flat rows.
 *
 * An antiSMASH output directory contains:
 *   index.html  - the report, including the per-record overview table and the region pages
 *   regions.js  - `recordData` (region coordinates/products/ORFs) and `resultsData`
 *                 (per-region module results, incl. ClusterBlast / KnownClusterBlast hits)
 *
 * regions.js is the authoritative, machine-readable source; index.html supplies the few
 * things it does not carry (similarity confidence, contig-edge warnings, record labels).
 * If regions.js cannot be read, the rows are rebuilt from index.html alone.
 */

import * as cheerio from "cheerio";

const FETCH_TIMEOUT_MS = Number(process.env.ANTISMASH_FETCH_TIMEOUT_MS || 45000);
const MAX_BYTES = Number(process.env.ANTISMASH_MAX_BYTES || 200 * 1024 * 1024);

/** Hostnames that must never be fetched (SSRF guard for the hosted endpoint). */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.(local|internal|localdomain)$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,
];

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function assertHostAllowed(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowList = (process.env.ANTISMASH_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowList.length) {
    const ok = allowList.some((h) => host === h || host.endsWith("." + h));
    if (!ok) throw new HttpError(403, "Host not allowed: " + hostname);
    return;
  }
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) {
    throw new HttpError(403, "Refusing to fetch a private or local address: " + hostname);
  }
}

/**
 * Accepts anything that points at a job: the index.html, the bare directory, or any
 * sibling file (the .gbk/.json/.zip download links people tend to copy).
 */
export function normalizeJobUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new HttpError(400, "No antiSMASH URL given.");
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, "Not a valid URL: " + raw);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "Only http:// and https:// URLs are supported.");
  }
  assertHostAllowed(url.hostname);

  url.hash = "";
  url.search = "";
  const segments = url.pathname.split("/");
  const last = segments[segments.length - 1];
  if (last.includes(".")) segments[segments.length - 1] = "";
  else if (last !== "") segments.push("");
  url.pathname = segments.join("/");

  const jobId = segments.filter(Boolean).pop() || url.hostname;
  return {
    baseUrl: url.toString(),
    indexUrl: new URL("index.html", url).toString(),
    regionsUrl: new URL("regions.js", url).toString(),
    jobId,
  };
}

async function fetchText(url, { optional = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "antismash-table-write/1.0 (+xlsx export)" },
    });
    if (!res.ok) {
      if (optional) return null;
      throw new HttpError(
        res.status === 404 ? 404 : 502,
        "Could not fetch " + url + " (HTTP " + res.status + "). Is that an antiSMASH results URL?",
      );
    }
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared && declared > MAX_BYTES) {
      if (optional) return null;
      throw new HttpError(413, url + " is " + declared + " bytes, over the " + MAX_BYTES + " byte limit.");
    }
    const text = await res.text();
    if (text.length > MAX_BYTES) {
      if (optional) return null;
      throw new HttpError(413, url + " is larger than the " + MAX_BYTES + " byte limit.");
    }
    return text;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (optional) return null;
    const why = err && err.name === "AbortError" ? "timed out after " + FETCH_TIMEOUT_MS + " ms" : err.message;
    throw new HttpError(504, "Could not fetch " + url + ": " + why);
  } finally {
    clearTimeout(timer);
  }
}

/** Slice a balanced {...} / [...] literal starting at `start`, ignoring brackets in strings. */
function sliceBalanced(src, start) {
  const open = src[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

function extractVar(source, name) {
  const re = new RegExp("(?:^|[;\\n])\\s*(?:var|let|const)\\s+" + name + "\\s*=\\s*");
  const match = re.exec(source);
  if (!match) return null;
  let i = match.index + match[0].length;
  while (i < source.length && /\s/.test(source[i])) i++;
  if (source[i] !== "{" && source[i] !== "[") return null;
  const raw = sliceBalanced(source, i);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function textOf($, node) {
  return $(node).text().replace(/\s+/g, " ").trim();
}

/**
 * Pull what only the HTML knows: the overview table (similarity confidence, and the MIBiG
 * hit as antiSMASH itself picked it) plus the per-region contig-edge warning.
 */
export function parseIndexHtml(html) {
  const $ = cheerio.load(html);
  const overview = new Map();

  $("table.region-table tbody tr").each((_, tr) => {
    const row = $(tr);
    let anchor = (row.attr("data-anchor") || "").replace(/^#/, "");
    const regionLink = row.find('td a[href^="#"]').first();
    if (!anchor) anchor = (regionLink.attr("href") || "").replace(/^#/, "");
    if (!anchor || overview.has(anchor)) return;

    const cells = row.find("td");
    const mibigLink = row.find('a[href*="mibig"]').first();
    const mibigHref = mibigLink.attr("href") || "";
    const record = row
      .closest(".record-overview-details")
      .prevAll(".record-overview-header")
      .first()
      .find("strong")
      .first()
      .text()
      .trim();

    overview.set(anchor, {
      anchor,
      regionLabel: textOf($, regionLink).replace(/^Region\s*/i, ""),
      recordLabel: record || "",
      type: textOf($, cells.eq(1)),
      similarity: textOf($, row.find("td.similarity-text")),
      knownClusterName: textOf($, mibigLink),
      mibigId: mibigHref ? mibigHref.split("/").filter(Boolean).pop() : "",
      knownClusterType: mibigLink.length ? textOf($, cells.last()) : "",
      start: parseCoord(textOf($, cells.eq(2))),
      end: parseCoord(textOf($, cells.eq(3))),
    });
  });

  const contigEdge = new Set();
  $("div.page[id]").each((_, div) => {
    const id = $(div).attr("id");
    if (id && id !== "overview" && $(div).find(".contig-edge-warning").length) contigEdge.add(id);
  });

  const bodyText = $.root().text();
  const versionMatch = /antiSMASH\s+version\s+([\w.-]+)/i.exec(bodyText);
  const strictnessMatch = /using strictness\s*'([^']+)'/i.exec(bodyText);
  const inputFile = $('a[href$=".gbk"], a[href$=".gbff"], a[href$=".embl"]').first().attr("href") || "";

  return {
    overview,
    contigEdge,
    version: versionMatch ? versionMatch[1] : "",
    inputFile: inputFile ? decodeURIComponent(inputFile.split("/").pop()) : "",
    strictness: strictnessMatch ? strictnessMatch[1] : "",
  };
}

function parseCoord(text) {
  const digits = (text || "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

/** ClusterBlast results moved around between antiSMASH versions; accept either shape. */
function clusterblastVariants(regionResults) {
  const cb = regionResults && regionResults["antismash.modules.clusterblast"];
  const variants = {};
  if (!cb) return variants;
  if (Array.isArray(cb.references)) {
    for (const ref of cb.references) {
      if (ref && ref.variant_name) {
        variants[ref.variant_name] = Array.isArray(ref.matches) ? ref.matches : [];
      }
    }
  }
  for (const key of ["clusterblast", "knownclusterblast", "subclusterblast"]) {
    if (!variants[key] && Array.isArray(cb[key])) variants[key] = cb[key];
  }
  return variants;
}

/** "BGC0000271.5: spore pigment" -> "spore pigment" */
function cleanHitLabel(label) {
  return String(label || "").replace(/^\s*[A-Za-z0-9_.]+\s*:\s*/, "").trim();
}

/** BGC0000271.5 and BGC0000271 refer to the same MIBiG entry. */
function sameBgc(a, b) {
  if (!a || !b) return false;
  return String(a).split(".")[0].toLowerCase() === String(b).split(".")[0].toLowerCase();
}

function anchorFor(region, recordIndex) {
  return region.anchor || "r" + recordIndex + "c" + region.idx;
}

function buildRow({ region, recordIndex, seqId, recordLength, meta, regionResults }) {
  const anchor = anchorFor(region, recordIndex);
  const ov = meta.overview.get(anchor) || {};
  const variants = clusterblastVariants(regionResults);
  const knownHits = variants.knownclusterblast || [];
  // The overview names the cluster antiSMASH itself picked; take that same cluster's
  // similarity rather than KnownClusterBlast's top-ranked hit, which can be a different BGC.
  const topRanked = knownHits[0] || null;
  const namedHit = ov.mibigId ? knownHits.find((hit) => sameBgc(hit.accession, ov.mibigId)) : null;
  const known = namedHit || (ov.mibigId ? null : topRanked);
  const general = (variants.clusterblast || [])[0] || null;
  const sub = (variants.subclusterblast || [])[0] || null;
  const products =
    Array.isArray(region.products) && region.products.length
      ? region.products
      : region.type
        ? String(region.type).split(",").map((p) => p.trim())
        : [];

  return {
    anchor,
    region: ov.regionLabel || recordIndex + "." + region.idx,
    record: seqId || ov.recordLabel || String(recordIndex),
    recordIndex,
    regionIndex: region.idx,
    recordLength: recordLength == null ? null : recordLength,
    clusterClass: products.join(", ") || ov.type || "",
    categories: (region.product_categories || []).join(", "),
    start: region.start == null ? ov.start ?? null : region.start,
    end: region.end == null ? ov.end ?? null : region.end,
    length: region.start != null && region.end != null ? region.end - region.start : null,
    genes: Array.isArray(region.orfs) ? region.orfs.length : null,
    protoclusters: Array.isArray(region.clusters) ? region.clusters.length : null,
    onContigEdge: meta.contigEdge.has(anchor),
    similarityConfidence: ov.similarity || "",
    mostSimilarKnownCluster: ov.knownClusterName || (topRanked ? cleanHitLabel(topRanked.label) : ""),
    mibigId: ov.mibigId || (topRanked ? topRanked.accession : ""),
    knownClusterType: ov.knownClusterType || (topRanked ? topRanked.product : ""),
    knownSimilarity: known && typeof known.similarity === "number" ? known.similarity : null,
    clusterblastHit: general ? cleanHitLabel(general.label) : "",
    clusterblastAccession: general ? general.accession : "",
    clusterblastSimilarity: general && typeof general.similarity === "number" ? general.similarity : null,
    subclusterHit: sub ? cleanHitLabel(sub.label) : "",
    subclusterSimilarity: sub && typeof sub.similarity === "number" ? sub.similarity : null,
    url: meta.indexUrl + "#" + anchor,
    knownHits: (variants.knownclusterblast || []).map((hit, i) => ({
      rank: i + 1,
      accession: hit.accession || "",
      description: cleanHitLabel(hit.label),
      type: hit.product || "",
      similarity: typeof hit.similarity === "number" ? hit.similarity : null,
    })),
  };
}

/** Fallback when regions.js is missing: everything the overview table can give us. */
function rowsFromOverviewOnly(meta) {
  return [...meta.overview.values()].map((ov) => {
    const parsed = /^r(\d+)c(\d+)$/.exec(ov.anchor) || [];
    return {
      anchor: ov.anchor,
      region: ov.regionLabel || ov.anchor,
      record: ov.recordLabel || parsed[1] || "",
      recordIndex: parsed[1] ? Number(parsed[1]) : null,
      regionIndex: parsed[2] ? Number(parsed[2]) : null,
      recordLength: null,
      clusterClass: ov.type || "",
      categories: "",
      start: ov.start ?? null,
      end: ov.end ?? null,
      length: ov.start != null && ov.end != null ? ov.end - ov.start : null,
      genes: null,
      protoclusters: null,
      onContigEdge: meta.contigEdge.has(ov.anchor),
      similarityConfidence: ov.similarity || "",
      mostSimilarKnownCluster: ov.knownClusterName || "",
      mibigId: ov.mibigId || "",
      knownClusterType: ov.knownClusterType || "",
      knownSimilarity: null,
      clusterblastHit: "",
      clusterblastAccession: "",
      clusterblastSimilarity: null,
      subclusterHit: "",
      subclusterSimilarity: null,
      url: meta.indexUrl + "#" + ov.anchor,
      knownHits: [],
    };
  });
}

/**
 * Fetch a job and return { job, rows }; `rows` holds one entry per region, in report order.
 */
export async function collectJob(rawUrl) {
  const { baseUrl, indexUrl, regionsUrl, jobId } = normalizeJobUrl(rawUrl);

  const [html, regionsJs] = await Promise.all([
    fetchText(indexUrl),
    fetchText(regionsUrl, { optional: true }),
  ]);

  if (!/antismash/i.test(html)) {
    throw new HttpError(422, indexUrl + " does not look like an antiSMASH report.");
  }

  const meta = { ...parseIndexHtml(html), indexUrl };

  const recordData = regionsJs ? extractVar(regionsJs, "recordData") : null;
  const resultsData = (regionsJs ? extractVar(regionsJs, "resultsData") : null) || {};

  let rows;
  if (Array.isArray(recordData)) {
    rows = [];
    recordData.forEach((record, i) => {
      const recordIndex = i + 1;
      for (const region of record.regions || []) {
        rows.push(
          buildRow({
            region,
            recordIndex,
            seqId: record.seq_id,
            recordLength: record.length,
            meta,
            regionResults: resultsData[anchorFor(region, recordIndex)],
          }),
        );
      }
    });
  } else {
    rows = rowsFromOverviewOnly(meta);
  }

  if (!rows.length) {
    throw new HttpError(422, "No secondary metabolite regions were found in that job.");
  }

  return {
    job: {
      jobId,
      baseUrl,
      indexUrl,
      antismashVersion: meta.version,
      inputFile: meta.inputFile,
      strictness: meta.strictness,
      records: Array.isArray(recordData) ? recordData.length : null,
      recordsWithRegions: new Set(rows.map((r) => r.record)).size,
      regions: rows.length,
      source: Array.isArray(recordData) ? "regions.js + index.html" : "index.html only",
      retrievedAt: new Date().toISOString(),
    },
    rows,
  };
}
