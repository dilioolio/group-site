# Group Site — setup and help guide

This document is written for two readers at once: the person setting up the site
(no technical background assumed), and an AI assistant such as ChatGPT that the
person has pasted this into so it can act as a help desk. If you are the AI
assistant, read the "Notes for the assistant" section first.

---

## Notes for the assistant

You are helping a non-technical person set up and run **Group Site**, a free
self-hosted events website (a Meetup replacement) that runs on Cloudflare's free
tier and sends email through Resend. Everything is done in a web browser. There
is **no terminal, no command line, no code editing, and nothing to install**.

Rules:

- Walk them through one step at a time. Ask what they see on screen if unsure.
- Use the exact button and menu names from this document. The Cloudflare and
  Resend dashboards change occasionally; if a name doesn't match, help them find
  the closest thing rather than inventing steps.
- **Do not suggest:** installing Node, npm, Wrangler, Git, or any software;
  running any command; editing wrangler.toml, package.json, or any source file;
  "wrangler secret put" or environment variables; setting up R2 or a credit
  card; creating Worker secrets; using Cloudflare Pages instead of Workers;
  switching to another email service; Google Apps Script (an old version of this
  project used it — it is gone). None of these are needed and they will confuse
  the person.
- Every setting is changed in the site's own admin area (**/admin → Settings**),
  or in the Cloudflare/Resend dashboards for the two things listed below. There
  are no other places to configure anything.
- If something fails, get the exact error text. The "Error messages" section
  maps every code the site can produce to a plain-English cause and fix.
- The site has a built-in self-check at **/admin → Settings → Status**. Send
  them there first for any email or notification problem.
- Cost: everything is free. If anything asks for a credit card, they have
  wandered into the wrong place — stop and back out.

---

## What the site does

- A public home page listing upcoming and recent events, with optional category
  tabs (e.g. "Hikes" and "Conversations").
- An event page where members RSVP with name + email.
- Members get an email confirmation and can turn on push alerts on their phone
  or desktop for changes to that event (date, place, cancellation, messages).
- Each event can have a private photo gallery: people who RSVP'd get a personal
  link by email, can upload photos, and download everyone's photos as a zip.
  Photos delete themselves 30 days after the event.
- The organiser runs everything from **/admin**: create events, upload photos,
  see RSVPs, invite people by email, send updates, send "please confirm"
  broadcasts, and change the site's name, colours, icon and categories.

---

## Part 1 — Accounts you need (10 minutes)

### 1a. Cloudflare account

1. Go to https://dash.cloudflare.com/sign-up and create a free account with your
   email. Verify the email when the message arrives.
2. That's it for now. You do **not** need to add a website or a domain here yet.

### 1b. Resend account (sends the emails)

1. Go to https://resend.com and sign up (free: 3,000 emails a month, plenty).
2. In the left menu click **Domains → Add Domain**. Type the domain you own,
   e.g. `example.com` (not `www.example.com`, and not an address). Click Add.
3. Resend shows a list of DNS records (usually 3–4 rows, types like TXT, MX,
   CNAME). Leave that page open.
4. Open the website where you bought your domain (GoDaddy, Namecheap, Google
   Domains/Squarespace, Cloudflare, etc.), find **DNS settings** or **DNS
   records**, and add each record exactly as Resend shows it: same type, same
   name/host, same value. Copy-paste, don't retype.
   - If the DNS site asks for a "name" or "host" and Resend shows something
     like `resend._domainkey.example.com`, some providers want only
     `resend._domainkey` (they add the domain themselves). If verification
     fails later, this is the first thing to check.
5. Back in Resend click **Verify DNS Records**. It can say "Pending" for anything
   from a minute to a day. You can carry on with the rest of setup — emails
   just won't send until it says **Verified**.
