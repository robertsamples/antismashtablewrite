# antismashtablewrite

Give it an antiSMASH results URL, get back an `.xlsx` table of the gene clusters (regions)
that antiSMASH found - coordinates, cluster class, the most similar known cluster, similarity,
and a few things that are otherwise only visible by clicking through the report.

Runs three ways from the same code: a Vercel serverless function, a plain Node server, or a
local CLI. Live at <https://www.robertsamples.com/antismashtableconverter/>.

Example job used during development:
<https://antismash.secondarymetabolites.org/upload/bacteria-15001a8d-4af1-4d12-8a32-88631711cb57/index.html>
(34 regions across 31 records, antiSMASH 8.0.4).

## Use it locally

```bash
npm install
node cli.js https://antismash.secondarymetabolites.org/upload/<job-id>/index.html
# -> antismash-<job-id>-regions.xlsx

node cli.js <url> -o clusters.xlsx     # choose the output file
node cli.js <url> --json -o rows.json  # raw parsed rows instead of a workbook
```

The index page, the bare job directory, or any download link inside the job all work as input.

## Run it as a web app

```bash
npm start                       # http://localhost:3000, form + /api/table
```

`GET /api/table?url=<antiSMASH URL>` streams the workbook back with a `Content-Disposition`
attachment header. Add `&format=json` to get the parsed rows as JSON instead, and
`&filename=foo.xlsx` to override the download name.

## Deploy

Target layout: the app runs on Vercel, and a Cloudflare Worker mounts it under a path of the
main site, so the public address is **`www.robertsamples.com/antismashtableconverter/`**. A
subdirectory rather than a subdomain, so the tool shares the main domain's search authority
instead of starting a new property from zero.

### 1. Vercel

The repo is already shaped the way Vercel expects: `public/` is served statically,
`api/table.js` becomes the serverless function, `vercel.json` raises its timeout to 60 s.

```bash
npx vercel        # preview
npx vercel --prod
```

Note the production URL it prints - that is the Worker's upstream.

### 2. Cloudflare Worker

[cloudflare/worker.js](cloudflare/worker.js) proxies `/antismashtableconverter/*` to that
deployment, stripping the prefix on the way. Set `UPSTREAM` at the top of the file to the
Vercel production URL, then either paste it into a new Worker in the dashboard and add the
routes `www.robertsamples.com/antismashtableconverter*` and
`robertsamples.com/antismashtableconverter*` (both hosts, so the apex does not miss), or:

```bash
cd cloudflare && npx wrangler deploy
```

The zone has to be proxied through Cloudflare (orange cloud) for a Worker route to fire.

Two details the Worker handles, both of which break the app if dropped: it redirects the bare
`/antismashtableconverter` to the trailing-slash form, and the page links to `api/table`
relatively rather than as `/api/table`. Together those keep the form working whether the app is
mounted at a path, at a domain root, or on `localhost:3000` - don't "fix" that action to an
absolute path.

### Anything else that runs Node 18+

