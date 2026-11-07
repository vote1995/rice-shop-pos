-- 0009_slips.sql - purchase receipts ("slips") read into JSON by an AI (phase 1)
--
-- The owner photographs a supplier receipt; a reader turns it into JSON lines
-- (phase 2 turns those into stock restocks). Reader priority: the LOCAL agent
-- on the owner's PC (liveness in slip_reader_heartbeat), else the CLOUD reader
-- (Workers AI) while today's free-neuron budget lasts (ai_usage), else the
-- slip simply waits in the queue. Page images live in the MEDIA bucket under
-- slips/{shop_id}/{slip_id}/{page}.jpg - private, never on /api/media/*.

CREATE TABLE slips (
    id           TEXT PRIMARY KEY,                -- client-generated uuid
    shop_id      TEXT NOT NULL REFERENCES shops(id),
    uploaded_by  TEXT NOT NULL REFERENCES users(id),
    page_count   INTEGER NOT NULL DEFAULT 0 CHECK (page_count BETWEEN 0 AND 4),
    status       TEXT NOT NULL CHECK (status IN ('draft','queued','reading','read','failed')),
    reader       TEXT CHECK (reader IN ('local','cloud')),   -- who is reading / did read
    lease_until  INTEGER,                         -- local claim expiry (ms); NULL unless status='reading' AND reader='local'
    attempts     INTEGER NOT NULL DEFAULT 0,
    result_json  TEXT,                            -- reader output, see "Result shape"
    error        TEXT,
    submitted_at INTEGER,
    read_at      INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX slips_shop_created ON slips(shop_id, created_at DESC);
CREATE INDEX slips_queue ON slips(status, submitted_at);

-- Liveness of the local reader agent (single row, id = 'local').
CREATE TABLE slip_reader_heartbeat (
    id        TEXT PRIMARY KEY CHECK (id = 'local'),
    seen_at   INTEGER NOT NULL,
    info      TEXT                                -- agent-reported e.g. "qwen3.8:27b busy"
) STRICT;

-- Workers AI neuron usage per UTC day (free tier = 10,000/day, resets 00:00 UTC).
CREATE TABLE ai_usage (
    day     TEXT PRIMARY KEY,                     -- 'YYYY-MM-DD' UTC
    neurons REAL NOT NULL DEFAULT 0 CHECK (neurons >= 0),
    calls   INTEGER NOT NULL DEFAULT 0
) STRICT;
