-- 0004_media.sql - menu images on R2 + app-enforced free-tier quotas (ROADMAP M1; FEATURES 3.2, 3.79)
--
-- R2 has no spending cap, so the Worker itself refuses to go past its limits
-- (see api/src/media.rs). These two tables are the bookkeeping for that.

-- Every object the app has stored in the MEDIA bucket. SUM(bytes) = stored
-- size, checked before each upload (R2 free tier: 10 GB-month).
CREATE TABLE media_objects (
    key        TEXT PRIMARY KEY,                       -- R2 object key, menu/{shop_id}/{uuid}.{webp|jpg}
    shop_id    TEXT NOT NULL REFERENCES shops(id),
    bytes      INTEGER NOT NULL CHECK (bytes > 0),
    created_at INTEGER NOT NULL                        -- unix ms
) STRICT;

-- R2 operations issued per calendar month (UTC, the R2 billing month).
-- Class A = writes (PutObject), class B = reads (GetObject). Incremented
-- BEFORE the operation; an increment that would pass the cap is refused.
CREATE TABLE media_usage (
    month   TEXT PRIMARY KEY,                          -- 'YYYY-MM' UTC
    class_a INTEGER NOT NULL DEFAULT 0 CHECK (class_a >= 0),
    class_b INTEGER NOT NULL DEFAULT 0 CHECK (class_b >= 0)
) STRICT;
