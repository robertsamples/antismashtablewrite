#!/usr/bin/env node
/**
 * Local use:
 *   node cli.js <antiSMASH results URL> [-o output.xlsx] [--json]
 */

import { writeFile } from "node:fs/promises";
import { collectJob, HttpError } from "./lib/antismash.js";
import { buildWorkbookBuffer, suggestedFilename } from "./lib/workbook.js";

function parseArgs(argv) {
  const args = { url: "", out: "", json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--out") args.out = argv[++i] || "";
    else if (arg === "--json") args.json = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else if (!args.url) args.url = arg;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    console.log("Usage: node cli.js <antiSMASH results URL> [-o output.xlsx] [--json]");
    process.exit(args.help ? 0 : 1);
  }

  const result = await collectJob(args.url);

  if (args.json) {
    const out = args.out || "antismash-" + result.job.jobId + "-regions.json";
    await writeFile(out, JSON.stringify(result, null, 2));
    console.log("Wrote " + out + " (" + result.rows.length + " regions)");
    return;
  }

  const buffer = await buildWorkbookBuffer(result);
  const out = args.out || suggestedFilename(result.job);
  await writeFile(out, buffer);
  console.log(
    "Wrote " + out + " - " + result.rows.length + " regions across " +
      result.job.recordsWithRegions + " records (antiSMASH " +
      (result.job.antismashVersion || "unknown version") + ")",
  );
}

main().catch((err) => {
  console.error(err instanceof HttpError ? "Error: " + err.message : err);
  process.exit(1);
});
