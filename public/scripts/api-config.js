// Single source of truth for where the backend API lives. Every dashboard
// page used to hardcode `http://localhost:3000` directly -- harmless for
// local development, but it meant the deployed site would try to call
// "localhost" from every visitor's own browser instead of the real
// server, which fails 100% of the time outside a developer's machine.
//
// Local dev (anything on localhost/127.0.0.1, e.g. a Live Server on
// 127.0.0.1:5500) always talks to the Node API on port 3000, exactly like
// before. Everywhere else assumes the Node app is reverse-proxied onto
// the SAME origin as this static frontend -- the normal setup for
// Hostinger's Node.js hosting (the static `public/` files and the Node
// app both answer on your domain, just different paths). If your
// deployment instead puts the API on a different host or subdomain
// (e.g. api.yourdomain.com), set PRODUCTION_API_BASE below to that full
// origin.
(function () {
  const PRODUCTION_API_BASE = ""; // "" = same origin as this page. Example: "https://api.yourdomain.com"
  const isLocalDev = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  window.API_BASE = isLocalDev ? "http://localhost:3000" : PRODUCTION_API_BASE || window.location.origin;
})();
