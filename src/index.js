// Cloudflare Worker entry. Hono routes for the API + the Worker also serves the
// static frontend via the [assets] binding declared in wrangler.toml.
//
// Workers are stateless per request, so everything is constructed inside `fetch`.
// Don't move auth/db/router into module-level singletons that hold per-request state.

import { Hono } from "hono";
import { cors } from "hono/cors";

import { publicRoutes } from "./routes/public.js";
import { rsvpRoutes } from "./routes/rsvp.js";
import { galleryRoutes } from "./routes/gallery.js";
import { adminRoutes } from "./routes/admin.js";
import { broadcastRoutes } from "./routes/broadcast.js";
import { setupRoutes, setupGate } from "./routes/setup.js";
import { mergeEnv } from "./lib/config.js";
import { runDailyCleanup } from "./cron.js";

function buildApp() {
  const app = new Hono();

  // Security headers on every response. CSP needs 'unsafe-inline' because the
  // pages use inline <script type="module"> blocks — it still blocks loading
  // scripts from other origins. nosniff matters most: uploaded files are stored
  // with the client-claimed Content-Type, and nosniff stops browsers from
  // second-guessing it into something executable.
  app.use("*", async (c, next) => {
    await next();
    // Responses from the ASSETS binding have immutable headers — reconstruct.
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    if ((c.res.headers.get("Content-Type") || "").includes("text/html")) {
      c.res.headers.set("Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; " +
        "base-uri 'self'; form-action 'self'");
    }
  });

  // CORS — everything is same-origin (one Worker serves both the frontend and
  // the API), so only SITE_URL may read API responses cross-origin. Reflecting
  // arbitrary origins here would let any website on the internet call the API
  // from its visitors' browsers. If you ever split the frontend onto Pages,
  // add that URL — don't reflect.
  app.use("/api/*", cors({
    origin: (origin, c) => (origin === c.env.SITE_URL ? origin : ""),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  }));

  // First-run wizard gate: everything redirects to /setup until configured.
  app.use("*", setupGate());
  app.route("/", setupRoutes);

  app.route("/", publicRoutes);
  app.route("/", rsvpRoutes);
  app.route("/", galleryRoutes);
  app.route("/", adminRoutes);
  app.route("/", broadcastRoutes);

  app.get("/health", (c) => c.text("ok"));

  // Pretty-URL fallbacks for the SPA-style pages — return the matching static file
  // when someone hits /event/abc or /event/abc/gallery directly.
  app.get("/event/:id", (c) => c.env.ASSETS.fetch(new Request(new URL("/event.html", c.req.url))));
  app.get("/event/:id/gallery", (c) => c.env.ASSETS.fetch(new Request(new URL("/gallery.html", c.req.url))));
  app.get("/admin", (c) => c.env.ASSETS.fetch(new Request(new URL("/admin.html", c.req.url))));

  // Anything else: hand to the static assets binding (index.html, styles.css, sw.js, etc.).
  app.all("*", async (c) => {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    if (res.status === 404) {
      // Fall back to the home page for unknown top-level paths.
      return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
    }
    return res;
  });

  return app;
}

export default {
  async fetch(request, env, ctx) {
    const app = buildApp();
    // Overlay the D1 config table onto env (and derive SITE_URL from the
    // request) so routes read env.RESEND_API_KEY etc. as if they were secrets.
    return app.fetch(request, await mergeEnv(env, request), ctx);
  },

  async scheduled(event, env, ctx) {
    // Daily — clean up expired member-photo rows in D1 (KV's expirationTtl
    // deletes the file bytes) and sweep stale rate-limit counters.
    ctx.waitUntil(mergeEnv(env).then(runDailyCleanup));
  },
};
