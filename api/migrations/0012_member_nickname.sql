-- 0012 — members keep a nickname + phone only (data minimisation: no last name).
-- first_name becomes `nickname`; last_name is dropped (its CHECK is column-level, so SQLite allows it).
ALTER TABLE customers RENAME COLUMN first_name TO nickname;
ALTER TABLE customers DROP COLUMN last_name;
