#!/usr/bin/env node
// Slip reader local agent (TICKET 3 of the slip-reader feature, see SLIP_SPEC.md "Local agent").
// Node >= 20.3 (global fetch + AbortSignal.any), zero npm dependencies.
//
// Loops:
//   - readiness:  GET {OLLAMA_URL}/api/tags every 10 s while ready, every 30 s while not.
//   - heartbeat:  POST {SLIP_API_BASE}/api/slip-agent/heartbeat every 10 s, ONLY while Ollama
//                 is reachable and the model is present. Runs independently of the read loop.
//   - read loop:  POST /api/slip-agent/claim every 5 s when idle + ready; on a job it downloads
//                 the pages, calls Ollama /api/chat once (all pages as base64 images), parses
//                 message.content JSON and POSTs the result.
// Network errors to the API are logged and retried with exponential backoff (capped at 60 s);
// the agent never crashes. Ollama requests time out after 5 minutes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(SCRIPT_DIR, 'agent.log');
const ENV_PATH = path.join(SCRIPT_DIR, '.env');

const HEARTBEAT_MS = 10_000; // heartbeat every 10 s
const CLAIM_MS = 5_000; // claim attempt every 5 s while idle
const READY_OK_MS = 10_000; // re-check Ollama while ready (keeps heartbeat gate fresh)
const READY_RETRY_MS = 30_000; // retry Ollama readiness every 30 s while not ready
const OLLAMA_TIMEOUT_MS = 5 * 60_000; // 5 min per Ollama request
const HTTP_TIMEOUT_MS = 20_000; // per-attempt timeout for small API calls
const PAGE_TIMEOUT_MS = 60_000; // per-attempt timeout for page downloads (up to 3 MB JPEGs)
const RESULT_TIMEOUT_MS = 30_000; // per-attempt timeout for posting a result
const SHUTDOWN_POST_TIMEOUT_MS = 10_000; // best-effort result post while shutting down
const BACKOFF_MAX_MS = 60_000; // max retry backoff for API network errors
const LOG_MAX_BYTES = 5 * 1024 * 1024; // truncate agent.log when > 5 MB

// ---------------------------------------------------------------- config

function parseEnvFile(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      v = v.slice(1, -1); // quoted value: keep as-is
    } else {
      const hash = v.indexOf(' #');
      if (hash !== -1) v = v.slice(0, hash).trimEnd(); // strip trailing comment
    }
    out.set(m[1], v);
  }
  return out;
}

