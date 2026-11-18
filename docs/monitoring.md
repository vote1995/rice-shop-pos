# Outage monitoring (operator guide)

Implements the first two layers of `docs/monitoring-plan.md`: an in-Worker monitor that
runs inside the existing every-minute cron and alerts through a Discord webhook, plus a
`/api/health/deep` endpoint for an external uptime probe.

## What runs

Every cron tick (prod only — dev has no cron) `src/monitor.rs`:

| Check | Fails when |
|-------|-----------|
| `d1` | `SELECT 1` through D1 errors |
| `r2` | the MEDIA bucket binding errors on a HEAD (a missing object is fine) |
| `stuck_beam` | a `pending` Beam charge older than 15 min whose bill is STILL OPEN (preparing/served) — the customer may have paid and the webhook was lost. Cancelled/paid bills are ignored: their QR payment row stays `pending` forever (see "expired" below) |

and it writes a `cron_heartbeat` row. State lives in `monitor_state` (migration 0014).

Alert rules: two consecutive failing runs before the first alert (one blip alerts nobody),
a reminder every 30 min while it lasts, one "recovered" message when it clears, silence
if a never-announced failure clears. A `stuck_beam` alert ends with the hint to tell
shops to take cash/transfer.

`GET /api/health/deep` → `{"ok","d1","r2","cron"}`; 200 when all true, 503 otherwise.
`cron=false` means the heartbeat is older than 5 minutes (the every-minute trigger stopped).
No details or error text are returned. The result is cached 30 s per isolate (the endpoint is unauthenticated, so a hit loop cannot run up D1/R2 reads). `GET /api/health` stays the cheap liveness probe.

A full D1 outage cannot be announced from inside the Worker (the state table is down too);
that is what the external probe is for.

## Discord setup

1. In Discord, in your server open the target channel → **Edit Channel** (gear) →
   **Integrations** → **Webhooks** → **New Webhook**, name it e.g. "rice-pos monitor" →
   **Copy Webhook URL**.
2. Store it as a prod secret — run this yourself so the value never goes into chat or git:

   ```
   cd api
   npx wrangler secret put DISCORD_WEBHOOK_URL
   ```

3. Optional test from a terminal (expect HTTP `204`):

   ```
   curl -H "Content-Type: application/json" \
        -d '{"content":"test"}' \
        "<webhook url>"
   ```

4. Remove the old Telegram secrets if they exist (`npx wrangler secret list` shows them):

   ```
   npx wrangler secret delete TELEGRAM_BOT_TOKEN
   npx wrangler secret delete TELEGRAM_CHAT_ID
   ```

Until the secret exists, alerts are only written to the Worker log (`monitor alert: ...`).

Treat the webhook URL like a password: if it leaks, delete the webhook in Discord and
create a new one.

## External probe (covers "Cloudflare / the Worker itself is down")

Create two monitors in UptimeRobot / Better Stack (free tier), every 1–5 minutes:

- `https://pos.twostackmaxgame.win/api/health` — expect 200
- `https://pos.twostackmaxgame.win/api/health/deep` — expect 200

Point their alert contacts at your email and a Discord webhook integration.

## Not covered yet

Beam API reachability probe, per-shop device-offline alerts, weekly digest — see the plan.

## Stale QR payments (`expired` sweep)

Beam has no "expired" charge status and sends no event when a PromptPay QR times out, so an
unpaid QR (or the QR of a cancelled / otherwise-paid bill) used to stay `pending` forever —
which also froze that bill's member and points (`has_pending_qr`). The cron now marks a
`pending` PromptPay payment `expired` once Beam's own `qr.expiry` is more than 5 minutes
past (or 24 h after creation when no expiry was recorded). A late `SUCCEEDED` webhook still
settles the bill, because `settle` accepts `expired` rows.
