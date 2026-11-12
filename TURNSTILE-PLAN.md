# Plan: Cloudflare Turnstile on the member sign-up page

Status: **plan only — nothing implemented.** Written 2026-11-13, after v1.1.0.

## Why
`POST /api/public/join/{shop_id}` is the only unauthenticated endpoint that writes to D1 (name + phone).
Today it is protected by one Cloudflare WAF rate-limit rule (tested 2026-11-13: 10 requests / 10 s per IP, then 429).
That stops bursts but not a slow script, and it can't tell a person from a bot. Turnstile adds a
free, privacy-friendly "is this a real browser" check **in front of the write**.

What it does NOT solve (separate decision, see "Out of scope"): somebody typing another person's phone number by hand.

## Design (small, fail-closed)
1. **Widget on the join form** (`web/src/join/JoinPage.tsx`, step 2 — the form). Managed mode (usually invisible).
   Load `https://challenges.cloudflare.com/turnstile/v0/api.js` (explicit render), site key from a build-time
   constant `VITE_TURNSTILE_SITE_KEY` (a site key is public). Submit button stays disabled until a token exists;
   reset the widget after every failed submit (tokens are single-use).
2. **Token travels in the POST body**: add `turnstile_token: string` to the join body.
3. **Server verification before any DB work** (`api/src/routes/members.rs::join`), right after the shop lookup/consent checks:
   - `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret` (Worker secret `TURNSTILE_SECRET`),
     `response` = token, `remoteip` = `CF-Connecting-IP`, and an `idempotency_key` (UUID) so a retry is safe.
   - Require `success == true`; also check the returned `hostname` is one of ours (`pos.twostackmaxgame.win`,
     `pos-dev.twostackmaxgame.win`) and `action` == `join` (set `data-action="join"` on the widget).
   - Any failure → `400` with a generic message (`"verification failed — try again"`), never echo the Cloudflare error codes to the page.
   - siteverify unreachable / 5xx → **fail closed** (`503`, "try again in a moment"): signup is not essential; a flood is worse.
4. **Config**: `TURNSTILE_SECRET` is a Worker **secret** (`wrangler secret put TURNSTILE_SECRET`, prod and `--env dev`),
   never in `wrangler.toml`. The site key goes in a committed web env file (`web/.env.production`-style) — public by design.
   If the secret is absent (local dev) skip verification **only when `ACCESS_AUD` is empty** (the same local-dev signal the owner bypass uses),
   otherwise refuse — so a missing secret in prod can never silently turn the check off.
5. **Keep the WAF rate-limit rule** (defence in depth) and optionally add a per-shop cap in code (e.g. ≤ 200 new members / shop / day,
   counted from `customers.created_at`) so even a solved-by-farm attack is bounded.

## Dependencies / side effects to check
- **CSP / script loading**: the app sets no CSP today; if one is added later it needs `challenges.cloudflare.com` in `script-src`, `frame-src`, `connect-src`.
- **Service worker**: `/join/*` is excluded from SW registration; the Turnstile script is third-party and must never be precached.
- **Offline**: the join page needs the network anyway.
- **iOS Safari / in-app browsers** (LINE, Facebook): Turnstile works but may show a visible checkbox; test the QR flow from the LINE in-app browser, since customers will scan with LINE.
- **Privacy / PDPA**: Turnstile sets no tracking cookies for ads, but it is a third-party call. Add one line to the PDPA notice
  ("ใช้ Cloudflare Turnstile เพื่อป้องกันบอท") and bump `CONSENT_VERSION` in **both** `api/src/loyalty.rs` and `web` (the page re-renders the new notice).

## Steps
1. Cloudflare dashboard → **Turnstile → Add widget**: name `member-signup`, hostnames `pos.twostackmaxgame.win`, `pos-dev.twostackmaxgame.win`
   (+ `localhost` for local tests), mode **Managed**. Note the site key and the secret.
2. `wrangler secret put TURNSTILE_SECRET` (prod) and `wrangler secret put TURNSTILE_SECRET --env dev`.
3. Implement 1–4 above (worker + web). Use Cloudflare's **dummy keys** for tests/local:
   site `1x00000000000000000000AA` / secret `1x0000000000000000000000000000000AA` (always pass),
   `2x00000000000000000000AB` / `2x0000000000000000000000000000000AA` (always fail), `3x…` (token already spent).
4. Unit tests for the pure parts (parse siteverify JSON, hostname/action check, fail-closed mapping); manual test of pass / fail / expired / replayed token on dev.
5. Deploy to **dev** first, scan the dev QR from a real phone (Safari + Chrome + LINE in-app browser), then the normal
   **production release gate** (independent Opus review of the range → tag).
6. After release: watch Turnstile analytics (Cloudflare → Turnstile) for solve rate and failures; confirm the WAF rule still counts.

## Rollback
Feature-flag by secret: deleting `TURNSTILE_SECRET` is NOT a rollback (fail-closed); roll back by deploying the previous tag
(`docs/ROLLBACK.md`). Keep the widget id in this file once created.

## Out of scope (decide separately)
- **Phone verification (OTP / LINE login)** — the only real fix for "someone registers a number that isn't theirs" and
  first-come squatting of a phone. Needs an SMS/LINE provider; plan as phase 2.
- **Staff-side fraud** (staff attaching a member who isn't present): show redeemed points + staff name in the owner report.
