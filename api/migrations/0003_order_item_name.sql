-- 0003_order_item_name.sql - order-line item-name snapshot (ROADMAP M1-2a)
--
-- Append-only ALTER TABLE ... ADD COLUMN on schema v1 (0001) + pricing (0002):
--   * order_items.item_name snapshots the menu item NAME at sale time, so the
--     queue screen (3.19) and old bills keep showing what was actually sold
--     even after the owner renames the menu item later.
-- order_items stays append-only (3.73): the column is written once at insert
-- and never updated. Conventions unchanged: money is INTEGER satang, ids are
-- client UUIDs, booleans are INTEGER 0/1.

ALTER TABLE order_items ADD COLUMN item_name TEXT NOT NULL DEFAULT '';  -- snapshot of the menu item name at sale time (queue screen shows it)
