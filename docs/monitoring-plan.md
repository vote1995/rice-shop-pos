# Monitoring & alerting plan (plan only — not implemented yet)

Goal: the owner hears about an outage (Cloudflare, D1, R2, Beam, our own Worker) by
email / chat before a shop staff member has to phone in.

## 1. What to watch

| # | Target | Failure we care about | Signal |
|---|--------|----------------------|--------|
| 1 | Worker reachable | site down / 5xx | external probe on `GET /api/health` |
| 2 | D1 | queries failing | `GET /api/health/deep` runs `SELECT 1` |
| 3 | R2 (MEDIA, app/ APKs) | binding errors | `/api/health/deep` does a `head` on `app/manifest.json` |
| 4 | Beam API | charges failing / slow | (a) deep health does a cheap authenticated read-only call per shop with creds; (b) our own counter of Beam errors in the last 15 min |
| 5 | Beam webhook | payments paid but never confirmed | orders stuck `pending_payment` with a Beam charge older than N min |
| 6 | Cron | the every-minute cron stopped | heartbeat row written each run; alert if older than 5 min |
| 7 | Cloudflare platform | Workers/D1/R2 incident | Cloudflare Notifications (status incidents) + usage-limit alerts |
| 8 | Shop devices | device offline during opening hours | last-seen per registered device (already tracked for approval) |
| 9 | Certificate/domain | expiry | probe checks TLS expiry; domain renewal reminder |

`/api/health/deep` must be cheap, unauthenticated-safe (returns only ok/failed per
component, never versions, ids or error text) and rate-limited. Beam is probed with the
shop-specific credentials from `BEAM_SHOPS`; the response says "beam: degraded" without
naming merchant ids.

## 2. How alerts are delivered

- **Email** (works today): Cloudflare Notifications → email; external probe → email.
  Optionally our Worker sends mail through Cloudflare Email Service.
- **Chat**: LINE Notify was shut down on 2025-03-31, so LINE needs the **Messaging
  API** (official account, limited free messages per month). **Telegram bot** is the
  simplest free option and needs only a bot token + chat id stored as Worker secrets.
  Recommendation: email + Telegram, add LINE Messaging API only if the owner prefers it.
- Alerts are de-duplicated: one message when a check flips to failing, one when it
  recovers, plus a reminder every 30 min while still failing (state kept in D1 or KV).

## 3. Two layers (so a total Cloudflare outage is still noticed)

1. **Outside Cloudflare** — a free external uptime monitor (UptimeRobot / Better Stack /
   Uptime Kuma on a spare machine) hits `/api/health` and `/api/health/deep` every
   1–5 min and emails/Telegrams on failure. This is the only layer that can see
   "Cloudflare itself is down".
2. **Inside the Worker** — the existing every-minute cron evaluates checks 3–6 and 8,
   writes a heartbeat, and pushes alerts. If the Worker/cron is dead layer 1 reports it.

## 4. Beam specifics

- No public Beam status feed was found when this plan was written; do not rely on one.
  Treat our own measurements as the source of truth: error rate and latency of Beam
  calls, and the stuck-pending-charge check (#5).
- Staff-facing fallback already exists (cash / PromptPay slip); the alert text should say
  "Beam degraded — tell shops to use cash/transfer".
- Rotate and keep Beam keys only in `wrangler secret` (see `BEAM_SHOPS`).

## 5. Rollout order

1. External probe on `/api/health` + email (10 minutes, no code).
2. Cloudflare Notifications: platform incidents, Workers/D1/R2 usage thresholds.
3. `/api/health/deep`, cron heartbeat, stuck-order check, Telegram sender.
4. Beam error-rate alert and device-offline alert.
5. Weekly "all checks green" digest email, so silence is distinguishable from a dead monitor.

## 6. Open decisions for the owner

- Telegram vs LINE Messaging API for chat alerts.
- Quiet hours (suppress device-offline alerts outside shop opening hours).
- Who receives alerts per shop vs globally.
