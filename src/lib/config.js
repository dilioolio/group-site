// Runtime config lives in the D1 `config` table (key/value) instead of Worker
// secrets, so a non-technical self-hoster never touches a terminal: the Deploy
// button provisions D1/KV, the first request creates the schema, and the /setup
// wizard fills in the rest. mergeEnv() overlays those rows onto `env`, so the
// rest of the codebase keeps reading `env.RESEND_API_KEY` etc. unchanged.

import schemaSql from "../../schema.sql";
import { b64urlEncode, b64urlToBytes, enc } from "./utils.js";

// ponytail: one D1 read per request (static assets included, run_worker_first).
// Add a short module-level cache if D1 reads ever matter at this scale.
export async function loadConfig(env) {
  let rows;
  try {
    rows = (await env.DB.prepare("SELECT key, value FROM config").all()).results;
  } catch (err) {
    if (!/no such table/i.test(String(err?.message))) throw err;
    await applySchema(env);
    rows = [];
  }
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function applySchema(env) {
  const stmts = schemaSql
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(";").map((s) => s.trim())
    .filter((s) => s && !/^PRAGMA/i.test(s)); // D1 enforces foreign keys itself
  await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
}

export async function saveConfig(env, obj) {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  await env.DB.batch(entries.map(([k, v]) => env.DB.prepare(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(k, String(v))));
}

// Merged view: bindings + config rows + SITE_URL derived from the request, so a
// custom domain works the moment DNS points here (no setting to update).
export async function mergeEnv(env, request) {
  const cfg = await loadConfig(env);
  return { ...env, ...cfg, SITE_URL: request ? new URL(request.url).origin : cfg.SITE_URL };
}

// --- key generation (replaces scripts/gen-vapid.mjs) ------------------------

export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const rawPub = await crypto.subtle.exportKey("raw", pair.publicKey);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: b64urlEncode(rawPub), privateKey: jwk.d }; // jwk.d is already base64url
}

// --- password hashing (PBKDF2-SHA256, stored as "pbkdf2$salt$hash") --------

const ITER = 100_000;

async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt);
  return `pbkdf2$${b64urlEncode(salt)}$${b64urlEncode(bits)}`;
}

export async function verifyPassword(password, stored) {
  const [, saltB64, hashB64] = String(stored || "").split("$");
  if (!saltB64 || !hashB64) return false;
  const bits = new Uint8Array(await pbkdf2(password, b64urlToBytes(saltB64)));
  const want = b64urlToBytes(hashB64);
  if (bits.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ want[i];
  return diff === 0;
}
