# Customer members + loyalty points — spec (implementation contract)

Decisions (owner): no phone verification (phase 1) · counter channel only · owner refunds/cancels do NOT adjust
points · a member belongs to ONE shop · customers cannot view points themselves (they tell staff their phone).
Money is **satang**; 1 point = ฿1 = 100 satang **when redeemed**; earning is **0.5 point per whole ฿50**,
so balances are multiples of 0.5. Schema: `api/migrations/0011_members.sql` (point columns widened to REAL by `0013_fractional_points.sql`).

## Rules (from the business rules)
- Earn: `earned = floor(total_amount_satang / 5_000) * 0.5` where `total_amount` is the bill total AFTER points were
  deducted. Per bill, no carry-over; always a multiple of 0.5 (4 999 sat → 0, 5 000 → 0.5, 10 000 → 1.0,
  15 000 → 1.5). Counter channel only; never for staff meals.
- Redeem: `points_redeemed` must be a multiple of 10, ≥ 10, ≤ member's *available* points, and
  ≤ `floor(subtotal_satang / 100)` rounded down to a multiple of 10 (subtotal = sum(line_total) - discount_amount).
  A fractional balance only ever yields whole steps of 10 (19.5 points → one step of 10). Bill total may reach 0.
- A member needs ≥ 10 points to redeem. 1 point = ฿1 discount.
- `orders.total_amount = MAX(0, SUM(order_items.line_total) - discount_amount - points_redeemed*100)`.
  Every place that recomputes `total_amount` MUST subtract `points_redeemed*100`
  (`routes/orders.rs` add_items, `routes/owner/orders.rs` discount recompute, and the member endpoint).
- Points are only **reserved** while the bill is open: `available_points(customer, except_order) =
  customers.points - SUM(points_redeemed of the customer's other OPEN counter orders)` (open = status
  `preparing`/`served`). They are **deducted only when the payment succeeds** (cash or QR).
- Settle (once per bill, idempotent, inside the SAME D1 batch that marks the bill paid): redeem
  `points_redeemed`, earn `points_earned = floor(total_amount/5000) * 0.5` (SQL: `(total_amount / 5000) * 0.5`),
  write ledger rows (`kind` redeem = negative,
  earn = positive, `balance_after`), set `customers.points = MAX(0, points - redeemed) + earned`,
  `customers.updated_at = paid_at`, `orders.points_earned`. Guard with
  `NOT EXISTS (ledger row for this order & kind)`. `updated_at` is changed ONLY here (and nowhere else).
- Expiry sweep (cron, idempotent): `updated_at < now - 183 days` and `points > 0` → ledger `expire` row
  (points = -balance, order_id NULL), `points = 0`. Erasure sweep: `updated_at < now - 365 days` → in one batch:
  delete the customer's ledger rows, `UPDATE orders SET customer_id = NULL`, delete the customer.
  Erasure never happens before expiry (365 > 183, and the expire step runs first).
- No QR for a bill whose total is 0 (pay it as cash with `cash_received = 0`).
- Changing/removing the member or points on a bill is refused (409 `qr_pending`) once a PromptPay payment row
  with status `pending` exists for it; a paid/cancelled bill is refused with 409.

## Customer-facing PDPA notice
`CONSENT_VERSION = "2026-11-v2"` (same constant in web and api). Notice (Thai) says: controller = the shop name;
data collected = nickname and phone number (no real name); purpose = membership, earning/using points; kept while the
member uses the service — points are cleared after 6 months of no use and the data is deleted after 1 year of no
use; never sold/shared with third parties; rights = access, correct, delete, withdraw consent by telling the shop.

## API contract
### Public (no auth, same origin) — `routes/members.rs`
- `GET  /api/public/join/{shop_id}` → `{ "shop_name": string, "consent_version": string }` · 404 unknown shop.
- `POST /api/public/join/{shop_id}` body `{ nickname, phone, consent: true, consent_version }`
  → `200 { "ok": true }`. Same response whether the phone already exists (never reveal membership; existing row
  untouched). 400 on invalid input / `consent` not true / wrong `consent_version`.
  Validation: names trimmed, 1–60 chars, no control characters; phone normalised (strip spaces/dashes,
  `+66`/`66` prefix → `0`) must match `^0[689]\d{8}$`.
### Staff (`StaffAuth`, shop = session shop) 
- `POST /api/members/lookup` body `{ phone, order_id? }` →
  `{ "customer": { "id", "nickname", "phone_last4", "points", "available_points" } }`;
  `404` code `member_not_found`. `available_points` ignores reservations of `order_id` itself.
- `PUT /api/orders/{id}/member` body `{ customer_id: string | null, points: number }` → the updated `OrderJson`.
  `customer_id: null` detaches (points 0). Errors: 400 invalid points, 404 member, 409 `qr_pending` / order closed /
  not a counter order / staff meal.
- `OrderJson` gains: `customer_id: string|null`, `member_name: string|null`, `points_redeemed: number`,
  `points_earned: number` (a multiple of 0.5), `member_points: number|null` (the member's CURRENT balance,
  also a multiple of 0.5).
### Owner (`OwnerAuth`)
- `GET    /api/owner/shops/{shop_id}/customers?q=` → `{ customers: [{ id, nickname, phone, points,
  consent_at, updated_at }] }` (q matches phone digits or name, max 100, newest `updated_at` first).
- `DELETE /api/owner/customers/{id}` → erasure on request (same batch as the 1-year sweep) → `{ "ok": true }`.

## Web
- Public page `/join/{shop_id}` (works on the POS host; no login): step 1 PDPA notice + "ยอมรับ" button →
  step 2 form (ชื่อเล่น, เบอร์โทร) → step 3 thank-you: "ครั้งต่อไปแจ้งเบอร์โทรกับพนักงานที่ร้านได้เลย".
- Owner page "สมาชิก": the QR code (and copyable link) of `https://<host>/join/{shop_id}` for printing,
  member list with search, delete-member button (with confirmation).
- Staff pay sheet (`PaySheet`): before the payment screen a **member step** (phone input, "ข้าม"); after lookup
  show name + points + a −10/+10 stepper (only when `available_points ≥ 10`) and the resulting total; the pay
  screen shows a "สมาชิก" row with "แก้ไข" to go back (hidden once a QR is pending); the success screen shows
  "ได้รับ +N แต้ม · คงเหลือ M แต้ม".
