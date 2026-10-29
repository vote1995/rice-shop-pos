-- 0001_schema_v1.sql — D1 schema v1 (ROADMAP M0 · FEATURES.md §5, v0.7)
--
-- Conventions used across EVERY table in this file (and future migrations):
--   * id            TEXT PRIMARY KEY — client-generated UUID (idempotent sync, FEATURES 3.70);
--                   rows created server-side (rare) also get a UUID.
--   * shop_id       TEXT NOT NULL REFERENCES shops(id) — multi-shop from day 1 (3.64).
--                   Exceptions: `shops` itself, and `users` where owners may have
--                   shop_id NULL (see below).
--   * *_at / *_until INTEGER NOT NULL (or NULLable when the event hasn't happened) —
--                   UNIX time in MILLISECONDS (JS Date.now() on the clients).
--   * Money (prices, totals, cash) — INTEGER SATANG (1 THB = 100 satang). No floats. Ever.
--                   Beam charges are also created in satang (3.24).
--   * Enums — TEXT + CHECK constraints (SQLite has no native enums).
--   * JSON blobs (option snapshots, shift totals, shop settings) — TEXT with _json suffix.
--   * Table names are plural snake_case; avoids quoting the reserved word `order`.
--   * D1 enforces foreign keys (defer_foreign_keys off by default is NOT the case here —
--     D1 runs with PRAGMA foreign_keys = ON). Inserts must therefore be ordered
--     parent-first inside a sync batch.
--
-- APPEND-ONLY (FEATURES 3.73): orders, order_items and payments are financial records.
--   * Rows are NEVER DELETEd and financial columns (amounts, prices, quantities) are
--     never updated after insert — they are snapshots at sale time.
--   * Lifecycle/void/refund is expressed via status + reason/by/at columns
--     (cancel_reason/cancelled_by on orders; refund_* on payments).
--   * Only the server's own state machine may advance status columns.
--   * Menu/price master data (menu_items, option_groups, options) is mutable — sync
--     rule there is "server wins" (3.73), so UPDATEs are fine on those tables.
--
-- Scope: schema v1 only — Shop, User, Device, MenuItem, OptionGroup+Option,
-- Order, OrderItem, Payment, Shift (ROADMAP M0). Stock/loyalty/customer/
-- DailySummary/WebhookEvent/SyncBatch tables come with their milestones (M4/M5/M1/Phase 2).

-- ===========================================================================
-- shops — หนึ่งแถวต่อร้าน (M1: ร้าน 1, M5: ร้าน 2+)
-- ===========================================================================
CREATE TABLE shops (
    id                     TEXT PRIMARY KEY,          -- client UUID
    name                   TEXT NOT NULL,
    address                TEXT,
    phone                  TEXT,
    promptpay_number       TEXT,                      -- PromptPay สำหรับทางสำรอง 3.85 (static QR)
    -- เวลาเปิด-ปิดแบบ 'HH:MM' (เวลาท้องถิ่นร้าน) — ใช้คำนวณ "วันขาย" ต่อร้าน ข้ามเที่ยงคืนได้ (3.33)
    open_time              TEXT,
    close_time             TEXT,
    -- การตั้งค่าต่อร้าน (3.65) — คอลัมน์ที่ใช้บ่อยขยายเป็นคอลัมน์เอง ที่เหลือเก็บใน settings_json
    sync_interval_minutes  INTEGER NOT NULL DEFAULT 15 CHECK (sync_interval_minutes > 0),  -- 3.69
    autolock_minutes       INTEGER NOT NULL DEFAULT 5  CHECK (autolock_minutes > 0),       -- 3.54
    settings_json          TEXT NOT NULL DEFAULT '{}', -- เช่น stock threshold เริ่มต้น (M4)
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL
) STRICT;

-- ===========================================================================
-- users — เจ้าของ/พนักงาน, login ด้วย PIN 4–6 หลัก (3.53)
--
-- Design choice: shop_id is NULL for owners — an owner sees every shop (2, 3.64)
-- and authenticates via Cloudflare Access + app-level owner role, not via a shop.
-- Staff MUST belong to exactly one shop (enforced by the CHECK below).
-- ===========================================================================
CREATE TABLE users (
    id                  TEXT PRIMARY KEY,             -- client UUID
    shop_id             TEXT REFERENCES shops(id),    -- NULL = owner (sees all shops)
    name                TEXT NOT NULL,
    role                TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
    -- อีเมลที่ Cloudflare Access ยืนยันแล้ว (เก็บตัวพิมพ์เล็ก) → map เป็น owner role; owner ต้องมีเสมอ
    email               TEXT,
    -- PIN: เก็บ hash+salt เท่านั้น (owner ตั้ง/reset ให้ — 3.53). Owner ไม่ใช้ PIN จึงเป็น NULL ได้.
    pin_hash            TEXT,
    pin_salt            TEXT,
    failed_pin_attempts INTEGER NOT NULL DEFAULT 0,   -- กันเดา PIN (3.54)
    locked_until        INTEGER,                      -- NULL = ไม่ถูกล็อก; unix ms
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    -- staff ต้องสังกัดร้านและต้องมี PIN; hash กับ salt มาคู่กันเสมอ
    CHECK (role = 'owner' OR shop_id IS NOT NULL),
    CHECK (role <> 'owner' OR email IS NOT NULL),
    CHECK ((pin_hash IS NULL AND pin_salt IS NULL) OR (pin_hash IS NOT NULL AND pin_salt IS NOT NULL)),
    CHECK (role <> 'staff' OR pin_hash IS NOT NULL)
) STRICT;

-- ===========================================================================
-- devices — มือถือ Android ของร้าน ร้านละเครื่อง (3.52, 3.55–3.56)
-- สถานะ: pending → approved (เจ้าของกดอนุมัติ) → revoked (เครื่องหาย/เปลี่ยนเครื่อง)
-- ===========================================================================
CREATE TABLE devices (
    id                TEXT PRIMARY KEY,               -- client UUID (สร้างตอนติดตั้ง PWA บนเครื่อง)
    -- NULL ได้เฉพาะตอน pending — เจ้าของเลือกร้านตอนกดอนุมัติ
    shop_id           TEXT REFERENCES shops(id),
    name              TEXT NOT NULL,                  -- ชื่อเครื่องที่ตั้ง (เช่น "ร้าน A หน้าครัว")
    model             TEXT,                           -- รุ่น/UA ถ้าได้
    -- device token: เก็บ HASH ของ token เท่านั้น (ตัว token อยู่กับเครื่อง) — 3.55/3.71
    device_token_hash TEXT,
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revoked')),
    registered_at     INTEGER NOT NULL,
    approved_by       TEXT REFERENCES users(id),      -- ใครอนุมัติ (owner)
    approved_at       INTEGER,                        -- NULL = ยังไม่อนุมัติ
    revoked_at        INTEGER,                        -- เพิกถอนเมื่อไร (3.56)
    last_sync_at      INTEGER,                        -- last sync (3.74 / SyncBatch M3)
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    CHECK (status = 'pending' OR shop_id IS NOT NULL)
) STRICT;

-- ===========================================================================
-- staff_sessions — session หลัง login PIN บนเครื่องที่อนุมัติแล้ว (3.53, 3.71)
-- เก็บ HASH ของ token เท่านั้น; revoke user/device/reset PIN → ตั้ง revoked_at
-- ===========================================================================
CREATE TABLE staff_sessions (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users(id),
    shop_id     TEXT NOT NULL REFERENCES shops(id),
    device_id   TEXT NOT NULL REFERENCES devices(id),
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked_at  INTEGER                               -- NULL = ยังใช้ได้ (ถ้ายังไม่หมดอายุ)
) STRICT;

-- ===========================================================================
-- menu_items — เมนูต่อร้าน (3.1–3.6, 3.9) — mutable ("server wins" 3.73)
-- ===========================================================================
CREATE TABLE menu_items (
    id               TEXT PRIMARY KEY,                -- client UUID
    shop_id          TEXT NOT NULL REFERENCES shops(id),
    name             TEXT NOT NULL,
    category         TEXT NOT NULL,                   -- หมวด: ข้าวราดแกง/อาหารตามสั่ง/เครื่องดื่ม/... (ป้ายอิสระ)
    menu_type        TEXT NOT NULL CHECK (menu_type IN ('rice_curry', 'made_to_order')), -- ราดแกง 1-2-3 อย่าง vs ตามสั่ง (3.4)
    base_price       INTEGER NOT NULL CHECK (base_price >= 0),      -- satang ราคาหน้าร้าน
    -- ราคาต่อช่องทางเดลิเวอรี่ (3.6, 3.16): NULL = ใช้ base_price
    -- เก็บเป็นราคาสุดท้าย (satang) ที่ resolve จาก markup แล้วตอนเจ้าของบันทึก
    grab_price       INTEGER CHECK (grab_price IS NULL OR grab_price >= 0),
    lineman_price    INTEGER CHECK (lineman_price IS NULL OR lineman_price >= 0),
    foodpanda_price  INTEGER CHECK (foodpanda_price IS NULL OR foodpanda_price >= 0),
    image_key        TEXT,                            -- R2 object key ของรูป WebP (3.2, 3.79)
    sold_out         INTEGER NOT NULL DEFAULT 0 CHECK (sold_out IN (0, 1)),   -- ปุ่มของหมด (3.5)
    cost             INTEGER CHECK (cost IS NULL OR cost >= 0),  -- ต้นทุนต่อจาน satang (กำไร Phase 2, 3.49)
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
) STRICT;

-- ===========================================================================
-- option_groups / options — option ต่อจาน เช่น เพิ่มไข่/ระดับเผ็ด (3.3) — mutable
--
-- Design choice: option_groups.menu_item_id เป็น NULL ได้ = กลุ่มที่ใช้ซ้ำได้ทั้งร้าน
-- (เช่น "ระดับเผ็ด"); ถ้าอ้างเมนูเจาะจง = ใช้กับเมนูนั้นเท่านั้น (เช่น "เพิ่มไข่" ของข้าวผัด)
-- ===========================================================================
CREATE TABLE option_groups (
    id            TEXT PRIMARY KEY,                   -- client UUID
    shop_id       TEXT NOT NULL REFERENCES shops(id),
    menu_item_id  TEXT REFERENCES menu_items(id),     -- NULL = กลุ่มใช้ซ้ำทั้งร้าน
    name          TEXT NOT NULL,                      -- เช่น "เพิ่มไข่", "ระดับเผ็ด"
    required      INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE options (
    id               TEXT PRIMARY KEY,                -- client UUID
    shop_id          TEXT NOT NULL REFERENCES shops(id),
    option_group_id  TEXT NOT NULL REFERENCES option_groups(id),
    name             TEXT NOT NULL,                   -- เช่น "ไข่ดาว", "ไม่เผ็ด"
    price_add        INTEGER NOT NULL DEFAULT 0 CHECK (price_add >= 0),  -- satang ราคาบวก
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
) STRICT;

-- ===========================================================================
-- orders — APPEND-ONLY (3.73): ห้าม DELETE/แก้ยอดเงิน; ยกเลิก = status+เหตุผล (3.15, 3.47)
-- สถานะ: preparing (กำลังทำ) → served (เสร็จ/เสิร์ฟแล้ว) → paid (จ่ายแล้ว) / cancelled (3.19)
-- ===========================================================================
CREATE TABLE orders (
    id             TEXT PRIMARY KEY,                  -- client UUID (สร้างบนมือถือ — offline-safe, 3.70)
    shop_id        TEXT NOT NULL REFERENCES shops(id),
    queue_number   INTEGER NOT NULL CHECK (queue_number > 0),  -- เลขคิว/เลขบิล รันต่อร้าน (3.11)
    table_no       TEXT,                              -- โต๊ะ optional (7.8)
    order_type     TEXT NOT NULL CHECK (order_type IN ('dine_in', 'take_away', 'delivery')),  -- 3.10
    channel        TEXT NOT NULL CHECK (channel IN ('counter', 'grab', 'lineman', 'foodpanda')), -- 3.16, 3.46
    status         TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing', 'served', 'paid', 'cancelled')),
    -- ยกเลิกออเดอร์ที่ยังไม่จ่าย: ต้องมีเหตุผล+ผู้ยกเลิกทุกครั้ง (3.15) — บังคับที่ CHECK เลย
    cancel_reason  TEXT,
    cancelled_by   TEXT REFERENCES users(id),
    cancelled_at   INTEGER,
    discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),  -- satang; ส่วนลดเป็นสิทธิ์เจ้าของ (3.27)
    total_amount   INTEGER NOT NULL CHECK (total_amount >= 0),  -- satang ยอดรวมหลังหักส่วนลด
    note           TEXT,                              -- หมายเหตุทั้งบิล
    created_by     TEXT NOT NULL REFERENCES users(id),           -- ผู้คีย์
    shift_id       TEXT REFERENCES shifts(id),                    -- กะ (NULL ได้ชั่วคราวกรณีขายก่อนเปิดกะ)
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,                  -- เปลี่ยนได้เฉพาะ status transitions (โดย server)
    paid_at        INTEGER,                           -- NULL = ยังไม่จ่าย/ยกเลิก
    closed_at      INTEGER,                           -- เวลาปิดบิล (จ่ายแล้วหรือยกเลิก)
    CHECK (
        (order_type IN ('dine_in', 'take_away') AND channel = 'counter')
        OR (order_type = 'delivery' AND channel IN ('grab', 'lineman', 'foodpanda'))
    ),
    CHECK (status <> 'cancelled' OR (cancel_reason IS NOT NULL AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL))
) STRICT;

-- ===========================================================================
-- order_items — APPEND-ONLY: แถวต่อจาน พร้อม snapshot ราคา/option ณ เวลาขาย (ราคาเมนูเปลี่ยนทีหลังไม่กระทบบิลเก่า)
-- ===========================================================================
CREATE TABLE order_items (
    id               TEXT PRIMARY KEY,                -- client UUID
    shop_id          TEXT NOT NULL REFERENCES shops(id),
    order_id         TEXT NOT NULL REFERENCES orders(id),
    menu_item_id     TEXT NOT NULL REFERENCES menu_items(id),
    -- option ที่เลือก ณ เวลาขาย (snapshot): [{"id","name","price_add"}] — เก็บเป็น JSON
    options_json     TEXT NOT NULL DEFAULT '[]',
    quantity         INTEGER NOT NULL CHECK (quantity > 0),
    note             TEXT,                            -- หมายเหตุต่อจาน เช่น ไม่เผ็ด/แยกน้ำแกง (3.12)
    unit_price       INTEGER NOT NULL CHECK (unit_price >= 0),   -- satang/จาน รวม option ที่เลือกแล้ว
    discount_amount  INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),  -- ส่วนลดต่อจาน (3.27)
    line_total       INTEGER NOT NULL CHECK (line_total >= 0),   -- satang = (unit_price*qty) - discount
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
) STRICT;

