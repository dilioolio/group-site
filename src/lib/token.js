// HMAC-SHA256 signed tokens for two purposes:
//   - gallery tokens (one event + email, exp)
//   - admin session tokens (kind="admin", exp)
// Both are stateless — no DB table needed. Same signing key, different payload shapes.

import { b64urlEncode, b64urlToBytes, enc, dec } from "./utils.js";

// Fail closed if the signing key is missing or trivially weak. Without this,
// an unset SESSION_SIGNING_KEY would mean tokens signed with an empty/guessable
// key — i.e. anyone could forge an admin session. Self-hosters WILL forget to
// set secrets; refusing to sign/verify is the safe failure mode.
function assertSecret(secret) {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("SESSION_SIGNING_KEY is not set (or is shorter than 16 chars) — refusing to sign/verify tokens");
  }
}

async function hmacKey(secret, usages) {
  assertSecret(secret);
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

async function sign(payloadObj, secret) {
  const payload = b64urlEncode(enc.encode(JSON.stringify(payloadObj)));
  const key = await hmacKey(secret, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `${payload}.${b64urlEncode(sig)}`;
}

async function verify(token, secret) {
  try {
    const [payload, sig] = String(token || "").split(".");
    if (!payload || !sig) return { ok: false, reason: "malformed" };
    const key = await hmacKey(secret, ["verify"]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlToBytes(sig),
      enc.encode(payload),
    );
    if (!valid) return { ok: false, reason: "bad_signature" };
    const data = JSON.parse(dec.decode(b64urlToBytes(payload)));
    if (typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// --- Gallery tokens (per-event, per-email) ---------------------------------

export async function signGalleryToken(eventId, email, secret, ttlDays = 30) {
  const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400;
  return sign({ k: "gal", e: eventId, m: String(email).toLowerCase(), exp }, secret);
}

export async function verifyGalleryToken(token, eventId, secret) {
  const r = await verify(token, secret);
  if (!r.ok) return r;
  if (r.data.k !== "gal") return { ok: false, reason: "wrong_kind" };
  if (r.data.e !== eventId) return { ok: false, reason: "wrong_event" };
  return { ok: true, email: r.data.m };
}

// --- Push-subscribe tokens ---------------------------------------------------
// Short-lived proof of email ownership, issued by the RSVP handler. Required by
// /api/push/subscribe so a stranger can't subscribe their own device under
// someone else's email and intercept that member's notifications.

export async function signSubscribeToken(email, secret, ttlSeconds = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return sign({ k: "sub", m: String(email).toLowerCase(), exp }, secret);
}

export async function verifySubscribeToken(token, secret) {
  const r = await verify(token, secret);
  if (!r.ok) return r;
  if (r.data.k !== "sub") return { ok: false, reason: "wrong_kind" };
  return { ok: true, email: r.data.m };
}

// --- Admin session tokens --------------------------------------------------

export async function signAdminSession(secret, ttlHours = 12) {
  const exp = Math.floor(Date.now() / 1000) + ttlHours * 3600;
  return sign({ k: "adm", exp }, secret);
}

export async function verifyAdminSession(token, secret) {
  const r = await verify(token, secret);
  if (!r.ok) return r;
  if (r.data.k !== "adm") return { ok: false, reason: "wrong_kind" };
  return { ok: true };
}
