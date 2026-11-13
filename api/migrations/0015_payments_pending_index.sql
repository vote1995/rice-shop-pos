-- 0015 — partial index for the cron's stale-QR sweep and stuck-Beam check
-- (src/routes/promptpay.rs expire_stale, src/monitor.rs STUCK_SQL). Both look only at
-- PENDING Beam payments, which are a handful of rows however large `payments` grows,
-- so the every-5-minutes scans read just those rows instead of the whole table.
CREATE INDEX idx_payments_pending_beam ON payments (created_at)
    WHERE status = 'pending' AND beam_charge_id IS NOT NULL;
