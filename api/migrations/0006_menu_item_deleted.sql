-- 0006_menu_item_deleted.sql - owner can delete a menu type (M1 redesign)
--
-- A type that was never sold is deleted for real. One that is on old bills
-- (order_items.menu_item_id FK) is hidden instead: deleted_at set, status
-- 'inactive', filtered out of both the owner editor and the counter, while
-- old bills and reports keep their rows.
ALTER TABLE menu_items ADD COLUMN deleted_at INTEGER;   -- unix ms; NULL = live