function loadConfig() {
  let fileEnv = new Map();
  let envFileExists = false;
  try {
    fileEnv = parseEnvFile(fs.readFileSync(ENV_PATH, 'utf8'));
    envFileExists = true;
  } catch {
    /* no .env: fall back to process env */
  }
  const get = (k) => {
    const v = process.env[k];
    if (v !== undefined && v !== '') return v;
    return fileEnv.get(k);
  };
  const cfg = {
    apiBase: String(get('SLIP_API_BASE') ?? '').replace(/\/+$/, ''),
    token: String(get('SLIP_AGENT_TOKEN') ?? ''),
    ollamaUrl: String(get('OLLAMA_URL') ?? 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    ollamaModel: String(get('OLLAMA_MODEL') ?? 'qwen3.8:27b'),
    envFileExists,
  };
  const missing = [];
  if (!cfg.apiBase) missing.push('SLIP_API_BASE');
  if (!cfg.token) missing.push('SLIP_AGENT_TOKEN');
  for (const u of ['apiBase', 'ollamaUrl']) {
    try {
      new URL(cfg[u]);
    } catch {
      missing.push(`${u}="${cfg[u]}" is not a valid URL`);
    }
  }
  if (missing.length) {
    const msg = `config-error missing/invalid: ${missing.join(', ')} — set them in ${ENV_PATH} (copy from .env.example) or as environment variables`;
    const line = `${new Date().toISOString()} ${msg}`;
    console.error(line);
    try {
      fs.appendFileSync(LOG_PATH, `${line}\n`);
    } catch {
      /* best effort */
    }
    process.exit(1);
  }
  return cfg;
}

// ---------------------------------------------------------------- logging

let cfg; // assigned in main()

function log(event, detail) {
  const line = `${new Date().toISOString()} ${event}${detail === undefined || detail === '' ? '' : ` ${detail}`}`;
  console.log(line);
  try {
    try {
      if (fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) fs.writeFileSync(LOG_PATH, ''); // rotate by truncation
    } catch {
      /* file does not exist yet */
    }
    fs.appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    /* logging must never crash the agent */
  }
}

// Log the same failure at most once per interval (unless the message changes).
const lastLogged = new Map();
function logThrottled(key, event, detail, intervalMs = 5 * 60_000) {
  const now = Date.now();
  const prev = lastLogged.get(key);
  if (prev && prev.detail === detail && now - prev.at < intervalMs) return;
  lastLogged.set(key, { at: now, detail });
  log(event, detail);
}

function errStr(e) {
  if (e === undefined || e === null) return 'unknown error';
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return `aborted: ${e.message || e.name}`;
  return e.message ? `${e.message}` : String(e);
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

// ---------------------------------------------------------------- shutdown / signals

let stopping = false;
let busy = false; // true while a read is in progress (drives heartbeat "idle|busy")
let ollamaReady = false;

const shutdownController = new AbortController();
const SHUTDOWN = shutdownController.signal;

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('shutdown', `signal=${signal} state=${busy ? 'busy' : 'idle'}`);
  shutdownController.abort();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log('unhandled-rejection', errStr(e)));
process.on('uncaughtException', (e) => log('uncaught-exception', errStr(e)));

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

// Abort a request after `timeoutMs`, and immediately when the agent shuts down.
function requestSignal(timeoutMs, { ignoreShutdown = false } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (!ignoreShutdown) signals.push(SHUTDOWN);
  return AbortSignal.any(signals);
}

// ---------------------------------------------------------------- Ollama readiness

function setReady(ready, msg) {
  if (ready !== ollamaReady) {
    ollamaReady = ready;
    log(ready ? 'ollama-ready' : 'ollama-not-ready', msg);
  } else if (!ready) {
    logThrottled('ollama-not-ready', 'ollama-not-ready', msg);
  }
}

async function checkOllamaOnce() {
  let tags;
  try {
    const res = await fetch(new URL('/api/tags', cfg.ollamaUrl), { signal: requestSignal(10_000) });
    if (!res.ok) throw new Error(`GET /api/tags -> HTTP ${res.status}`);
    tags = await res.json();
  } catch (e) {
    if (!stopping) setReady(false, `Ollama unreachable at ${cfg.ollamaUrl}: ${errStr(e)}`);
    return false;
  }
  const names = (Array.isArray(tags?.models) ? tags.models : []).map((m) => String(m?.name ?? ''));
  const wanted = cfg.ollamaModel;
  const found =
    names.includes(wanted) ||
    (!wanted.includes(':') && names.some((n) => n.split(':')[0] === wanted));
  if (!found) {
    setReady(false, `model "${wanted}" not present in Ollama (installed: ${names.join(', ') || 'none'}) — run: ollama pull ${wanted}`);
    return false;
  }
  setReady(true, `Ollama ready at ${cfg.ollamaUrl}, model=${wanted}`);
  return true;
}

async function readinessLoop() {
  while (!stopping) {
    await checkOllamaOnce();
    if (stopping) break;
    await sleep(ollamaReady ? READY_OK_MS : READY_RETRY_MS, SHUTDOWN);
  }
}

// ---------------------------------------------------------------- API client (with backoff)

async function apiFetch(what, method, pathname, body, timeoutMs = HTTP_TIMEOUT_MS, { retry = true } = {}) {
  let delay = 1_000;
  for (;;) {
    if (stopping) throw new Error('agent shutting down');
    let res;
    try {
      res = await fetch(new URL(pathname, cfg.apiBase), {
        method,
        headers: {
          'X-Slip-Agent-Token': cfg.token,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body,
        signal: requestSignal(timeoutMs),
      });
    } catch (e) {
      if (!retry || stopping) throw e;
      logThrottled(`net-${what}`, 'api-retry', `${what}: ${errStr(e)} — retry in ${Math.round(delay / 1000)}s`, 60_000);
      await sleep(delay, SHUTDOWN);
      if (stopping) throw new Error('agent shutting down');
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
      continue;
    }
    if (retry && (res.status >= 500 || res.status === 429)) {
      logThrottled(`srv-${what}-${res.status}`, 'api-retry', `${what}: HTTP ${res.status} — retry in ${Math.round(delay / 1000)}s`, 60_000);
      try {
        res.body?.cancel();
      } catch {
        /* ignore */
      }
      await sleep(delay, SHUTDOWN);
      if (stopping) throw new Error('agent shutting down');
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
      continue;
    }
    return res;
  }
}

// ---------------------------------------------------------------- heartbeat loop

async function heartbeatLoop() {
  while (!stopping) {
    if (ollamaReady) {
      const info = `${cfg.ollamaModel} ${busy ? 'busy' : 'idle'}`;
      try {
        const res = await apiFetch('heartbeat', 'POST', '/api/slip-agent/heartbeat', JSON.stringify({ info }), HTTP_TIMEOUT_MS, {
          retry: false, // the next tick (10 s) is the retry
        });
        if (res.status !== 200) {
          const text = await res.text().catch(() => '');
          logThrottled(`hb-${res.status}`, 'heartbeat-failed', `HTTP ${res.status} ${truncate(text, 200)}`);
        }
      } catch (e) {
        if (!stopping) logThrottled('hb-net', 'heartbeat-error', errStr(e));
      }
    }
    await sleep(HEARTBEAT_MS, SHUTDOWN);
  }
}

// ---------------------------------------------------------------- read loop (claim -> pages -> Ollama -> result)

function stripFences(text) {
  const t = String(text ?? '').trim();
  const m = /^```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n?```$/.exec(t);
  return m ? m[1].trim() : t;
}

function parseModelJson(text) {
  const t = stripFences(text);
  try {
    return { value: JSON.parse(t) };
  } catch {
    /* fall through to brace extraction */
  }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return { value: JSON.parse(t.slice(first, last + 1)) };
    } catch {
      /* fall through */
    }
  }
  return { error: 'model output is not valid JSON' };
}

