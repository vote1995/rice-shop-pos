# rice-shop-pos

POS สำหรับร้านข้าว (multi-shop PWA) — self-host บน Cloudflare free tier.
แผนงาน/ขอบเขต: ดู [ROADMAP.md](ROADMAP.md) · รายการฟีเจอร์: ดู [FEATURES.md](FEATURES.md) (ภาษาไทย)

## โครงสร้าง

```
api/   Rust Worker (workers-rs + axum) — API + D1 + R2   ← M0-1
web/   Vite + React + TS PWA (พนักงาน/เจ้าของ)           ← M0-3 (React PWA shell, Thai UI)
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

## web/ — React PWA (POS หน้าร้าน + แดชบอร์ดเจ้าของ)

Vite + React + TypeScript, ภาษาไทยทั้งหมด — ไม่ใช้ UI library และ router library
(bundle เล็กเพื่อ Android ราคาถูก, FEATURES 3.52) ติดตั้งเป็น PWA ได้
(service worker แคชเฉพาะ app shell — `/api` อยู่ใน denylist และไม่มี runtime caching สำหรับ API เด็ดขาด)

### Dev (รัน 2 terminal)

```bash
# 1) API — terminal แรก
cd api
npx wrangler dev                     # http://127.0.0.1:8787

# 2) Web — terminal ที่สอง
cd web
npm install
npm run dev                          # http://localhost:5173 (proxy /api → 127.0.0.1:8787)
```

- POS (เครื่องหน้าร้าน): <http://localhost:5173/>
- แอปเจ้าของร้าน: <http://localhost:5173/owner>
  (production ใช้ subdomain `owner.<domain>` หลัง Cloudflare Access —
  `web/src/main.tsx` เลือก app จาก hostname / pathname, ไม่มี router)

### Build

```bash
cd web
npm run build    # tsc -b + vite build → web/dist ซึ่ง Worker ใน api/ เป็นตัว serve
```

พฤติกรรมหลักฝั่ง POS: ลงทะเบียนเครื่อง → รอเจ้าของอนุมัติ (poll `/api/device/status`
ทุก 5 วินาที) → เลือกพนักงาน → PIN → หน้าหลัก (session token เก็บใน sessionStorage เท่านั้น,
auto-lock เมื่อไม่มีการใช้งาน 5 นาที, เครื่องถูกเพิกถอน = ลบข้อมูลในเครื่องทั้งหมดทันที)