-- ===========================================================================
-- payments — APPEND-ONLY (3.73, 3.82): ห้าม DELETE; คืนเงิน = สถานะ refunded + เหตุผล (3.28)
-- method: cash (3.23) / promptpay ผ่าน Beam (3.24) / card, ewallet (Phase 2, 3.30) /
--         delivery_app (ยอดผ่านแอปเดลิเวอรี่ 4.2)
-- status: pending (สร้าง charge รอ webhook) / succeeded / expired (QR หมดอายุ 3.84) /
--         manual (ทางสำรองยืนยันด้วยมือ 3.85) / refunded (คืนเงินโดยเจ้าของ 3.28)
-- ===========================================================================
CREATE TABLE payments (
    id                TEXT PRIMARY KEY,               -- client UUID
    shop_id           TEXT NOT NULL REFERENCES shops(id),
    order_id          TEXT NOT NULL REFERENCES orders(id),
    method            TEXT NOT NULL CHECK (method IN ('cash', 'promptpay', 'card', 'ewallet', 'delivery_app')),
    amount            INTEGER NOT NULL CHECK (amount >= 0),          -- satang (ยอดคิดฝั่ง server เท่านั้น 3.24)
    cash_received     INTEGER CHECK (cash_received IS NULL OR cash_received >= 0),  -- เงินรับ (3.23)
    cash_change       INTEGER CHECK (cash_change   IS NULL OR cash_change   >= 0),  -- เงินทอน
    -- Beam (3.24, 3.82): charge id ใช้ idempotency ของ webhook; reference_id = order link
    beam_charge_id    TEXT,
    beam_reference_id TEXT,
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'expired', 'manual', 'refunded')),
    confirmed_by      TEXT CHECK (confirmed_by IS NULL OR confirmed_by IN ('webhook', 'manual')),  -- 3.82/3.85
    confirmed_at      INTEGER,
    ref               TEXT,                           -- อ้างอิงภายนอกอื่น (เช่น เลขรายการ Beam refund)
    -- คืนเงินบิลที่จ่ายแล้ว — เจ้าของเท่านั้น ต้องมีเหตุผล (3.28)
    refund_reason     TEXT,
    refunded_by       TEXT REFERENCES users(id),
    refunded_at       INTEGER,
    refund_amount     INTEGER CHECK (refund_amount IS NULL OR refund_amount >= 0),  -- satang; NULL = คืนทั้งบิล
    created_by        TEXT NOT NULL REFERENCES users(id),
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    CHECK (method = 'cash' OR (cash_received IS NULL AND cash_change IS NULL)),
    CHECK (beam_charge_id IS NULL OR method = 'promptpay'),
    CHECK (status <> 'refunded' OR (refund_reason IS NOT NULL AND refunded_by IS NOT NULL AND refunded_at IS NOT NULL))
) STRICT;

