// Site-level settings (name, categories, colours, uploaded assets) — all rows in
// the D1 config table, read through env. This module owns the defaults and the
// validation so /api/site, /site.css, /manifest.json and the admin Settings
// page agree on one shape.

export const DEFAULT_CATEGORIES = [{ id: "events", name: "Events", gallery: true }];

// Keys the admin Settings page may read/write. Secrets are handled separately.
export const SETTING_KEYS = [
  "SITE_NAME", "SITE_TAGLINE", "SITE_SEAL", "ADMIN_NAME", "REPLY_TO_EMAIL", "TIMEZONE",
  "CATEGORIES", "COLOR_PRIMARY", "COLOR_ACCENT", "COLOR_BG",
];

export function parseCategories(json) {
  try {
    const arr = JSON.parse(json || "");
    if (Array.isArray(arr) && arr.length) return arr;
  } catch { /* fall through */ }
  return DEFAULT_CATEGORIES;
}

// Returns null when valid, else an error code.
export function validateCategories(arr) {
  if (!Array.isArray(arr) || arr.length < 1 || arr.length > 8) return "bad_categories";
  const ids = new Set();
  for (const c of arr) {
    if (!/^[a-z0-9-]{1,30}$/.test(c?.id) || ids.has(c.id)) return "bad_category_id";
    if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 30) return "bad_category_name";
    ids.add(c.id);
  }
  return null;
}

export function isHexColor(s) {
  return /^#[0-9a-fA-F]{6}$/.test(String(s || ""));
}

// Names allowed under the KV `site-assets/` prefix. Icons are uploaded at both
// sizes by the client (resized in-browser); category images are cat-<id>.
export const ASSET_NAME = /^(icon-192|icon-512|background|cat-[a-z0-9-]{1,30})$/;

function assetUrl(env, name) {
  const v = env[`ASSET_${name}`];
  return v ? `/asset/${name}?v=${v}` : null;
}

// Everything the public pages need to brand themselves. Cheap to compute; no
// secrets. Category image URLs are resolved here so the client never guesses.
export function publicSite(env) {
  const cats = parseCategories(env.CATEGORIES).map((c) => ({
    id: c.id, name: c.name, gallery: c.gallery !== false, image: assetUrl(env, `cat-${c.id}`),
  }));
  return {
    name: env.SITE_NAME || "Group Site",
    tagline: env.SITE_TAGLINE || "",
    seal: env.SITE_SEAL || "✦",
    organiser: env.ADMIN_NAME || "",
    categories: cats,
    colors: {
      primary: isHexColor(env.COLOR_PRIMARY) ? env.COLOR_PRIMARY : null,
      accent: isHexColor(env.COLOR_ACCENT) ? env.COLOR_ACCENT : null,
      bg: isHexColor(env.COLOR_BG) ? env.COLOR_BG : null,
    },
    icon: assetUrl(env, "icon-192"),
    background: assetUrl(env, "background"),
  };
}

// Overrides for app.css variables. Derived shades use color-mix so the admin
// only picks three colours. Empty string when nothing is customised.
export function siteCss(env) {
  const s = publicSite(env);
  const vars = [];
  if (s.colors.primary) {
    vars.push(`--pine:${s.colors.primary}`,
      `--pine-deep:color-mix(in srgb, ${s.colors.primary} 72%, #000)`,
      `--pine-soft:color-mix(in srgb, ${s.colors.primary} 14%, #fff)`,
      `--pine-tint:color-mix(in srgb, ${s.colors.primary} 7%, #fff)`);
  }
  if (s.colors.accent) {
    vars.push(`--persimmon:${s.colors.accent}`,
      `--persimmon-soft:color-mix(in srgb, ${s.colors.accent} 16%, #fff)`);
  }
  if (s.colors.bg) {
    vars.push(`--bg:${s.colors.bg}`,
      `--surface-2:color-mix(in srgb, ${s.colors.bg} 40%, #fff)`,
      `--line:color-mix(in srgb, ${s.colors.bg} 85%, #000)`,
      `--line-soft:color-mix(in srgb, ${s.colors.bg} 93%, #000)`);
  }
  let css = vars.length ? `:root{${vars.join(";")}}\n` : "";
  if (s.background) {
    css += `body{background-image:url("${s.background}");background-size:cover;background-position:center;background-attachment:fixed}\n`
      + `body::before{display:none}\n`;
  }
  return css;
}

export function manifest(env) {
  const s = publicSite(env);
  const icons = s.icon
    ? [{ src: assetUrl(env, "icon-192"), sizes: "192x192", type: "image/png", purpose: "any maskable" },
       { src: assetUrl(env, "icon-512") || assetUrl(env, "icon-192"), sizes: "512x512", type: "image/png", purpose: "any maskable" }]
    : [{ src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
       { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }];
  return {
    name: s.name,
    short_name: s.name.length > 12 ? s.name.slice(0, 12).trim() : s.name,
    description: s.tagline || `${s.name} — events and shared photos.`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: s.colors.primary || "#2C6A49",
    background_color: s.colors.bg || "#F4F1E8",
    orientation: "portrait",
    icons,
  };
}
