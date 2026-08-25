// Web Push from a Cloudflare Worker — VAPID + aes128gcm payload encryption.
// Implemented in pure Web Crypto (no node deps, no `nodejs_compat` flag).
//
// References:
//   RFC 8030 — generic event delivery
//   RFC 8291 — Message Encryption for Web Push (aes128gcm)
//   RFC 8292 — VAPID
//
// Usage:
//   const r = await sendPush(subscription, { title, body, url }, env);
//   if (r.gone) { /* 404 or 410 — caller should delete the subscription */ }

import { b64urlEncode, b64urlToBytes, enc } from "./utils.js";

// ---------- key helpers ----------

async function importVapidPrivateKey(env) {
  // Stored as base64url of the 32-byte raw EC scalar `d`.
  // The public key (uncompressed P-256, 65 bytes) is in VAPID_PUBLIC_KEY.
  const pubRaw = b64urlToBytes(env.VAPID_PUBLIC_KEY); // 0x04 || X(32) || Y(32)
  if (pubRaw.length !== 65 || pubRaw[0] !== 0x04) {
    throw new Error("VAPID_PUBLIC_KEY must be 65-byte uncompressed P-256 (base64url)");
  }
  const x = pubRaw.slice(1, 33);
  const y = pubRaw.slice(33, 65);
  const d = b64urlToBytes(env.VAPID_PRIVATE_KEY);
  if (d.length !== 32) {
    throw new Error("VAPID_PRIVATE_KEY must be 32-byte raw scalar (base64url)");
  }
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(x),
    y: b64urlEncode(y),
    d: b64urlEncode(d),
    ext: true,
  };
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function importP256PublicKey(rawBytes) {
  // rawBytes: 65-byte uncompressed (0x04 prefix)
  return crypto.subtle.importKey(
    "raw",
    rawBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}

// ---------- VAPID JWT (ES256) ----------

async function buildVapidJwt(endpointUrl, env) {
  const aud = new URL(endpointUrl).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: "ES256", typ: "JWT" })));
  const payload = b64urlEncode(enc.encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,         // 12h is well within the 24h spec cap
    sub: env.VAPID_SUBJECT || "mailto:admin@example.com",
  })));
  const signingInput = `${header}.${payload}`;
  const privKey = await importVapidPrivateKey(env);
  const sigDer = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privKey,
    enc.encode(signingInput),
  );
  // Web Crypto returns raw r||s (64 bytes) for ECDSA — exactly what JWS wants.
  return `${signingInput}.${b64urlEncode(sigDer)}`;
}

// ---------- HKDF ----------

async function hkdf(salt, ikm, info, length) {
  const baseKey = await crypto.subtle.importKey("raw", ikm, { name: "HKDF" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

// ---------- aes128gcm payload encryption (RFC 8291) ----------

function concat(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function encryptPayload(plaintextBytes, uaPubRaw, authSecret) {
  // 1. Local ephemeral ECDH keypair
  const localPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", localPair.publicKey)); // 65 bytes

  // 2. ECDH shared secret (32 bytes)
  const uaPubKey = await importP256PublicKey(uaPubRaw);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPubKey },
    localPair.privateKey,
    256,
  ));

  // 3. PRK_key = HKDF-Extract(salt=authSecret, IKM=ecdh)
  //    key_info = "WebPush: info\0" || ua_public || as_public
  //    IKM      = HKDF-Expand(PRK_key, key_info, 32)
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPubRaw, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);

  // 4. salt = 16 random bytes
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 5. CEK and nonce
  //    cek_info   = "Content-Encoding: aes128gcm\0"
  //    nonce_info = "Content-Encoding: nonce\0"
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // 6. Pad: plaintext || 0x02 || 0x00 * N  (0x02 marks last record)
  const padded = concat(plaintextBytes, new Uint8Array([0x02]));

  // 7. AES-128-GCM
  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    cekKey,
    padded,
  ));

  // 8. Header: salt(16) || rs(4, big-endian, 4096) || idlen(1) || keyid(idlen)
  //    For Web Push, keyid is the as_public (65 bytes), idlen = 65.
  const rs = new Uint8Array([0x00, 0x00, 0x10, 0x00]); // 4096
  const idlen = new Uint8Array([0x41]);                // 65
  const header = concat(salt, rs, idlen, asPublicRaw);

  return concat(header, ciphertext);
}

// ---------- public API ----------

export async function sendPush(subscription, payloadObj, env) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return { ok: false, status: 0, reason: "bad_subscription" };
  }

  const uaPubRaw = b64urlToBytes(keys.p256dh);
  const authSecret = b64urlToBytes(keys.auth);
  const plaintext = enc.encode(JSON.stringify(payloadObj));
  const body = await encryptPayload(plaintext, uaPubRaw, authSecret);

  const jwt = await buildVapidJwt(endpoint, env);
  const headers = {
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    "TTL": "86400",
    "Authorization": `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
  };

  const res = await fetch(endpoint, { method: "POST", headers, body });
  return {
    ok: res.ok,
    status: res.status,
    gone: res.status === 404 || res.status === 410, // caller deletes the subscription
  };
}

// Fan out per-subscription payloads. `items` is [{sub, payload}] where sub is
// a push_subscriptions row — payloads can differ per item (e.g. each broadcast
// recipient gets their own confirm URL). Dead endpoints (404/410) are pruned
// in ONE batched D1 call instead of one delete per subscription — D1 calls
// count against the per-request subrequest cap (50 on the free plan).
export async function sendPushBatch(env, items) {
  let sent = 0;
  const goneIds = [];
  await Promise.all(items.map(async ({ sub, payload }) => {
    try {
      const r = await sendPush(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        env,
      );
      if (r.ok) sent++;
      if (r.gone) goneIds.push(sub.id);
    } catch (err) {
      console.error("push send error:", err?.message || err);
    }
  }));
  if (goneIds.length > 0) {
    const stmt = env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?");
    await env.DB.batch(goneIds.map((id) => stmt.bind(id)));
  }
  return { sent, pruned: goneIds.length };
}

// Same payload to many subscriptions. Returns counts for "sent N / pruned M".
export async function sendPushToSubscriptions(env, subs, payload) {
  return sendPushBatch(env, subs.map((sub) => ({ sub, payload })));
}