-- ===========================================================================
-- shifts — กะแยกอิสระต่อร้าน (3.31–3.33, 3.35) ปิดแล้วแก้ไม่ได้ (ยอดเป็น snapshot)
-- ===========================================================================
CREATE TABLE shifts (
    id                TEXT PRIMARY KEY,               -- client UUID (สร้างบนมือถือ)
    shop_id           TEXT NOT NULL REFERENCES shops(id),
    opened_by         TEXT NOT NULL REFERENCES users(id),
    opened_at         INTEGER NOT NULL,
    opening_cash      INTEGER NOT NULL CHECK (opening_cash >= 0),  -- satang เงินทอนตั้งต้น (3.31)
    status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    closed_by         TEXT REFERENCES users(id),
    closed_at         INTEGER,
    counted_cash      INTEGER CHECK (counted_cash IS NULL OR counted_cash >= 0),   -- เงินนับปิดกะ (3.32)
    expected_cash     INTEGER,                        -- เงินสดที่ควรมี (คำนวณตอนปิด) satang
    cash_difference   INTEGER,                        -- ส่วนต่าง = counted - expected (ติดลบได้)
    totals_by_method_json TEXT,                       -- snapshot ยอดแยกวิธีจ่ายตอนปิดกะ (Z-report 3.32/3.35)
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    CHECK (
        (status = 'open' AND closed_by IS NULL AND closed_at IS NULL)
        OR (status = 'closed' AND closed_by IS NOT NULL AND closed_at IS NOT NULL)
    )
) STRICT;