Render, Railway, Fly, a VM, a container: `npm start` runs [server.js](server.js), which serves
`public/` and mounts the same handler at `/api/table`. It honours `PORT`.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTISMASH_ALLOWED_HOSTS` | *(unset)* | Comma-separated allow-list of hostnames the service may fetch. Recommended when the deployment is public: `antismash.secondarymetabolites.org`. |
| `ANTISMASH_FETCH_TIMEOUT_MS` | `45000` | Per-request fetch timeout. |
| `ANTISMASH_MAX_BYTES` | `209715200` | Refuse job files larger than this. |

With no allow-list set, requests to private/loopback/link-local addresses are refused
(`localhost`, `10.*`, `192.168.*`, `169.254.*`, `172.16-31.*`, `::1`, `.internal`, …) so the
endpoint cannot be used to probe the host's own network.

## Crawling and indexing

The landing page is written to be indexed - real copy, a canonical URL, a meta description,
and `WebApplication` structured data, all in server-rendered HTML with no JS-rendering barrier.
Three things still need doing outside this repo:

1. **Add the `Disallow` to the main site's robots.txt.** Only a robots.txt at a domain root is
   honoured, so [public/robots.txt](public/robots.txt) governs the `.vercel.app` origin, not the
   proxied path. `www.robertsamples.com/robots.txt` needs its own line:

   ```
   Disallow: /antismashtableconverter/api/
   ```

   The endpoint returns a binary download, and a crawler wandering into `?url=` variants would
   fire real requests at the antiSMASH servers on every hit. `api/table.js` also sets
   `X-Robots-Tag: noindex, nofollow` on every response, which holds regardless of robots.txt.

2. **Keep the internal link.** `/tools` already links here, which is the primary discovery
   path and the reason the subdirectory layout is worth the Worker at all.

3. **Add `https://www.robertsamples.com/antismashtableconverter/` to the main sitemap**, and keep
   the canonical tag in `public/index.html` pointing there. That tag is what stops the
   `.vercel.app` copy - which is publicly reachable and indexable - from competing with the
   real URL.

## What ends up in the workbook

**Sheet `Regions`** - one row per region:

| Column | Source |
| --- | --- |
| Region, Record / contig | region anchor + record `seq_id` |
| Cluster class, Category | `products` / `product_categories` (e.g. `T2PKS`, `PKS`) |
| Start, End, Length (bp) | region coordinates |
| Genes, Protoclusters | ORF count, protocluster count |
| On contig edge | the report's contig-edge warning - the region may be truncated |
| Most similar known cluster, MIBiG BGC, Known cluster type | the MIBiG hit antiSMASH names in the overview; falls back to the top-ranked KnownClusterBlast hit when the overview has no confident call |
| Similarity (%) | KnownClusterBlast similarity **for the cluster named in that row**, blank if antiSMASH named a cluster that KnownClusterBlast did not score |
| Similarity confidence | antiSMASH 8's High/Medium/Low label (empty on jobs from older versions, which print a percentage here instead) |
| Best ClusterBlast hit / accession / similarity | closest genome-database region |
| Best subcluster hit / similarity | SubClusterBlast |
| Link | deep link back to the region in the report |

**Sheet `Known cluster hits`** - every KnownClusterBlast hit per region, in antiSMASH's own
ranking (which weighs the number of matched genes, so rank 1 is not always the highest
similarity percentage - that is why the `Regions` sheet keeps name and percentage in step).

**Sheet `Job info`** - job id, results URL, antiSMASH version, input file, detection
strictness, record/region counts, and where the data was parsed from.

## How it works

[lib/antismash.js](lib/antismash.js) fetches two files from the job directory:

- `regions.js` - the machine-readable payload. `recordData` holds every region's
  coordinates, products, and ORFs; `resultsData` holds per-region module output, including
  the ClusterBlast / KnownClusterBlast / SubClusterBlast hit tables with similarity scores.
  Both are `var X = {...};` assignments, sliced out with a bracket matcher and `JSON.parse`d.
- `index.html` - for the handful of things `regions.js` does not carry: the overview table's
  similarity confidence and MIBiG pick, the per-region contig-edge warning, the antiSMASH
  version and input filename.

If `regions.js` is missing or unparsable the rows are rebuilt from the overview table alone
(fewer columns filled - the `Job info` sheet says which path was taken).

The full `<job>.json` result file is deliberately *not* used: it is ~50 MB for the example job,
where `regions.js` is ~8 MB and holds everything needed here.

### Known limits

- Very large jobs mean a large `regions.js`. The example (385 records) parses in a couple of
  seconds well inside a 1 GB serverless function; a genome-scale job with thousands of regions
  may need more memory (`functions.api/table.js.memory` in `vercel.json`, Pro plan and up) or a
  non-serverless host.
- Tested against antiSMASH 8 output. The parser is written to tolerate the older ClusterBlast
  result shapes, but v5–v7 jobs have not been verified.
