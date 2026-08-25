# Group Site

A self-hosted events site for a club, hiking group, debate night — any group that
used to pay for Meetup. Runs on Cloudflare's free tier. No terminal needed to
set it up: one button deploys it, a two-minute form in the browser configures it.

Members RSVP to events, get email + push alerts when things change, and can share
photos from each event (photos expire 30 days after the event).

**Stack:** Cloudflare Worker (Hono) + D1 (SQLite) + Workers KV (images) + Resend
(email). Static frontend is served by the same Worker via the `[assets]` binding.

## Deploy (no terminal)

Step-by-step instructions for a non-technical organiser — including what to paste into ChatGPT so it can act as your help desk — are in **[HELP.md](HELP.md)**.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dilioolio/group-site)

1. Click the button, sign in to Cloudflare (free account is fine). Cloudflare
   copies this repo into your GitHub, creates the D1 database and KV namespace,
   and deploys the Worker.
2. Open the URL Cloudflare gives you. The site redirects to **/setup** and asks
   for: site name, your first name, an admin password, a sending email address
   on a domain you own, a [Resend](https://resend.com) API key, and your timezone.
3. Done. Log in at **/admin** and create your first event. **Settings** (top right) has categories (e.g. Hikes / Conversations), colours, home-screen icon, background image, and your email/password.

The Worker creates its own database tables on the first request and generates
its own signing and push (VAPID) keys during setup — there are no secrets to
paste anywhere.

### Email (Resend)

Free tier is 3,000 emails/month, which covers a group comfortably. In Resend:
**Domains → Add domain** (your own, e.g. `example.com`) → add the DNS records it
shows you at your DNS provider → wait for "Verified". Then **API Keys → Create**
(full access) and paste the `re_…` key into the setup form. The sending address
is anything at that domain, e.g. `events@example.com`.

Setup warns you if the domain isn't verified yet; emails won't send until it is.

### Custom domain

The site works immediately on the `*.workers.dev` URL. To use your own domain:
Cloudflare dashboard → Workers & Pages → your Worker → **Settings → Domains &
Routes → Add → Custom domain**. If your DNS isn't on Cloudflare, Cloudflare
shows you the record to add at your registrar. Links in emails follow whichever
domain the request came in on — nothing to update.

## Local development

```sh
npm install
npx wrangler dev        # http://localhost:8787 → redirects to /setup
```

Local D1/KV live in `.wrangler/state`; delete that folder to start over.

## Architecture quick reference

```text
Browser ── Worker (Hono) ──┬── D1   (events, rsvps, push subs, broadcasts, member_photos, rate_limits, config)
                          ├── KV   (event-images/ public, member-photos/ private + expirationTtl)
                          └── Resend (all outbound mail; src/lib/email.js is the only place that sends)

Config: every request overlays the D1 `config` table onto env (src/lib/config.js),
        so routes read env.RESEND_API_KEY / env.VAPID_PRIVATE_KEY / env.TIMEZONE
        exactly as if they were Worker secrets. SITE_URL is derived from the request.
Web Push: VAPID JWT + RFC 8291 aes128gcm, all done with Web Crypto in the Worker.
Cron: daily 03:00 UTC — drops expired member_photos rows + stale rate-limit counters.
```

### Gallery access model

Stateless HMAC-signed tokens, scoped to one event + one email, valid 30 days.
- The RSVP confirmation email contains a personal gallery link.
- Or a member opens `/event/:id/gallery` and requests access by email; if that
  email is on the event's RSVP list they get a fresh link. The response is the
  same either way, so the list can't be probed.
- Every gallery call validates the token against the `:id` in the route.

### Member photo expiry

1. KV `expirationTtl` set at upload to `<event date + 30 days>` deletes the bytes.
2. The daily cron removes expired `member_photos` rows (plus a best-effort KV delete).
3. The frontend hides rows with `expires_at < now` immediately.

### Confirmable broadcasts — why two clicks

`GET /c/:token` is a landing page that records nothing; the Confirm button POSTs
the same URL. Mail clients and security scanners prefetch links, so a GET that
confirmed would produce junk counts. The token is in the path, not a query
string, because Apple's Link Tracking Protection strips query params.

## Routes

### Public

- `GET  /api/events`, `GET /api/events/:id`
- `POST /api/events/:id/rsvp` — `{ name, email, status }`; emails the gallery link, returns a `push_token`
- `GET  /api/push/public-key`, `POST /api/push/subscribe` — `{ token, subscription }`
- `GET  /img/:key` — public event images only (`event-images/*`)
- `GET  /c/:token`, `POST /c/:token` — broadcast confirmation

Rate limits (per IP / per email, 1-hour windows): RSVP 20/5, gallery
request-access 10/3, admin login 10 per 15 min per IP → `429 rate_limited`.

### Gallery (token-gated)

- `POST /api/events/:id/gallery/request-access` — `{ email }`
- `POST /api/events/:id/photos` — multipart upload (images only, size + count caps)
- `GET  /api/events/:id/photos`, `GET …/photos/:photoId/file` (`?download=1`), `GET …/photos/zip`

### Setup / Admin

- `POST /api/setup` — one-shot; returns `409 already_set_up` afterwards
- `POST /api/admin/login` — `{ password }` → `{ token }` (Bearer for everything below)
- `POST/PUT /api/admin/events[/:id]` — material changes auto-notify attendees
- `POST/PUT/DELETE /api/admin/events/:id/images[/:imageId]`
- `GET  /api/admin/events/:id/rsvps`, `DELETE /api/admin/events/:id/photos/:photoId`
- `POST /api/admin/events/:id/notify`, `POST /api/admin/events/:id/broadcast`
- `GET  /api/admin/events/:id/broadcasts`, `GET /api/admin/broadcasts/:broadcastId`

## Gotchas

- **iOS push:** Safari only delivers Web Push to sites installed via "Add to Home Screen". The event page shows a hint on iOS.
- **Lost admin password:** it's stored as a PBKDF2 hash and can't be read back. To reset: Cloudflare dashboard → Storage & Databases → D1 → your database → Console → `DELETE FROM config WHERE key = 'SETUP_COMPLETE';` — the site sends you back to `/setup`, where you fill the form in again with a new password. Events, RSVPs and photos are untouched.
- **Member photos are never public** — served only through token-gated routes; `/img/:key` is a whitelist.
- **Push subscriptions need proof of email** (`push_token` from a fresh RSVP) so nobody can register a device under someone else's address.
- **`r2_key` columns hold KV keys** — the name predates the switch from R2 (which needs a credit card).
- **Workers are stateless per request** — Hono is built inside `fetch`; don't hoist per-request state to module scope.
- **Every request does one D1 read** for config (`run_worker_first` routes static assets through the Worker too). Fine at group scale.

## Costs

Cloudflare free tier: 100k Worker requests/day, 5 GB D1, 1 GB KV. Resend free: 3,000 emails/month. $0/month for a group.
