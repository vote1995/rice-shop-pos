-- 0005_stock_served.sql - "served" separate from "paid" + ingredient stock (M1 redesign)
--
-- 1. orders.served_at: a bill paid BEFORE the food is out (pay-first shops)
--    must stay on the kitchen queue until it is served. status keeps its
--    meaning (paid closes the money side); served_at tracks the plate side.
-- 2. Ingredient stock estimate: ingredients hold one running qty (estimate),
--    recipe_uses say how much one plate / one option uses, stock_moves is the
--    append-only journal (sale / cancel / restock / count). A sale deducts in
--    the SAME batch as the order lines, so reading stock never aggregates
--    orders - it is a plain row read.

ALTER TABLE orders ADD COLUMN served_at INTEGER;   -- unix ms; NULL = not served yet
-- Bills served or paid before this migration count as served (no ghost queue).
UPDATE orders SET served_at = COALESCE(paid_at, updated_at) WHERE status IN ('served', 'paid');

CREATE TABLE ingredients (
    id          TEXT PRIMARY KEY,                       -- client UUID
    shop_id     TEXT NOT NULL REFERENCES shops(id),
    name        TEXT NOT NULL,                          -- เช่น "บะหมี่"
    unit        TEXT NOT NULL,                          -- free text set by the owner: "ถุง", "กก.", "ฟอง"
    qty         REAL NOT NULL DEFAULT 0,                -- estimated on hand (may dip below 0 until the next count)
    alert_level REAL NOT NULL DEFAULT 0 CHECK (alert_level >= 0),  -- warn at or below this
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_ingredients_shop ON ingredients (shop_id);

-- Usage per plate: of a menu item (every plate of that type) OR of an option
-- (only when picked). amount is in the ingredient's unit; amount_text keeps
-- what the owner typed ("1/10") for display.
CREATE TABLE recipe_uses (
    id            TEXT PRIMARY KEY,
    shop_id       TEXT NOT NULL REFERENCES shops(id),
    ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
    menu_item_id  TEXT REFERENCES menu_items(id),
    option_id     TEXT REFERENCES options(id),
    amount        REAL NOT NULL CHECK (amount > 0),
    amount_text   TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    CHECK ((menu_item_id IS NULL) <> (option_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX idx_recipe_item ON recipe_uses (menu_item_id, ingredient_id) WHERE menu_item_id IS NOT NULL;
CREATE UNIQUE INDEX idx_recipe_option ON recipe_uses (option_id, ingredient_id) WHERE option_id IS NOT NULL;
CREATE INDEX idx_recipe_shop ON recipe_uses (shop_id);

CREATE TABLE stock_moves (
    id            TEXT PRIMARY KEY,                     -- client UUID (restock/count) or server random
    shop_id       TEXT NOT NULL REFERENCES shops(id),
    ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
    order_id      TEXT REFERENCES orders(id),           -- sale / cancel only
    kind          TEXT NOT NULL CHECK (kind IN ('sale', 'cancel', 'restock', 'count')),
    delta         REAL NOT NULL,                        -- change applied to ingredients.qty
    created_by    TEXT NOT NULL,                        -- users.id (staff or owner)
    created_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_stock_moves_order ON stock_moves (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_stock_moves_shop_time ON stock_moves (shop_id, created_at);
