-- 0007_staff_meal.sql - staff meal (สวัสดิการพนักงาน)
--
-- A staff member may key a meal for themselves at the counter, at most
-- MAX_STAFF_MEALS_PER_DAY (= 2, enforced inside the order INSERT by
-- routes::orders) per Bangkok day. One flag column on orders keeps it a real
-- bill instead of a second code path:
-- 1. the plate is priced, queued and stock-deducted exactly like a sold
--    plate: order_items keeps its real unit_price/line_total, so the owner
--    still sees what the benefit costs,
-- 2. the money side is closed AT INSERT (routes::orders::create):
--    discount_amount = subtotal, total_amount = 0, status 'paid',
--    closed_at set, paid_at NULL - nothing to pay, so no payments row will
--    ever close this bill. served_at stays NULL (0005: 'paid' closes the
--    money side, not the plate), i.e. the bill stays on the kitchen queue
--    until it is served,
-- 3. it may still be cancelled while status = 'paid' AND served_at IS NULL
--    (a mistake caught before cooking); stock is put back as for any cancel.
--
-- The partial index serves both the daily-limit count inside the INSERT and
-- GET /staff/meals: "the staff meals of one staff member in one shop,
-- newest first" is a handful of rows.

ALTER TABLE orders ADD COLUMN staff_meal INTEGER NOT NULL DEFAULT 0 CHECK (staff_meal IN (0, 1));   -- 1 = สวัสดิการพนักงาน (billed 0)
CREATE INDEX idx_orders_staff_meal ON orders (shop_id, created_by, created_at) WHERE staff_meal = 1;
