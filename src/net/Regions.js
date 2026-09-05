/**
 * Region registry for multiplayer connections.
 *
 * IMPORTANT — current reality: this project has exactly ONE real server
 * (see [[multiplayer]] memory) — a relay running on the host's own machine,
 * reachable through a Cloudflare quick tunnel. There is no cloud hosting and
 * no second physical region deployed anywhere. Everything downstream (ping
 * measurement, auto-select-lowest-latency, the manual region picker, and
 * matchmaking's "expand search to another region" step) is written to loop
 * over this array generically — the day a second real server exists
 * (its own machine/host, its own URL), it is added as one more entry here
 * and every other system picks it up with no further changes.
 */

/** The room everyone lands in by default (see Game.DEFAULT_ROOM). */
export const DEFAULT_ROOM = 'mundo1';

function localOrigin() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Only the raw `vite dev` server (port 5173) needs a hardcoded fallback —
  // the relay is a genuinely separate process there. EVERY other deployment
  // (the merged server on 8080 locally, a Cloudflare tunnel, Render, a
  // custom domain, ...) serves the page from the exact same origin the relay
  // listens on — port included when there is one, or none at all when the
  // page itself has none (a bare "https://host" implies 443).
  //
  // BUG FIXED HERE: this used to fall back to ":8080" whenever `location.port`
  // was empty, not just for the 5173 dev case — which silently broke every
  // portless deployment (a Cloudflare tunnel URL, Render's public domain,
  // ...): the browser would try `wss://your-tunnel.trycloudflare.com:8080`,
  // a port that host never exposes, so the connection just failed outright.
  // This is very likely why a friend joining through the public tunnel link
  // kept failing even though everything tested fine over plain HTTP/curl.
  const port = location.port === '5173' ? ':8080' : (location.port ? `:${location.port}` : '');
  return `${proto}://${location.hostname || 'localhost'}${port}`;
}

/**
 * Candidate relay regions. Resolution order: an explicit build-time
 * `VITE_WS_URL` (set this when the client is hosted SEPARATELY from the
 * relay — e.g. client on GitHub Pages/Vercel, relay alone on Render) wins;
 * otherwise the relay is assumed to live on the same origin the page was
 * loaded from (today's default setup — one Render service serves both).
 * A future second region would just be one more entry here:
 * { id: 'us-east', label: 'Este de EE.UU.', url: 'wss://us-east.mydomain.com' }.
 */
export function listRegions() {
  const override = (import.meta.env && import.meta.env.VITE_WS_URL) || '';
  return [
    { id: 'main', label: 'Principal', url: override || localOrigin() }
  ];
}
