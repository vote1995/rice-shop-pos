-- 0008: real PromptPay via Beam (3.24, 3.82).
-- A counter QR payment is a payments row created 'pending' with the Beam
-- charge id; Beam's webhook (or a server-side status check) moves it to
-- 'succeeded' and closes the bill. The QR payload and its expiry are kept so
-- a reloaded pay sheet can show the same QR again without a second charge.
ALTER TABLE payments ADD COLUMN beam_qr_raw TEXT;
ALTER TABLE payments ADD COLUMN beam_qr_expiry TEXT;
