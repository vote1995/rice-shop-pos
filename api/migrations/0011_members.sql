-- 0011 — customer members + loyalty points (PDPA: name + phone, consent recorded).
-- Money is satang everywhere; 1 point = 1 baht = 100 satang. Rules: docs/members-spec.md.

CREATE TABLE customers (
    id              TEXT PRIMARY KEY,                       -- server UUID
    shop_id         TEXT NOT NULL REFERENCES shops(id),     -- a member belongs to ONE shop
    first_name      TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 60),
    last_name       TEXT NOT NULL CHECK (length(last_name) BETWEEN 1 AND 60),
    phone           TEXT NOT NULL CHECK (length(phone) = 10),   -- normalised: 0XXXXXXXXX
    points          INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
    consent_version TEXT NOT NULL,                          -- which PDPA notice was accepted
    consent_at      INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    -- LAST SERVICE USE (a paid bill with this member). Changed ONLY by a successful
    -- payment — never by registration/edits. Drives point expiry (6 mo) and erasure (1 y).
    updated_at      INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_customers_shop_phone ON customers(shop_id, phone);
CREATE INDEX idx_customers_updated ON customers(updated_at);

-- Append-only history of every point movement (earn / redeem / expire).
CREATE TABLE point_ledger (
    id            TEXT PRIMARY KEY,
    customer_id   TEXT NOT NULL REFERENCES customers(id),
    shop_id       TEXT NOT NULL REFERENCES shops(id),
    order_id      TEXT REFERENCES orders(id),               -- NULL for 'expire'
    kind          TEXT NOT NULL CHECK (kind IN ('earn', 'redeem', 'expire')),
    points        INTEGER NOT NULL,                         -- signed: earn +, redeem -, expire -
    balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
    created_at    INTEGER NOT NULL
) STRICT;
-- one earn and one redeem per bill, ever: makes settling idempotent
CREATE UNIQUE INDEX idx_point_ledger_order_kind ON point_ledger(order_id, kind) WHERE order_id IS NOT NULL;
CREATE INDEX idx_point_ledger_customer ON point_ledger(customer_id, created_at);

-- A bill may carry a member and a PENDING redemption (points reserved until paid).
ALTER TABLE orders ADD COLUMN customer_id TEXT REFERENCES customers(id);
ALTER TABLE orders ADD COLUMN points_redeemed INTEGER NOT NULL DEFAULT 0
    CHECK (points_redeemed >= 0 AND points_redeemed % 10 = 0);
ALTER TABLE orders ADD COLUMN points_earned INTEGER NOT NULL DEFAULT 0 CHECK (points_earned >= 0);
CREATE INDEX idx_orders_customer ON orders(customer_id) WHERE customer_id IS NOT NULL;
