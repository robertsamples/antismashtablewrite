/** Build the .xlsx workbook from the rows produced by lib/antismash.js. */

import ExcelJS from "exceljs";

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E5F" } };
const HEADER_FONT = { bold: true, color: { argb: "FFFFFFFF" } };

const REGION_COLUMNS = [
  { header: "Region", key: "region", width: 10 },
  { header: "Record / contig", key: "record", width: 18 },
  { header: "Cluster class", key: "clusterClass", width: 26 },
  { header: "Category", key: "categories", width: 16 },
  { header: "Start", key: "start", width: 12, style: { numFmt: "#,##0" } },
  { header: "End", key: "end", width: 12, style: { numFmt: "#,##0" } },
  { header: "Length (bp)", key: "length", width: 13, style: { numFmt: "#,##0" } },
  { header: "Genes", key: "genes", width: 8 },
  { header: "Protoclusters", key: "protoclusters", width: 13 },
  { header: "On contig edge", key: "contigEdge", width: 14 },
  { header: "Most similar known cluster", key: "mostSimilarKnownCluster", width: 34 },
  { header: "MIBiG BGC", key: "mibigId", width: 15 },
  { header: "Known cluster type", key: "knownClusterType", width: 20 },
  { header: "Similarity (%)", key: "knownSimilarity", width: 13 },
  { header: "Similarity confidence", key: "similarityConfidence", width: 19 },
  { header: "Best ClusterBlast hit", key: "clusterblastHit", width: 42 },
  { header: "ClusterBlast accession", key: "clusterblastAccession", width: 20 },
  { header: "ClusterBlast similarity (%)", key: "clusterblastSimilarity", width: 22 },
  { header: "Best subcluster hit", key: "subclusterHit", width: 26 },
  { header: "Subcluster similarity (%)", key: "subclusterSimilarity", width: 21 },
  { header: "Link", key: "url", width: 30 },
];

const HIT_COLUMNS = [
  { header: "Region", key: "region", width: 10 },
  { header: "Record / contig", key: "record", width: 18 },
  { header: "Cluster class", key: "clusterClass", width: 24 },
  { header: "Rank", key: "rank", width: 7 },
  { header: "MIBiG BGC", key: "accession", width: 15 },
  { header: "Known cluster", key: "description", width: 40 },
  { header: "Known cluster type", key: "type", width: 20 },
  { header: "Similarity (%)", key: "similarity", width: 13 },
];

function styleHeader(sheet, columnCount) {
  const header = sheet.getRow(1);
  header.font = HEADER_FONT;
  header.fill = HEADER_FILL;
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 28;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columnCount },
  };
}

function addRegionsSheet(book, rows) {
  const sheet = book.addWorksheet("Regions", {
    properties: { defaultRowHeight: 16 },
  });
  sheet.columns = REGION_COLUMNS;

  for (const row of rows) {
    const added = sheet.addRow({
      ...row,
      contigEdge: row.onContigEdge ? "yes" : "no",
    });
    const linkCell = added.getCell("url");
    if (row.url) {
      linkCell.value = { text: "open region", hyperlink: row.url };
      linkCell.font = { color: { argb: "FF0563C1" }, underline: true };
    }
    const mibigCell = added.getCell("mibigId");
    if (row.mibigId && /^BGC\d/i.test(row.mibigId)) {
      mibigCell.value = {
        text: row.mibigId,
        hyperlink: "https://mibig.secondarymetabolites.org/go/" + row.mibigId,
      };
      mibigCell.font = { color: { argb: "FF0563C1" }, underline: true };
    }
    if (row.onContigEdge) {
      added.getCell("contigEdge").font = { color: { argb: "FFB35C00" } };
    }
  }

  styleHeader(sheet, REGION_COLUMNS.length);
  return sheet;
}

function addKnownHitsSheet(book, rows) {
  const hits = rows.flatMap((row) =>
    (row.knownHits || []).map((hit) => ({
      region: row.region,
      record: row.record,
      clusterClass: row.clusterClass,
      ...hit,
    })),
  );
  if (!hits.length) return null;

  const sheet = book.addWorksheet("Known cluster hits");
  sheet.columns = HIT_COLUMNS;
  for (const hit of hits) {
    const added = sheet.addRow(hit);
    const cell = added.getCell("accession");
    if (hit.accession && /^BGC\d/i.test(hit.accession)) {
      cell.value = {
        text: hit.accession,
        hyperlink: "https://mibig.secondarymetabolites.org/go/" + hit.accession,
      };
      cell.font = { color: { argb: "FF0563C1" }, underline: true };
    }
  }
  styleHeader(sheet, HIT_COLUMNS.length);
  return sheet;
}

function addJobSheet(book, job) {
  const sheet = book.addWorksheet("Job info");
  sheet.columns = [
    { header: "Field", key: "field", width: 24 },
    { header: "Value", key: "value", width: 80 },
  ];
  const entries = [
    ["Job", job.jobId],
    ["Results URL", job.indexUrl],
    ["antiSMASH version", job.antismashVersion],
    ["Input file", job.inputFile],
    ["Detection strictness", job.strictness],
    ["Records in input", job.records],
    ["Records with regions", job.recordsWithRegions],
    ["Regions found", job.regions],
    ["Parsed from", job.source],
    ["Retrieved at (UTC)", job.retrievedAt],
  ];
  for (const [field, value] of entries) {
    sheet.addRow({ field, value: value === null || value === undefined ? "" : value });
  }
  const header = sheet.getRow(1);
  header.font = HEADER_FONT;
  header.fill = HEADER_FILL;
  return sheet;
}

/** Returns a Node Buffer holding the .xlsx file. */
export async function buildWorkbookBuffer({ job, rows }) {
  const book = new ExcelJS.Workbook();
  book.creator = "antismash-table-write";
  book.created = new Date();

  addRegionsSheet(book, rows);
  addKnownHitsSheet(book, rows);
  addJobSheet(book, job);

  const data = await book.xlsx.writeBuffer();
  return Buffer.from(data);
}

export function suggestedFilename(job) {
  const safe = String(job.jobId || "antismash").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  return "antismash-" + safe + "-regions.xlsx";
}
