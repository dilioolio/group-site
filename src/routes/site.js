// Site branding + settings: public endpoints the pages use to dress themselves
// (/api/site, /site.css, /manifest.json, /asset/:name) and the admin
// Settings API (read/write config keys, upload/delete assets).

import { Hono } from "hono";
import { requireAdmin } from "../lib/auth.js";
import { saveConfig, hashPassword } from "../lib/config.js";
import { jsonError, isValidEmail } from "../lib/utils.js";
import {
  publicSite, siteCss, manifest, parseCategories, validateCategories, isHexColor,
  SETTING_KEYS, ASSET_NAME,
} from "../lib/site.js";

export const siteRoutes = new Hono();

const ASSET_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const ASSET_MAX_BYTES = 3 * 1024 * 1024; // clients resize first; this is the backstop

// --- public ----------------------------------------------------------------

siteRoutes.get("/api/site", (c) => c.json(publicSite(c.env)));

siteRoutes.get("/site.css", (c) => c.body(siteCss(c.env), 200, {
  "Content-Type": "text/css; charset=utf-8",
  "Cache-Control": "public, max-age=60",
}));

siteRoutes.get("/manifest.json", (c) => c.json(manifest(c.env), 200, {
  "Content-Type": "application/manifest+json",
  "Cache-Control": "public, max-age=60",
}));

siteRoutes.get("/asset/:name", async (c) => {
  const name = c.req.param("name");
  if (!ASSET_NAME.test(name)) return c.notFound();
  const { value, metadata } = await c.env.PHOTOS.getWithMetadata(`site-assets/${name}`, "stream");
  if (!value) return c.notFound();
  return new Response(value, { headers: {
    "Content-Type": metadata?.contentType || "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable", // URLs carry ?v=
  } });
});

// --- admin -----------------------------------------------------------------

siteRoutes.get("/api/admin/settings", requireAdmin(), (c) => {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = c.env[k] ?? "";
  out.categories = parseCategories(c.env.CATEGORIES);
  out.FROM_EMAIL = c.env.FROM_EMAIL || "";
  out.resend_key_set = !!c.env.RESEND_API_KEY;
  out.site = publicSite(c.env);
  return c.json(out);
});

siteRoutes.put("/api/admin/settings", requireAdmin(), async (c) => {
  let b;
  try { b = await c.req.json(); } catch { return jsonError(c, 400, "bad_json"); }
  const patch = {};

  for (const k of ["SITE_NAME", "SITE_TAGLINE", "SITE_SEAL", "ADMIN_NAME", "REPLY_TO_EMAIL", "TIMEZONE"]) {
    if (b[k] !== undefined) patch[k] = String(b[k]).trim().slice(0, k === "SITE_SEAL" ? 2 : 80);
  }
  if (patch.SITE_NAME === "") return jsonError(c, 400, "missing_site_name");
  if (patch.ADMIN_NAME === "") return jsonError(c, 400, "missing_name");
  if (patch.REPLY_TO_EMAIL && !isValidEmail(patch.REPLY_TO_EMAIL)) return jsonError(c, 400, "bad_reply_to");
  if (patch.TIMEZONE) {
    try { new Intl.DateTimeFormat("en", { timeZone: patch.TIMEZONE }); } catch { return jsonError(c, 400, "bad_timezone"); }
  }
  for (const k of ["COLOR_PRIMARY", "COLOR_ACCENT", "COLOR_BG"]) {
    if (b[k] === undefined) continue;
    if (b[k] !== "" && !isHexColor(b[k])) return jsonError(c, 400, "bad_color");
    patch[k] = b[k];
  }
  if (b.categories !== undefined) {
    const cats = (b.categories || []).map((x) => ({
      id: String(x?.id || "").trim(), name: String(x?.name || "").trim(), gallery: x?.gallery !== false,
    }));
    const err = validateCategories(cats);
    if (err) return jsonError(c, 400, err);
    patch.CATEGORIES = JSON.stringify(cats);
  }
  if (b.password) {
    if (String(b.password).length < 8) return jsonError(c, 400, "password_too_short");
    patch.ADMIN_PASSWORD_HASH = await hashPassword(String(b.password));
  }
  if (b.resend_api_key) {
    const key = String(b.resend_api_key).trim();
    if (!key.startsWith("re_")) return jsonError(c, 400, "bad_resend_key");
    patch.RESEND_API_KEY = key;
  }
  if (b.FROM_EMAIL !== undefined) {
    const e = String(b.FROM_EMAIL).trim().toLowerCase();
    if (!isValidEmail(e)) return jsonError(c, 400, "bad_from_email");
    patch.FROM_EMAIL = e;
  }

  await saveConfig(c.env, patch);
  return c.json({ ok: true, site: publicSite({ ...c.env, ...patch }) });
});

siteRoutes.post("/api/admin/assets/:name", requireAdmin(), async (c) => {
  const name = c.req.param("name");
  if (!ASSET_NAME.test(name)) return jsonError(c, 400, "bad_asset_name");
  let form;
  try { form = await c.req.formData(); } catch { return jsonError(c, 400, "bad_form"); }
  const file = form.get("file");
  if (!(file instanceof File)) return jsonError(c, 400, "no_file");
  if (!ASSET_MIME.has(file.type)) return jsonError(c, 415, "unsupported_type", { type: file.type });
  if (file.size <= 0 || file.size > ASSET_MAX_BYTES) return jsonError(c, 413, "file_too_large");

  await c.env.PHOTOS.put(`site-assets/${name}`, await file.arrayBuffer(), { metadata: { contentType: file.type } });
  const v = String(Date.now());
  await saveConfig(c.env, { [`ASSET_${name}`]: v });
  return c.json({ ok: true, url: `/asset/${name}?v=${v}` });
});

siteRoutes.delete("/api/admin/assets/:name", requireAdmin(), async (c) => {
  const name = c.req.param("name");
  if (!ASSET_NAME.test(name)) return jsonError(c, 400, "bad_asset_name");
  await c.env.PHOTOS.delete(`site-assets/${name}`);
  await c.env.DB.prepare("DELETE FROM config WHERE key = ?").bind(`ASSET_${name}`).run();
  return c.json({ ok: true });
});