-- ===========================================================================
-- Indexes — คำถามหลักของระบบ: "ของร้านนี้ช่วงเวลานี้ สถานะนี้"
-- ===========================================================================
CREATE INDEX idx_users_shop             ON users(shop_id);
CREATE INDEX idx_users_status           ON users(status);
CREATE UNIQUE INDEX idx_users_email     ON users(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX idx_staff_sessions_token ON staff_sessions(token_hash);
CREATE INDEX idx_staff_sessions_user    ON staff_sessions(user_id);
CREATE INDEX idx_staff_sessions_device  ON staff_sessions(device_id);
CREATE INDEX idx_devices_shop           ON devices(shop_id);
CREATE INDEX idx_devices_status         ON devices(status);
-- device token hash ต้องไม่ซ้ำ (partial: NULL ได้หลายแถว = เครื่องยังไม่มี token)
CREATE UNIQUE INDEX idx_devices_token_hash ON devices(device_token_hash) WHERE device_token_hash IS NOT NULL;

CREATE INDEX idx_menu_items_shop        ON menu_items(shop_id);
CREATE INDEX idx_menu_items_shop_cat    ON menu_items(shop_id, category);

CREATE INDEX idx_option_groups_shop     ON option_groups(shop_id);
CREATE INDEX idx_option_groups_item     ON option_groups(menu_item_id);
CREATE INDEX idx_options_group          ON options(option_group_id);

-- ออเดอร์: จอคิว (สถานะล่าสุดของร้าน), รายงานยอดตามเวลา, สรุปต่อกะ
CREATE INDEX idx_orders_shop_created    ON orders(shop_id, created_at);
CREATE INDEX idx_orders_shop_status     ON orders(shop_id, status);
CREATE INDEX idx_orders_shop_status_created ON orders(shop_id, status, created_at);
CREATE INDEX idx_orders_shift           ON orders(shift_id);
CREATE INDEX idx_orders_created_by      ON orders(created_by);

CREATE INDEX idx_order_items_order      ON order_items(order_id);
CREATE INDEX idx_order_items_shop       ON order_items(shop_id);

-- การชำระเงิน: ตามบิล / รายงานตามเวลา
CREATE INDEX idx_payments_order         ON payments(order_id);
CREATE INDEX idx_payments_shop_created  ON payments(shop_id, created_at);
-- idempotency ของ Beam webhook (3.82): charge id ซ้ำแทรกไม่ได้ (partial: NULL ได้หลายแถว)
CREATE UNIQUE INDEX idx_payments_beam_charge ON payments(beam_charge_id) WHERE beam_charge_id IS NOT NULL;

-- กะ: กะล่าสุดของร้าน / กะที่ยังเปิด
CREATE INDEX idx_shifts_shop_opened     ON shifts(shop_id, opened_at);
CREATE INDEX idx_shifts_status          ON shifts(status);
