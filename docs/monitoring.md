# Outage monitoring (operator guide)

Implements the first two layers of `docs/monitoring-plan.md`: an in-Worker monitor that
runs inside the existing every-minute cron and alerts through a Telegram bot, plus a
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

## Telegram setup

1. In Telegram open **@BotFather** → `/newbot` → copy the bot token.
2. Send any message to your new bot (or add it to a group and write there).
3. Open `https://api.telegram.org/bot<token>/getUpdates` in a browser and read
   `message.chat.id` (negative for groups).
4. Store both as prod secrets — run these yourself so the values never go into chat or git:

   ```
   cd api
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```

Until both exist, alerts are only written to the Worker log (`monitor alert: ...`).

## External probe (covers "Cloudflare / the Worker itself is down")

Create two monitors in UptimeRobot / Better Stack (free tier), every 1–5 minutes:

- `https://pos.twostackmaxgame.win/api/health` — expect 200
- `https://pos.twostackmaxgame.win/api/health/deep` — expect 200

Point their alert contacts at your email and a Telegram integration.

## Not covered yet

Beam API reachability probe, per-shop device-offline alerts, weekly digest — see the plan.

## Stale QR payments (`expired` sweep)

Beam has no "expired" charge status and sends no event when a PromptPay QR times out, so an
unpaid QR (or the QR of a cancelled / otherwise-paid bill) used to stay `pending` forever —
which also froze that bill's member and points (`has_pending_qr`). The cron now marks a
`pending` PromptPay payment `expired` once Beam's own `qr.expiry` is more than 5 minutes
past (or 24 h after creation when no expiry was recorded). A late `SUCCEEDED` webhook still
settles the bill, because `settle` accepts `expired` rows.