async function postResult(slipId, body) {
  const pathname = `/api/slip-agent/slips/${encodeURIComponent(slipId)}/result`;
  if (stopping) {
    // Best effort only: do not block shutdown, do not retry forever.
    try {
      const res = await fetch(new URL(pathname, cfg.apiBase), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Slip-Agent-Token': cfg.token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SHUTDOWN_POST_TIMEOUT_MS),
      });
      log('result-posted', `slip=${slipId} ok=${body.ok} http=${res.status} (while stopping)`);
    } catch (e) {
      log('result-post-failed', `slip=${slipId} ok=${body.ok} ${errStr(e)} (while stopping; server lease will expire and requeue)`);
    }
    return;
  }
  const res = await apiFetch('result', 'POST', pathname, JSON.stringify(body), RESULT_TIMEOUT_MS);
  if (res.status === 409) {
    const text = await res.text().catch(() => '');
    log('result-rejected', `slip=${slipId} HTTP 409 ${truncate(text, 200)} (not reading locally — lease expired or taken elsewhere)`);
    return;
  }
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw new Error(`result post HTTP ${res.status} ${truncate(text, 200)}`);
  }
  log('result-posted', `slip=${slipId} ok=${body.ok}`);
}

async function callOllama(prompt, images) {
  const body = {
    model: cfg.ollamaModel,
    stream: false,
    format: 'json',
    think: false,
    options: { temperature: 0, num_ctx: 8192 },
    messages: [{ role: 'user', content: prompt ?? '', images }],
  };
  const res = await fetch(new URL('/api/chat', cfg.ollamaUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: requestSignal(OLLAMA_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    throw new Error(`ollama HTTP ${res.status}${data?.error ? `: ${data.error}` : ''}`);
  }
  const content = data?.message?.content;
  if (typeof content !== 'string') throw new Error('ollama response has no message.content');
  return content;
}

async function runJob(job) {
  const t0 = Date.now();
  const slipId = String(job?.slip_id ?? '');
  const pageCount = Number(job?.page_count ?? 0);
  log('job-start', `slip=${slipId} pages=${pageCount}`);
  try {
    if (!slipId || !(pageCount >= 1)) throw new Error(`bad job payload (slip_id=${JSON.stringify(job?.slip_id)} page_count=${JSON.stringify(job?.page_count)})`);

    const images = [];
    for (let page = 1; page <= pageCount; page++) {
      const res = await apiFetch('page', 'GET', `/api/slip-agent/slips/${encodeURIComponent(slipId)}/pages/${page}`, undefined, PAGE_TIMEOUT_MS);
      if (res.status !== 200) {
        const text = await res.text().catch(() => '');
        throw new Error(`page ${page} download failed: HTTP ${res.status} ${truncate(text, 200)}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      images.push(buf.toString('base64'));
      log('page-downloaded', `slip=${slipId} page=${page} bytes=${buf.length}`);
    }

    log('ollama-request', `slip=${slipId} model=${cfg.ollamaModel} images=${images.length} ctx=8192`);
    const content = await callOllama(job.prompt, images);

    const parsed = parseModelJson(content);
    if (parsed.error) throw new Error(`invalid reader output: ${parsed.error} (content: ${truncate(content, 300)})`);
    const result = parsed.value;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error(`invalid reader output: model returned ${Array.isArray(result) ? 'an array' : `type ${result === null ? 'null' : typeof result}`}, expected a JSON object`);
    }
    await postResult(slipId, { ok: true, result });
    log('job-done', `slip=${slipId} ok=true lines=${Array.isArray(result.lines) ? result.lines.length : 'n/a'} ms=${Date.now() - t0}`);
  } catch (e) {
    const msg = errStr(e);
    log('job-failed', `slip=${slipId} ${msg}`);
    try {
      await postResult(slipId, { ok: false, error: truncate(msg, 2000) });
    } catch (postErr) {
      log('result-post-failed', `slip=${slipId} ${errStr(postErr)}`);
    }
  }
}

async function claimLoop() {
  while (!stopping) {
    if (ollamaReady && !busy) {
      let job = null;
      try {
        const res = await apiFetch('claim', 'POST', '/api/slip-agent/claim');
        if (res.status === 200) {
          const data = await res.json().catch(() => null);
          job = data?.job ?? null;
          if (job && (typeof job.slip_id !== 'string' || !job.slip_id)) {
            log('claim-bad-job', `job=${truncate(JSON.stringify(job), 200)}`);
            job = null;
          }
        } else if (res.status === 401 || res.status === 403) {
          const text = await res.text().catch(() => '');
          logThrottled('claim-auth', 'claim-unauthorized', `HTTP ${res.status} ${truncate(text, 200)} — check SLIP_AGENT_TOKEN on agent and worker`, 60_000);
          await sleep(BACKOFF_MAX_MS, SHUTDOWN);
        } else {
          const text = await res.text().catch(() => '');
          logThrottled(`claim-${res.status}`, 'claim-failed', `HTTP ${res.status} ${truncate(text, 200)}`, 60_000);
          await sleep(BACKOFF_MAX_MS, SHUTDOWN);
        }
      } catch (e) {
        if (!stopping) {
          logThrottled('claim-net', 'claim-error', errStr(e), 60_000);
          await sleep(BACKOFF_MAX_MS, SHUTDOWN);
        }
      }
      if (job) {
        busy = true;
        try {
          await runJob(job);
        } catch (e) {
          log('job-crashed', `slip=${job.slip_id} ${errStr(e)}`);
        } finally {
          busy = false;
        }
      }
    }
    if (stopping) break;
    await sleep(CLAIM_MS, SHUTDOWN);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  cfg = loadConfig();
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) {
    log('warn', `Node ${process.versions.node} is below the minimum (20.3); use Node 22`);
  }
  log(
    'agent-start',
    `pid=${process.pid} node=${process.versions.node} api=${cfg.apiBase} ollama=${cfg.ollamaUrl} model=${cfg.ollamaModel} env=${cfg.envFileExists ? ENV_PATH : 'process-env-only'}`,
  );

  const loops = [readinessLoop(), heartbeatLoop(), claimLoop()];
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (stopping) {
        clearInterval(check);
        resolve();
      }
    }, 200);
    if (stopping) {
      clearInterval(check);
      resolve();
    }
  });
  // Give the loops (and a best-effort final result post) a short grace period to drain.
  await Promise.race([Promise.allSettled(loops), sleep(15_000).then(() => 'grace-timeout')]);
  log('agent-exit', `pid=${process.pid}`);
  process.exit(0);
}

main().catch((e) => {
  try {
    log('agent-fatal', errStr(e));
  } catch {
    /* ignore */
  }
  process.exit(1);
});
