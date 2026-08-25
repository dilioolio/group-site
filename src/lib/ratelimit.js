// Fixed-window rate limiter backed by D1 (the `rate_limits` table).
//
// Why D1 and not Cloudflare WAF rules: WAF rate limiting needs a zone (custom
// domain), and this app runs on a workers.dev subdomain. Why not KV: the free
// tier allows only 1k KV writes/day — counters would eat the photo budget.
//
// One round trip per check: an UPSERT that either starts a new window or
// increments the current one, RETURNING the post-increment count. Expired
// rows are swept by the daily cron.

export function clientIp(c) {
  return c.req.header("CF-Connecting-IP") || "unknown";
}

/**
 * Count a hit against `key` and report whether it stays within `limit` per
 * `windowSeconds`. Fails OPEN on D1 errors — a broken limiter shouldn't take
 * RSVPs down with it.
 *
 * @returns {Promise<{allowed: boolean, count?: number}>}
 */
export async function rateLimit(env, key, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count    = CASE WHEN reset_at <= ?3 THEN 1 ELSE count + 1 END,
         reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END
       RETURNING count`
    ).bind(key, now + windowSeconds, now).first();
    const count = row?.count ?? 1;
    return { allowed: count <= limit, count };
  } catch (err) {
    console.error("rateLimit error (failing open):", err?.message || err);
    return { allowed: true };
  }
}
