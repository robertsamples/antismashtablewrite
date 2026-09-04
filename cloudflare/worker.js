/**
 * Cloudflare Worker: mounts the Vercel deployment under a path of the main domain, so the
 * tool lives at www.robertsamples.com/antismashtableconverter/ rather than on its own subdomain.
 *
 * Deploy (dashboard): Workers & Pages -> Create Worker -> paste this -> Settings -> Domains &
 * Routes -> add routes for `www.robertsamples.com/antismashtableconverter*` and the apex host.
 * The zone must be proxied through Cloudflare (orange cloud).
 *
 * Deploy (wrangler): see cloudflare/wrangler.toml, then `npx wrangler deploy`.
 *
 * Set UPSTREAM to the Vercel production URL after the first deploy.
 */

const PREFIX = "/antismashtableconverter";
const UPSTREAM = "https://antismashtablewrite.vercel.app";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // The page links to `api/table` relatively, which only resolves correctly when the
    // mount point has a trailing slash. Redirect the bare path once, permanently.
    if (url.pathname === PREFIX) {
      url.pathname = PREFIX + "/";
      return Response.redirect(url.toString(), 301);
    }

    if (!url.pathname.startsWith(PREFIX + "/")) {
      return fetch(request); // not ours; let the origin handle it
    }

    const upstream = new URL(UPSTREAM);
    upstream.pathname = url.pathname.slice(PREFIX.length) || "/";
    upstream.search = url.search;

    const proxied = new Request(upstream, request);
    proxied.headers.set("x-forwarded-host", url.host);
    proxied.headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

    const response = await fetch(proxied);

    // Responses are returned as-is; the xlsx body and its Content-Disposition pass straight
    // through. Headers are copied so they stay mutable for anything added later.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  },
};
