-- 0014 — outage-alert monitor state (feat/monitoring, see src/monitor.rs and
-- docs/monitoring.md). One row per cron check: its current status, how long it has
-- been that way (fail_count of the current streak, since = when that streak began),
-- when the last Telegram alert went out (NULL = none sent for this streak) and a
-- short, secret-free detail. The special row 'cron_heartbeat' — written by EVERY
-- cron tick — is what GET /api/health/deep reads to tell whether the every-minute
-- trigger itself is alive (stale > 5 min => cron=false, HTTP 503).

CREATE TABLE monitor_state (
    check_name    TEXT PRIMARY KEY,
    status        TEXT NOT NULL CHECK (status IN ('ok', 'failing')),
    fail_count    INTEGER NOT NULL DEFAULT 0,
    since         INTEGER NOT NULL,
    last_alert_at INTEGER,
    detail        TEXT,
    updated_at    INTEGER NOT NULL
) STRICT;
