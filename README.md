# rice-shop-pos

POS สำหรับร้านข้าว (multi-shop PWA) — self-host บน Cloudflare free tier.
แผนงาน/ขอบเขต: ดู [ROADMAP.md](ROADMAP.md) · รายการฟีเจอร์: ดู [FEATURES.md](FEATURES.md) (ภาษาไทย)

## โครงสร้าง

```
api/   Rust Worker (workers-rs + axum) — API + D1 + R2   ← ตัวเดียวที่มีตอนนี้ (M0-1)
web/   Vite + React + TS PWA (พนักงาน/เจ้าของ)           ← มาทีหลัง (ticket ถัดไป)
```

- **DB:** Cloudflare D1 (`api/migrations/`) — schema v1: shops, users, devices, menu_items,
  option_groups, options, orders, order_items, payments, shifts
- **Storage:** R2 bucket `rice-pos-media` (รูปเมนู ฯลฯ)
- ทุกตารางใช้ client-generated UUID เป็น PK, `shop_id` ทุกตาราง, เงินเป็น **satang INTEGER**,
  ออเดอร์/การชำระเงิน **append-only** (ยกเลิก/คืนเงิน = status + เหตุผล ห้ามลบ)

## ข้อกำหนดเบื้องต้น (prerequisites)

- **Rust (MSVC toolchain)** + target `wasm32-unknown-unknown`:
  ```
  rustup target add wasm32-unknown-unknown
  ```
- **worker-build** (คอมไพล์ Rust → Worker): `cargo install worker-build`
- **Node.js** (ใช้ `npx wrangler` ได้เลย ไม่ต้อง install ถาวร)
- Windows: ต้องมี Visual Studio C++ Build Tools สำหรับ MSVC toolchain

## พัฒนา (local)

ทุกคำสั่งรันจาก `api/`:

```bash
cd api

# ตรวจ/คอมไพล์ (target wasm)
cargo check --target wasm32-unknown-unknown

# apply D1 migrations ลง local sqlite (.wrangler/state ไม่แตะ remote)
npx --yes wrangler d1 migrations apply rice-pos --local

# รัน Worker ในเครื่อง (จะ build ด้วย worker-build --release ให้ก่อน)
npx wrangler dev
#  → http://localhost:8787/health  ต้องได้ {"ok":true}
```

หมายเหตุ:

- `wrangler.toml` ใช้ `database_id` placeholder — ใช้กับ local เท่านั้น
  (เอา id จริงจาก `npx wrangler d1 create rice-pos` ตอน deploy ครั้งแรก)
- Git Bash บน Windows: ถ้าหา `cargo`/`worker-build` ไม่เจอ ให้ `export PATH="$HOME/.cargo/bin:$PATH"` ก่อน
- secrets ใช้ `.dev.vars` (ถูก .gitignore ไว้) — auth/Beam secret มาใน ticket ถัดไป

## Verify (ทำตอนจบแต่ละ ticket)

```bash
cd api
cargo check --target wasm32-unknown-unknown
cargo clippy --target wasm32-unknown-unknown
npx --yes wrangler d1 migrations apply rice-pos --local   # idempotent
npx wrangler dev & curl http://localhost:8787/health
```

## Owner auth (Cloudflare Access + owner role)

- Production: `owner.<domain>` is behind Cloudflare Access (email OTP). The API verifies the
  `Cf-Access-Jwt-Assertion` JWT against `https://$ACCESS_TEAM_DOMAIN/cdn-cgi/access/certs`
  (aud = `ACCESS_AUD`), then requires an active `users` row with `role='owner'` and that email.
  JWKS unreachable → 503 (never 401).
- Local dev: leave `ACCESS_AUD` empty and set `DEV_OWNER_EMAIL` in `api/.dev.vars`
  (copy `api/.dev.vars.example`). **Never set `DEV_OWNER_EMAIL` in production.**
- Seed the first owner:

  ```sh
  npx wrangler d1 execute rice-pos --local --command \
    "INSERT INTO users (id, name, role, email, created_at, updated_at) VALUES ('<uuid>','Owner','owner','owner@example.com',0,0)"
  ```

- Secrets: `PIN_PEPPER` (HMAC key for staff PINs) — `.dev.vars` locally, `wrangler secret put PIN_PEPPER` in production.
