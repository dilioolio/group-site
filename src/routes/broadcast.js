// Confirmable broadcasts: an admin sends an important update to the hike's RSVP list,
// each member gets a unique Confirm link, and the admin sees who has confirmed.
//
// Two-step on purpose: GET shows the landing page, POST records the confirmation.
// That way Apple Mail / outlook security scanners can't auto-confirm by prefetching.

import { Hono } from "hono";
import { requireAdmin } from "../lib/auth.js";
import { sendEmails, composeEmail } from "../lib/email.js";
import { sendPushBatch } from "../lib/push.js";
import { uuid, isoNow, jsonError, escapeHtml, randomToken, normalizeEmail } from "../lib/utils.js";

export const broadcastRoutes = new Hono();

// --- admin: send a confirmable broadcast -----------------------------------

broadcastRoutes.post("/api/admin/events/:id/broadcast", requireAdmin(), async (c) => {
  const eventId = c.req.param("id");
  let body;
  try { body = await c.req.json(); } catch { return jsonError(c, 400, "bad_json"); }
  const subject = String(body?.subject || "").trim();
  const messageBody = String(body?.body || "").trim();
  if (!subject) return jsonError(c, 400, "missing_subject");
  if (!messageBody) return jsonError(c, 400, "missing_body");

  const event = await c.env.DB.prepare("SELECT id, title FROM events WHERE id = ?").bind(eventId).first();
  if (!event) return c.notFound();

  const recipients = (await c.env.DB.prepare(
    "SELECT name, email FROM rsvps WHERE event_id = ? AND status != 'cancelled'"
  ).bind(eventId).all()).results || [];
  if (recipients.length === 0) return jsonError(c, 409, "no_recipients");

  const broadcastId = uuid();
  await c.env.DB.prepare(
    "INSERT INTO broadcasts (id, event_id, subject, body, sent_at, kind) VALUES (?, ?, ?, ?, ?, 'broadcast')"
  ).bind(broadcastId, eventId, subject, messageBody, isoNow()).run();

  // Short push body — keep under ~150 chars so it fits browser/OS notification cards.
  const pushBodyBase = messageBody.length > 140 ? messageBody.slice(0, 137) + "…" : messageBody;

  // Everything below is BATCHED, not per-recipient. The old per-recipient loop
  // cost ~4+ subrequests each (D1 insert, email fetch, D1 select, push fetches)
  // and blew the free plan's 50-subrequest cap at roughly a dozen recipients,
  // dying mid-send. Now: one D1 batch for ack rows, ONE relay call for every
  // email, one D1 select for all subscriptions, then the unavoidable
  // per-device push fetches.
  const acks = recipients.map((r) => ({
    id: uuid(),
    email: r.email,
    name: r.name,
    token: randomToken(24), // token in PATH (Apple LTP strips ?query)
  }));
  const ackStmt = c.env.DB.prepare(
    `INSERT INTO broadcast_acks (id, broadcast_id, email, name, token, confirmed_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  );
  await c.env.DB.batch(acks.map((a) => ackStmt.bind(a.id, broadcastId, a.email, a.name, a.token)));

  const confirmUrl = (a) => `${c.env.SITE_URL}/c/${a.token}`;
  const messages = acks.map((a) => {
    const { body: textBody, htmlBody } = composeEmail(c.env, {
      recipientName: a.name?.trim() || null,
      body: `${messageBody}\n\nWhen you've read this, please click the link below to confirm — that way I know you've seen it.`,
      link: confirmUrl(a),
      linkLabel: "Confirm you've seen this",
    });
    return { to: a.email, subject, body: textBody, htmlBody };
  });
  const emailResult = await sendEmails(c.env, messages);
  const sent = emailResult.ok
    ? (typeof emailResult.sent === "number" ? emailResult.sent : messages.length)
    : 0;

  // Push fan-out: every device subscribed under a recipient's email gets the
  // notification pointing at THAT recipient's unique confirm URL.
  const ackByEmail = new Map(acks.map((a) => [normalizeEmail(a.email), a]));
  const emails = [...ackByEmail.keys()];
  const placeholders = emails.map(() => "?").join(",");
  const subs = (await c.env.DB.prepare(
    `SELECT id, endpoint, p256dh, auth, lower(email) AS email
       FROM push_subscriptions WHERE lower(email) IN (${placeholders})`
  ).bind(...emails).all()).results || [];
  const pushItems = subs
    .map((sub) => {
      const a = ackByEmail.get(sub.email);
      return a && {
        sub,
        payload: { title: subject, body: `${pushBodyBase}\n(tap to confirm)`, url: confirmUrl(a) },
      };
    })
    .filter(Boolean);
  const pr = pushItems.length > 0 ? await sendPushBatch(c.env, pushItems) : { sent: 0, pruned: 0 };

  return c.json({
    ok: true,
    broadcastId,
    recipients: recipients.length,
    emails_sent: sent,
    push_sent: pr.sent,
    push_pruned: pr.pruned,
  });
});

// --- admin: per-event broadcast list with totals ---------------------------

broadcastRoutes.get("/api/admin/events/:id/broadcasts", requireAdmin(), async (c) => {
  const eventId = c.req.param("id");
  const rows = (await c.env.DB.prepare(
    `SELECT b.id, b.subject, b.body, b.sent_at,
            COUNT(a.id)           AS total,
            COUNT(a.confirmed_at) AS confirmed
       FROM broadcasts b
       LEFT JOIN broadcast_acks a ON a.broadcast_id = b.id
      WHERE b.event_id = ? AND b.kind = 'broadcast'
      GROUP BY b.id
      ORDER BY b.sent_at DESC`
  ).bind(eventId).all()).results || [];
  return c.json({ broadcasts: rows });
});

// --- admin: who confirmed, who didn't --------------------------------------

broadcastRoutes.get("/api/admin/broadcasts/:broadcastId", requireAdmin(), async (c) => {
  const id = c.req.param("broadcastId");
  const broadcast = await c.env.DB.prepare(
    "SELECT id, event_id, subject, body, sent_at FROM broadcasts WHERE id = ?"
  ).bind(id).first();
  if (!broadcast) return c.notFound();
  const acks = (await c.env.DB.prepare(
    `SELECT name, email, confirmed_at FROM broadcast_acks
      WHERE broadcast_id = ?
      ORDER BY confirmed_at IS NULL, name`
  ).bind(id).all()).results || [];
  return c.json({ broadcast, acks });
});

// --- public: GET /c/:token -- landing page (no state change, prefetch-safe).

broadcastRoutes.get("/c/:token", async (c) => {
  const ack = await c.env.DB.prepare(
    `SELECT a.confirmed_at, a.name, b.subject, b.body
       FROM broadcast_acks a JOIN broadcasts b ON b.id = a.broadcast_id
      WHERE a.token = ?`
  ).bind(c.req.param("token")).first();

  if (!ack) return c.html(page("Link not found", "<p>This confirmation link is invalid or has expired.</p>"), 404);
  if (ack.confirmed_at) return c.html(page("Already confirmed", `<p>Thanks${ack.name ? `, ${escapeHtml(ack.name)}` : ""} — your confirmation is already on the record.</p>`));

  const t = encodeURIComponent(c.req.param("token"));
  const bodyHtml = escapeHtml(ack.body).replaceAll("\n", "<br>");
  return c.html(page(escapeHtml(ack.subject), `
    <article class="msg">${bodyHtml}</article>
    <form method="POST" action="/c/${t}">
      <button class="confirm-btn" type="submit">Confirm you've seen this</button>
    </form>
    <p class="note">Pressing Confirm tells the organiser you've read this update.</p>
  `));
});

// --- public: POST /c/:token -- the actual confirm (idempotent) -------------

broadcastRoutes.post("/c/:token", async (c) => {
  const res = await c.env.DB.prepare(
    "UPDATE broadcast_acks SET confirmed_at = COALESCE(confirmed_at, ?) WHERE token = ?"
  ).bind(isoNow(), c.req.param("token")).run();
  if (!res.meta?.changes) {
    return c.html(page("Link not found", "<p>This confirmation link is invalid or has expired.</p>"), 404);
  }
  return c.html(page("Confirmed — thanks!", "<p>Got it. The organiser can now see that you've seen this update.</p>"));
});

function page(title, inner) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body class="confirm-page">
  <main class="card">
    <h1>${title}</h1>
    ${inner}
    <p class="back"><a href="/">Back to hikes</a></p>
  </main>
</body>
</html>`;
}
