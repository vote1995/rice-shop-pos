-- 0002_menu_pricing.sql - menu pricing model (ROADMAP M1-1a; FEATURES 3.4-3.6)
--
-- Append-only ALTER TABLE ... ADD COLUMN on schema v1 (0001):
--   * rice_curry plate price by number of curries picked (3.4),
--   * pick policy for option groups (max_select + tier pricing, 3.3/3.4),
--   * per-curry-pot sold out flag (3.5),
--   * per-channel delivery markup stored per shop (3.6).
-- Conventions unchanged: money is INTEGER satang, booleans are INTEGER 0/1.

-- Rice-curry plate with 2 curries, in satang; base_price = plate with 1 curry (3.4).
ALTER TABLE menu_items ADD COLUMN price_2 INTEGER CHECK (price_2 IS NULL OR price_2 >= 0);
-- Rice-curry plate with 3 curries, in satang.
ALTER TABLE menu_items ADD COLUMN price_3 INTEGER CHECK (price_3 IS NULL OR price_3 >= 0);
-- Max picks per group; NULL = unlimited.
ALTER TABLE option_groups ADD COLUMN max_select INTEGER CHECK (max_select IS NULL OR max_select >= 1);
-- 1 = the number of picks in this group selects base_price/price_2/price_3 (3.4).
ALTER TABLE option_groups ADD COLUMN tier_pricing INTEGER NOT NULL DEFAULT 0 CHECK (tier_pricing IN (0, 1));
-- Curry pot sold out (3.5) - dims the option button at the counter.
ALTER TABLE options ADD COLUMN sold_out INTEGER NOT NULL DEFAULT 0 CHECK (sold_out IN (0, 1));
-- Delivery markup per channel (3.6), e.g. {"grab":{"kind":"percent","value":10}};
-- {} = no markup. menu_items.*_price columns keep the resolved final prices.
ALTER TABLE shops ADD COLUMN channel_markup_json TEXT NOT NULL DEFAULT '{}';
