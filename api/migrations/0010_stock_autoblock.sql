-- 0010_stock_autoblock.sql - ingredient stock can block the menu (opt-in)
--
-- sold_out on menu_items/options stays the MANUAL flag (FEATURES 3.5: the
-- counter taps it). This adds the derived one: an ingredient may opt in to
-- blocking everything its recipe feeds once the estimate runs out.
--
-- 1. auto_block (opt-in, default 0): existing shops/ingredients keep behaving
--    exactly as before - a never-restocked ingredient sits at qty 0 and must
--    NOT suddenly block the menu.
-- 2. reserve ("lower floor", >= 0, default 0): qty is an estimate that may dip
--    below 0 until the next count; qty + reserve is what may still go out.
--    Example: qty 0, reserve 5, 1 unit per plate -> 5 more plates sell, the
--    6th is refused (qty is -5 by then). reserve 0 blocks at qty < amount.
--
-- The rule lives in src/stock.rs (stock_out_targets / check_total_need): a
-- menu item or option is stock_out when ANY of its recipe_uses rows points at
-- an ACTIVE ingredient with auto_block = 1 and qty + reserve < amount, and a
-- whole bill is refused when its total need (amount x quantity, summed over
-- the lines) overshoots qty + reserve.

ALTER TABLE ingredients ADD COLUMN auto_block INTEGER NOT NULL DEFAULT 0 CHECK (auto_block IN (0, 1));   -- 1 = block the menu when the estimate runs out
ALTER TABLE ingredients ADD COLUMN reserve REAL NOT NULL DEFAULT 0 CHECK (reserve >= 0);                 -- units that may still go out below 0
