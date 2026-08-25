// Admin auth: password check + signed-bearer middleware.

import { signAdminSession, verifyAdminSession } from "./token.js";
import { verifyPassword } from "./config.js";

export async function checkAdminPassword(submitted, env) {
  if (!env.ADMIN_PASSWORD_HASH) return false;
  return verifyPassword(String(submitted ?? ""), env.ADMIN_PASSWORD_HASH);
}

export async function issueAdminSession(env) {
  const ttl = Number(env.ADMIN_SESSION_TTL_HOURS || 12);
  return signAdminSession(env.SESSION_SIGNING_KEY, ttl);
}

export function requireAdmin() {
  return async (c, next) => {
    const header = c.req.header("Authorization") || "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const r = await verifyAdminSession(token, c.env.SESSION_SIGNING_KEY);
    if (!r.ok) return c.json({ error: "unauthorized", reason: r.reason }, 401);
    await next();
  };
}
