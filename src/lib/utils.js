// Small shared helpers. Keep these stateless — Workers re-create modules per isolate.

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function uuid() {
  return crypto.randomUUID();
}

export function isoNow() {
  return new Date().toISOString();
}

export function addDaysIso(days, from = new Date()) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function isValidEmail(email) {
  const e = normalizeEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function b64urlEncode(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(str) {
  let s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 24) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function jsonError(c, status, code, extra = {}) {
  return c.json({ error: code, ...extra }, status);
}

// Format an event date for emails/push. Workers run in UTC, so without an
// explicit timeZone every emailed time would silently be UTC wall-clock while
// the website shows local time. TIMEZONE is set in wrangler.toml [vars];
// timeZoneName makes the zone explicit even if it's misconfigured.
export function formatEventDate(env, iso) {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: env.TIMEZONE || "UTC",
      weekday: "long", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });
  } catch { return iso; }
}

// --- CRC-32 (for the gallery zip) -------------------------------------------

let CRC_TABLE = null;

function crcTable() {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[i] = c >>> 0;
    }
  }
  return CRC_TABLE;
}

export function crc32(bytes) {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}