6. In Resend click **API Keys → Create API Key**. Name it anything (e.g. "group
   site"), permission **Full access**, click Add. **Copy the key now** — it
   starts with `re_` and Resend only shows it once. Paste it somewhere safe
   (Notes app). If you lose it, just create another.

---

## Part 2 — Deploy the site (5 minutes)

1. Open https://github.com/dilioolio/group-site in your browser.
2. Click the **Deploy to Cloudflare** button near the top of the page.
3. Cloudflare opens. If asked, sign in. If it asks to connect a GitHub account,
   allow it — this creates a free GitHub account/copy of the site for you so it
   can be updated later. (If it does *not* ask about GitHub, that's fine too.)
4. You'll see a page with the project name (`group-site`) and a list of
   resources it will create: a **D1 database** and a **KV namespace**. Leave
   everything as it is and click **Create and deploy** (or **Deploy**).
5. Wait for the build — usually one to two minutes. When it finishes there is a
   link ending in **`.workers.dev`**, something like
   `https://group-site.yourname.workers.dev`. Click it.

That address is your site. Bookmark it. You can attach your own domain later
(Part 4) — everything keeps working either way.

If the build fails: click **Retry** / **Retry deployment** once. If it fails
again, note the red error text and ask your assistant.

---

## Part 3 — First-run setup form (2 minutes)

The first time you open your site it shows **Set up your site**. Fill in:

| Field | What to put |
|---|---|
| Site name | What appears in the header and on phone icons, e.g. `Daniel's Hikes`. Change any time. |
| Your first name | Emails are signed with it and sent as "Daniel <events@…>". |
| Admin password | At least 8 characters. **Write it down.** It can't be recovered (see "I forgot my password" below for the reset). |
| Sending email address | Any address at the domain you added to Resend, e.g. `events@example.com`. The mailbox doesn't need to exist. |
| Reply-to address (optional) | Where replies should land, e.g. your Gmail. Leave blank if unsure. |
| Resend API key | The `re_…` key from step 1b-6. |
| Timezone | Filled in from your browser. Check it's right (e.g. `Europe/Dublin`, `Asia/Seoul`). |

Click **Finish setup**. It checks your Resend key immediately. If it says the
domain isn't verified yet, that's only a warning — continue, and check Resend
later. You're taken to **/admin** to log in with the password you chose.

The form only appears once. Everything on it can be changed later in
**/admin → Settings**.

---

## Part 4 — Your own domain (optional, 5 minutes)

Your site works on the `.workers.dev` address. To use e.g. `hikes.example.com`
or `example.com`:

1. Cloudflare dashboard → **Workers & Pages** → click **group-site**.
2. **Settings** tab → **Domains & Routes** → **+ Add** → **Custom domain**.
3. Type the domain or subdomain and click **Add domain**.

What happens next depends on where your domain's DNS lives:

- **DNS already on Cloudflare** (you added the domain to Cloudflare at some
  point): done. It's live within a minute or two.
- **DNS elsewhere** (GoDaddy, Namecheap, etc.): Cloudflare will show a message
  that the domain isn't on Cloudflare and offer to add it. Follow that: it
  scans your existing records, then gives you two **nameservers** to set at
  your registrar (in the registrar's domain settings, "Nameservers" → "Custom"
  → paste both). This can take a few hours to a day to take effect. Your
  existing email and website keep working because Cloudflare copied the
  records. Alternative that avoids moving nameservers: skip the custom domain
  and just share the `.workers.dev` link — it's perfectly fine.

Nothing on the site needs updating after a domain change; links in emails use
whichever address the person visited.

---

## Part 5 — Using the admin area

Go to `your-site/admin` and log in. You stay logged in for 12 hours.

### Dashboard

Lists every event, newest first, with RSVP counts. Buttons: **Edit**, **View**
(public page), **Cancel** (asks for a short reason, then emails and pushes
everyone who RSVP'd). **+ New event** creates one.

A yellow banner appears at the top if the site thinks emails can't go out —
click "See what's wrong".

### Creating / editing an event

- **Title**, **Date & time** (day / time / month / year pickers, 5-minute
  steps), **Category** (only shown if you have more than one), **Meetup
  location**, **Description** (at least 20 characters).
- **Members can share photos for this event** — the private gallery on/off.
  It follows the category's default until the event is first saved.
- Save a new event first; then the **Photos** panel on the right unlocks.
  Photos upload as soon as you pick them. Click a photo to make it the
  **cover** (★). Save is blocked if you have photos but no cover.
- Editing the **date, location or status** of an existing event automatically
  emails and pushes everyone who RSVP'd. Tick **Suppress change notifications**
  to save silently (e.g. fixing a typo in the location).
- Two active events can't have the exact same start time.

Tabs on an event:

- **RSVPs** — the list, and **Invite by email**: paste addresses (one per line
  or comma-separated); each gets a link to the event. They still RSVP
  themselves.
- **Notify** — a quick free-text update to everyone who RSVP'd (email + push).
  It also appears on the public event page.
- **Broadcasts** — an important message where each person gets their own
  **Confirm** link. You see who confirmed and who hasn't. Use for "the bus
  leaves at 7, confirm you're coming" type messages.

### Settings (top right)

- **General** — site name, tagline (shown under the name), badge (1–2 characters
  or an emoji next to the name), your first name, timezone.
- **Categories** — up to 8. Name, a **Photos** checkbox (default for new events
  in that category), an optional **Image** used as the picture for events in
  that category that have no photo of their own, **Remove**. Click **Save
  categories**. With one category, the home page shows no tabs. With more, it
  shows **All / … / …** tabs and remembers the visitor's choice.
- **Appearance** — six colour presets or pick your own three colours (main,
  highlight, background); **Home-screen icon** (any square-ish image; it's
  cropped and resized automatically) and **Background image**. Colours apply
  as soon as you save. **Back to default** restores the green theme.
- **Email & password** — sending address, reply-to, a new Resend key (leave
  blank to keep the current one), and a new admin password.
- **Status** — the self-check (see below).

### Status (self-check)

Five rows, each green ✓ or red ✗ with what to do:

1. Site address — what the site thinks its URL is.
2. Push notification keys are set — generated during setup; should always be
   green.
3. Sending address is set.
4. Resend accepts the API key — the key is checked live with Resend.
5. Sending domain is verified in Resend — "missing" means the domain isn't
   added in Resend at all (check the spelling matches your sending address);
   "pending"/"not_started" means DNS records aren't seen yet; "failed" means a
   record is wrong.

Also shows how many events exist and how many devices have push alerts on.

---

## Part 6 — What members see

- **Home page**: next event featured, then upcoming, then recent events (last 90
  days). Cancelled events are shown dimmed with a CANCELLED banner.
- **Event page**: details, cover photo, RSVP form (name, email, going/maybe).
  After RSVP: a "turn on notifications" button, and a confirmation email.
- **Push alerts on iPhone**: Safari only allows them for sites added to the
  Home Screen. The event page shows a hint: Share button → **Add to Home
  Screen**, open the site from that icon, then turn on notifications. On
  Android and desktop Chrome it works directly from the browser.
- **Photo gallery**: link in the RSVP email (valid 30 days). Or open the event
  page → "Private photo gallery" → enter the email used to RSVP → a fresh link
  is emailed. Up to 10 photos per upload, 30 per person, 200 per event; max
  8 MB each (phones resize automatically). Uploads close 30 days after the
  event, and all photos delete then.
- The gallery link only appears on the day of the event and for 30 days after.
- Emails come from "Your Name <events@yourdomain>". Members should add that
  address to contacts so it doesn't go to spam — the emails say so.

---

## Common problems

**"Emails aren't arriving."**
1. Admin → Settings → Status. Fix anything red.
2. Domain shows "pending" for more than a day → re-check each DNS record at
   your registrar against Resend → Domains. The most common mistake is the
   host/name field including the domain twice
   (`resend._domainkey.example.com.example.com`).
3. Status all green but nothing arrives → check spam. New sending domains often
   land in spam for the first few days; it improves as people open and reply.
   Ask a few members to mark it "not spam" and add the address to contacts.
4. Check Resend → **Logs** (or **Emails**) in the Resend dashboard — every
   send is listed with a status (delivered / bounced / etc.).

**"I forgot the admin password."**
The password can't be shown, only replaced. Cloudflare dashboard → **Storage &
Databases → D1 SQL Database → group-site-db → Console** tab. Paste exactly:
`DELETE FROM config WHERE key = 'SETUP_COMPLETE';` and click Execute. Then open
your site: the setup form appears again. Fill it in with a new password (same
sending address and Resend key as before, or new ones). Events, RSVPs, photos
and push subscriptions are all kept.

**"Push notifications don't work on my iPhone."**
Must be added to the Home Screen first (Share → Add to Home Screen) and opened
from that icon. Requires iOS 16.4 or newer. The notification permission must be
allowed when asked; if it was denied, iPhone Settings → Notifications → find the
site's name → allow.

**"Notifications don't work when the link was opened from WhatsApp/Instagram."**
Those apps use a built-in mini-browser that doesn't support push. Open the link
in Safari/Chrome (the ⋯ menu → "Open in browser").

**"A member says their gallery link doesn't work."**
Links are per event and expire after 30 days; the gallery itself closes 30 days
after the event. They can request a fresh link from the event page with the
email they RSVP'd with. If the event's "Members can share photos" is switched
off, there is no gallery.

**"I want to start over completely."**
Cloudflare → Workers & Pages → group-site → Settings → scroll to the bottom →
**Delete**. Also delete the D1 database (Storage & Databases → D1) and the KV
namespace (Storage & Databases → KV). Then redeploy from the button. This
erases everything.

**"How do I update to a newer version of the site?"**
If the deploy connected a GitHub account: Cloudflare → Workers & Pages →
group-site → **Deployments** → there's a **Deploy** / **Retry** option that
rebuilds from your copy of the code. New versions may add database tables or
columns; that happens automatically on the next visit — nothing to do. If
updates matter to you, ask your assistant to check the README on the project
page for the current instructions.

**"Cloudflare shows 'Error 1101' or 'Worker threw exception'."**
Usually temporary — reload once. If it persists, Cloudflare → Workers & Pages →
group-site → **Logs** (Observability) and read the last red line; it names the
problem. Share that text with your assistant.

---

## Error messages

Errors appear in the site as a short red message. Many are shown already in
plain English; the raw codes below are what you'll see in a browser's network
tab or in a message that hasn't been translated.

### Setup form

| Code | Meaning / fix |
|---|---|
| `password_too_short` | At least 8 characters. |
| `missing_name` | Enter your first name. |
| `bad_from_email` | Sending address isn't a valid email. |
| `bad_reply_to` | Reply-to isn't a valid email (or leave it blank). |
| `bad_resend_key` | Resend keys start with `re_`. Copy it again. |
| `bad_timezone` | Use a name like `Europe/Dublin`, `America/New_York`, `Asia/Seoul`. |
| `resend_key_rejected` | Resend says the key is wrong or revoked. Create a new one (Full access) and paste it. |
| `already_set_up` | Setup already done. Go to /admin. (For a password reset see above.) |

### Admin login / session

| Code | Meaning / fix |
|---|---|
| `bad_password` | Wrong password. |
| `unauthorized` | Session expired (12 h) or not logged in. Reload and log in again. |
| `rate_limited` | Too many attempts (10 logins per 15 min per network; 20 RSVPs/h per network, 5/h per email; 10 gallery-link requests/h). Wait and retry. |

### Events

| Code | Meaning / fix |
|---|---|
| `missing_title` / `missing_description` / `bad_event_date` | Required field empty or date invalid. |
| `bad_status` | Status must be Active or Cancelled. |
| `time_conflict` | Another active event starts at exactly this time. Change the time or cancel the other. |
| `event_not_active` | RSVPs closed — event is cancelled. |
| `event_passed` | RSVPs closed — event already happened. |
| `no_recipients` | Nobody has RSVP'd yet, so there's no one to notify/broadcast to. |
| `no_valid_emails` | The invite box had no valid addresses. |
| `missing_subject` / `missing_body` / `missing_message` | Broadcast/notify text empty. |

### Photos, images and site assets

| Code | Meaning / fix |
|---|---|
| `unsupported_type` | Use JPG, PNG, WebP (galleries also accept HEIC and GIF). |
| `file_too_large` | Organiser photos max 15 MB; member photos 8 MB; icon/background 3 MB after resizing. |
| `too_many_files` | Max 10 photos per gallery upload. |
| `no_file` / `no_files` / `empty_file` / `bad_form` | Nothing was attached; pick the file again. |
| `uploader_cap_reached` | That person already has 30 photos on this event. |
| `event_cap_reached` | Event has 200 photos. |
| `gallery_closed` | More than 30 days after the event — uploads are over. |
| `gallery_disabled` | This event has photo sharing switched off (event editor checkbox). |
| `access_denied` | Gallery link invalid, expired, or for a different event. Request a fresh one. |
| `no_photos` | Zip download with nothing to include. |
| `bad_asset_name` | Internal — the icon/background upload targeted an unknown slot. Reload and retry. |

### Settings

| Code | Meaning / fix |
|---|---|
| `missing_site_name` | Site name can't be blank. |
| `bad_color` | Colours must be picked with the colour control (six-digit hex). |
| `bad_categories` | Need 1–8 categories. |
| `bad_category_id` | Two categories have the same name; make them different. |
| `bad_category_name` | Every category needs a name (max 30 characters). |

### Push notifications

| Code | Meaning / fix |
|---|---|
| `push_not_configured` | Push keys missing — run the password-reset steps (setup again) to regenerate. |
| `bad_subscribe_token` | The "turn on notifications" button was pressed more than an hour after RSVP. RSVP again (same details) and press it right away. |
| `bad_subscription` / `bad_email` | Browser sent an incomplete subscription; try another browser or reload. |

### Generic

| Code | Meaning / fix |
|---|---|
| `bad_json` | The browser sent something malformed — reload the page and try again. |
| `not_configured` (in logs) | No Resend key or sending address saved. Settings → Email & password. |
| `resend_http_4xx/5xx` (in logs) | Resend refused a send. 401/403: key problem; 422: sending address/domain not verified; 429: too many sends at once, wait a minute; 5xx: Resend outage, retry later. |

---

## Limits (all free tier)

- Cloudflare: 100,000 page/API requests per day; 5 GB database; 1 GB image
  storage with 1,000 uploads per day. A group of a few hundred people won't get
  near these.
- Resend: 3,000 emails per month, 100 per day. A broadcast to 80 people is 80
  emails.
- Member photos: 30 per person, 200 per event, 8 MB each, deleted 30 days after
  the event. Organiser photos on events never expire.

---

## Glossary

- **Cloudflare Worker** — where the site runs. You never touch the code.
- **D1** — the site's database (events, RSVPs). Lives in Cloudflare.
- **KV** — the site's file storage (photos, icon). Lives in Cloudflare.
- **Resend** — the email-sending service. Needs your domain verified once.
- **DNS records** — settings at your domain registrar that prove to Resend you
  own the domain. Copy-paste from Resend; never invent values.
- **Push notification** — the phone/desktop alert. Needs the site added to the
  iPhone Home Screen; works from the browser elsewhere.
- **RSVP** — a member saying they're going (or maybe).
