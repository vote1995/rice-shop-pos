# Slip reader agent — เอเจนต์อ่านสลิป (เครื่องร้าน)

EN: Local reader agent for purchase-receipt slips. It heartbeats to the POS API every 10 s,
claims queued slips every 5 s, downloads the page images, reads them with a local Ollama vision
model and posts the extracted JSON back. Node.js agent, **zero npm dependencies**.

TH: เอเจนต์อ่านสลิปบนเครื่องร้าน — ส่ง heartbeat ทุก 10 วินาที, ของาน (claim) จากคิวทุก 5 วินาที,
ดาวน์โหลดรูปหน้าสลิป, ให้ Ollama (โมเดล vision ในเครื่อง) อ่านเป็น JSON แล้วส่งผลกลับ
เขียนด้วย Node.js ล้วน ๆ **ไม่ใช้ dependency ใด ๆ**

## 1) Setup / การติดตั้ง

- EN: Node.js **20.3+ (recommended 22)** and [Ollama](https://ollama.com) installed on this PC.
- TH: ติดตั้ง Node.js เวอร์ชัน 20.3 ขึ้นไป (แนะนำ 22) และ Ollama บนเครื่องนี้

```powershell
ollama pull qwen3.8:27b     # EN: the vision model used for reading (≈17 GB) / TH: โมเดลที่ใช้อ่าน
```

## 2) `.env` (config / ค่า config)

Copy `.env.example` to `.env` in this folder and edit (`.env` is git-ignored):

```powershell
copy .env.example .env
```

| Variable | Default | Meaning / ความหมาย |
| --- | --- | --- |
| `SLIP_API_BASE` | — (required) | EN: API base, e.g. `http://127.0.0.1:8787` (dev) or `https://pos.twostackmaxgame.win` / TH: URL ของ API |
| `SLIP_AGENT_TOKEN` | — (required) | EN: shared secret, must equal the worker secret `SLIP_AGENT_TOKEN` / TH: รหัสลับต้องตรงกับฝั่ง API |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | EN: Ollama server URL / TH: ที่อยู่ Ollama |
| `OLLAMA_MODEL` | `qwen3.8:27b` | EN: model tag used for reading / TH: โมเดลที่ใช้อ่าน |

EN: environment variables set on the process win over `.env`.
TH: ตัวแปร environment ของ process มีความสำคัญมากกว่าค่าใน `.env`

## 3) Run manually / รันเองเพื่อทดสอบ

```powershell
cd tools\slip-agent
node agent.mjs
```

- EN: it logs one line per event to the console and appends the same lines to `tools\slip-agent\agent.log`
  (the log is truncated automatically when it grows past 5 MB). Stop with `Ctrl+C`.
- TH: พิมพ์ log หนึ่งบรรทัดต่อเหตุการณ์ ทั้งบนหน้าจอและไฟล์ `agent.log` (ไฟล์เกิน 5 MB จะถูกตัดใหม่อัตโนมัติ)
  หยุดด้วย `Ctrl+C`
- EN: the agent only heartbeats/claims while Ollama is reachable **and** the model is present
  (checked via `GET /api/tags`, retried every 30 s until ready).
- TH: จะส่ง heartbeat/ของานเฉพาะตอนที่เชื่อม Ollama ได้ **และ** มีโมเดลอยู่ (เช็กซ้ำทุก 30 วินาทีจนกว่าจะพร้อม)

## 4) Scheduled task (start at logon) / ติดตั้งให้รันอัตโนมัติตอนล็อกอิน

```powershell
# Install / ติดตั้ง (run once as the current user):
powershell -ExecutionPolicy Bypass -File .\install-task.ps1

# Uninstall / ถอนการติดตั้ง:
powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -Uninstall

# Manual start/stop / สั่งรัน–หยุดเอง:
Start-ScheduledTask RicePosSlipAgent
Stop-ScheduledTask  RicePosSlipAgent
```

EN: registers the Windows Scheduled Task **RicePosSlipAgent**: starts hidden at logon of the current
user, no execution time limit, restarts up to 3 times (1 min apart) if node exits with a failure.
TH: สร้าง Task ชื่อ **RicePosSlipAgent** รันแบบซ่อนหน้าต่างตอนล็อกอินของผู้ใช้ปัจจุบัน ไม่จำกัดเวลา
ถ้า node หยุดทำงานจะ restart ได้สูงสุด 3 ครั้ง ห่างกัน 1 นาที

## 5) Troubleshooting / แก้ปัญหา

| Symptom / อาการ | Fix / วิธีแก้ |
| --- | --- |
| EN: agent exits immediately, `config-error` in `agent.log` | TH/EN: `SLIP_API_BASE` or `SLIP_AGENT_TOKEN` missing — create `.env` from `.env.example`. |
| EN: `claim-unauthorized HTTP 401` | EN: token mismatch between agent `.env` and worker secret `SLIP_AGENT_TOKEN`. / TH: token ไม่ตรงกันสองฝั่ง |
| EN: `ollama-not-ready ... Ollama unreachable` | EN: Ollama is not running — start it (`ollama serve` or the Ollama app); the agent retries every 30 s. / TH: Ollama ยังไม่ได้เปิด |
| EN: `ollama-not-ready ... model not present` | EN: run `ollama pull qwen3.8:27b`, or fix `OLLAMA_MODEL` in `.env`. / TH: ยังไม่มีโมเดลในเครื่อง |
| EN: `result-rejected HTTP 409` | EN: the server-side 5-min read lease expired; the slip is requeued automatically — nothing to do. |
| EN: API offline (`api-retry ... retry in 60s`) | EN: the agent keeps retrying with backoff and resumes by itself when the API is back. / TH: API ออฟไลน์ เอเจนต์รอแล้วรีตรายเอง |
| EN: want to check liveness | EN: look at `agent.log`, or the "เครื่องร้าน: ออนไลน์" badge in the owner UI. |
