// Daily cleanup. Runs via the [triggers] cron configured in wrangler.toml.
//
// What this does:
//   1. Delete expired member_photos rows from D1 (the canonical source for UI lists).
//   2. As a defensive backstop, also delete those KV values directly. KV's own
//      expirationTtl (set at upload) has already deleted most of them by now —
//      the explicit delete is a no-op then, but covers any that lingered.
//   3. Sweep expired rate_limits rows so the counter table stays tiny.
//
// What this does NOT do:
//   - Touch event_images (organiser photos must NEVER expire — stored without TTL).

import { isoNow } from "./lib/utils.js";

export async function runDailyCleanup(env) {
  const cutoff = isoNow();

  // Expired rate-limit windows — safe to drop wholesale.
  await env.DB.prepare(
    "DELETE FROM rate_limits WHERE reset_at <= ?"
  ).bind(Math.floor(Date.now() / 1000)).run();

  const expired = (await env.DB.prepare(
    "SELECT id, r2_key FROM member_photos WHERE expires_at <= ? LIMIT 1000"
  ).bind(cutoff).all()).results || [];

  if (expired.length === 0) {
    console.log("[cron] nothing to clean up");
    return { removed: 0 };
  }

  // Best-effort delete of the KV values in parallel, then nuke their rows.
  // KV's expirationTtl has usually deleted them already — `delete` is idempotent.
  await Promise.allSettled(
    expired.map((row) => env.PHOTOS.delete(row.r2_key)),
  );

  // Batch-delete the rows. D1 doesn't support multi-row delete via prepared statements
  // with an array, so we use a generated IN(...) clause with bound params.
  const placeholders = expired.map(() => "?").join(",");
  await env.DB.prepare(
    `DELETE FROM member_photos WHERE id IN (${placeholders})`
  ).bind(...expired.map((r) => r.id)).run();

  console.log(`[cron] removed ${expired.length} expired member photos`);
  return { removed: expired.length };
}
