-- 0013 — loyalty points become fractional (earn rule: 0.5 point per whole 50 ฿, see
-- docs/members-spec.md). The point columns were INTEGER in STRICT tables, which rejects x.5,
-- so each is swapped for a REAL column holding the same values (ADD -> copy -> DROP -> RENAME;
-- no table rebuild, so foreign keys / indexes are untouched). Existing whole-number balances
-- are copied unchanged. Redemption stays whole steps of 10 (orders.points_redeemed is unchanged).

ALTER TABLE customers ADD COLUMN points_r REAL NOT NULL DEFAULT 0 CHECK (points_r >= 0);
UPDATE customers SET points_r = points;
ALTER TABLE customers DROP COLUMN points;
ALTER TABLE customers RENAME COLUMN points_r TO points;

ALTER TABLE point_ledger ADD COLUMN points_r REAL NOT NULL DEFAULT 0;
ALTER TABLE point_ledger ADD COLUMN balance_after_r REAL NOT NULL DEFAULT 0 CHECK (balance_after_r >= 0);
UPDATE point_ledger SET points_r = points, balance_after_r = balance_after;
ALTER TABLE point_ledger DROP COLUMN points;
ALTER TABLE point_ledger DROP COLUMN balance_after;
ALTER TABLE point_ledger RENAME COLUMN points_r TO points;
ALTER TABLE point_ledger RENAME COLUMN balance_after_r TO balance_after;

ALTER TABLE orders ADD COLUMN points_earned_r REAL NOT NULL DEFAULT 0 CHECK (points_earned_r >= 0);
UPDATE orders SET points_earned_r = points_earned;
ALTER TABLE orders DROP COLUMN points_earned;
ALTER TABLE orders RENAME COLUMN points_earned_r TO points_earned;
