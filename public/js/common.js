// Tiny shared helpers used by every page.

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      ...(opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const err = new Error(typeof data === "string" ? data : (data.error || res.statusText));
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch { return iso; }
}

export function daysUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.round(ms / 86400000));
}

export function showNotice(el, kind, text) {
  el.className = `notice ${kind}`;
  el.textContent = text;
  el.style.display = "block";
  // Re-trigger the pulse animation on every call so repeated clicks that produce
  // the same notice (e.g. retrying an action that keeps failing) still register
  // visually instead of looking like nothing happened.
  el.classList.remove("pulse");
  void el.offsetWidth;
  el.classList.add("pulse");
}

export function clearNotice(el) {
  el.style.display = "none";
  el.textContent = "";
}

// Resize an image client-side before upload, to stay under the server cap.
// Returns a Blob. Max long edge defaults to 1600px.
export async function resizeImage(file, { maxEdge = 1600, quality = 0.85 } = {}) {
  if (!file.type.startsWith("image/")) return file;
  // HEIC and similar: the browser can't decode these; pass through and let the server reject if needed.
  if (file.type === "image/heic" || file.type === "image/heif") return file;

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;

  let { width, height } = bitmap;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);

  const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await canvas.convertToBlob({ type: outType, quality });
  return blob;
}

// Push-subscribe this device. `pushToken` is the short-lived proof-of-email
// token returned by a successful RSVP — the server requires it so nobody can
// subscribe a device under someone else's email. Requires user-permission gesture.
export async function subscribeForPush(pushToken) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Push not supported when viewing from a chat app. Open this site directly in Chrome or your browser. If on iOS, you'll need to add it to your Home Screen first.");
  }
  if (!pushToken) throw new Error("Save your RSVP first, then turn on notifications.");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notification permission denied.");

  const { publicKey } = await api("/api/push/public-key");
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await api("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ token: pushToken, subscription: sub.toJSON() }),
  });
  return true;
}

function urlBase64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Fetch site branding once per page and apply it: name, seal, <title>,
// theme-color. Cached in sessionStorage so navigation doesn't flash defaults.
export async function loadSite() {
  try {
    const cached = sessionStorage.getItem("site");
    if (cached) { const s = JSON.parse(cached); refreshSite(); return s; }
  } catch { /* ignore */ }
  return refreshSite();
}
async function refreshSite() {
  const site = await api("/api/site");
  try { sessionStorage.setItem("site", JSON.stringify(site)); } catch { /* ignore */ }
  applySite(site);
  return site;
}
export function applySite(site) {
  document.querySelectorAll("[data-site-name]").forEach((el) => { el.textContent = site.name; });
  document.querySelectorAll("[data-site-seal]").forEach((el) => { el.textContent = site.seal; });
  document.querySelectorAll("[data-site-tagline]").forEach((el) => { el.textContent = site.tagline; el.hidden = !site.tagline; });
  document.title = document.title.replace("Group Site", site.name);
  if (site.colors?.primary) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", site.colors.primary);
  if (site.icon) document.querySelector('link[rel="icon"]')?.setAttribute("href", site.icon);
}
