#!/usr/bin/env node
// Publish a signed staff-POS APK to R2 for the in-app updater (feat/app-update).
//
//   node tools/publish-apk.mjs <apk> --version-code <N> --version-name <X> [--soft] [--env dev|prod]
//
// The order is deliberate: the APK goes up FIRST (R2 key app/rice-pos-<N>.apk)
// and the manifest LAST (app/manifest.json) — a published manifest must never
// point at an APK that is not fully uploaded, because phones act on it without
// any lock. A failed run therefore leaves either nothing or the previous state.
//
// R2 is reached with `npx wrangler r2 object ... --remote` executed with
// cwd=api/ via execFile (no shell: a weird APK path can never become a
// command). The bucket name is parsed out of api/wrangler.toml — the top-level
// [[r2_buckets]] MEDIA binding is prod, the [env.dev] one is dev (the default;
// prod needs an explicit --env prod). minSupported is N by default (force
// update: devices below N are blocked) or, with --soft, the currently
// published minSupported (banner-only update; 0 when nothing is published).
//
// Dependency-free, written for Node 22. Exit codes: 0 published, 1 bad usage,
// 2 refused (versionCode not newer than the published one), 3 R2/wrangler
// failure. Nothing secret is ever printed: auth stays inside wrangler.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(REPO_ROOT, 'api');
const WRANGLER_TOML = path.join(API_DIR, 'wrangler.toml');
const MANIFEST_KEY = 'app/manifest.json';
const APK_KEY_PREFIX = 'app/rice-pos-';
const GET_TIMEOUT_MS = 60_000; // manifest fetch
const PUT_TIMEOUT_MS = 15 * 60_000; // APK upload (tens of MB on a slow line)
const MAX_VERSION_CODE = 2_100_000_000; // Android's ceiling for versionCode

const USAGE = `Usage: node tools/publish-apk.mjs <apk> --version-code <N> --version-name <X> [--soft] [--env dev|prod]

Publishes a signed staff-POS APK for the in-app updater, in this order:
  1. APK     -> R2 key app/rice-pos-<N>.apk                            (first)
  2. manifest -> R2 key app/manifest.json
     {versionCode, versionName, sha256, size, minSupported}            (last)

Options:
  --version-code <N>   integer, must be greater than the published versionCode
  --version-name <X>   e.g. 1.1.5 (letters, digits and . _ + -)
  --soft               keep the published minSupported: update is a banner,
                       not a must. Default: minSupported = N = force update
  --env <name>         dev (default) or prod — the R2 bucket is read from
                       api/wrangler.toml ([env.dev] MEDIA vs top-level MEDIA)
  -h, --help           show this help

Run from the repo root. Needs Node 22 and a logged-in wrangler
("npx wrangler login" once, or CLOUDFLARE_API_TOKEN in the environment).`;

class UsageError extends Error {}
class Fail extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

const log = (msg) => console.log(msg);

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { apk: null, versionCode: null, versionName: null, soft: false, env: 'dev', help: false };
  // allow both --flag value and --flag=value
  const items = [];
  for (const a of argv) {
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq > 2) items.push([a.slice(0, eq), a.slice(eq + 1)]);
    else items.push([a]);
  }
  const positional = [];
  for (let i = 0; i < items.length; i++) {
    const [arg, inline] = items[i];
    const takeValue = () => {
      if (inline !== undefined) return inline;
      const next = items[i + 1];
      if (!next || next[0].startsWith('--')) throw new UsageError(`${arg} requires a value`);
      i += 1;
      return next[0];
    };
    switch (arg) {
      case '-h':
      case '--help':
        if (inline !== undefined) throw new UsageError(`${arg} does not take a value`);
        out.help = true;
        break;
      case '--soft':
        if (inline !== undefined) throw new UsageError('--soft does not take a value');
        out.soft = true;
        break;
      case '--version-code':
        out.versionCode = takeValue();
        break;
      case '--version-name':
        out.versionName = takeValue();
        break;
      case '--env':
        out.env = takeValue();
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option: ${arg}`);
        positional.push(arg);
    }
  }
  if (out.help) return out; // -h wins; nothing else is validated
  if (positional.length === 0) throw new UsageError('missing the <apk> path argument');
  if (positional.length > 1) throw new UsageError(`expected exactly one <apk> path, got ${positional.length}`);
  out.apk = positional[0];
  if (out.versionCode === null) throw new UsageError('--version-code is required');
  if (!/^\d{1,10}$/.test(out.versionCode)) throw new UsageError(`--version-code must be an integer, got: ${out.versionCode}`);
  out.versionCode = Number(out.versionCode);
  if (out.versionCode < 1 || out.versionCode > MAX_VERSION_CODE) {
    throw new UsageError(`--version-code must be between 1 and ${MAX_VERSION_CODE}, got: ${out.versionCode}`);
  }
  if (out.versionName === null) throw new UsageError('--version-name is required');
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(out.versionName)) {
    throw new UsageError(`--version-name must look like a version (letters, digits, . _ + -), got: ${out.versionName}`);
  }
  if (out.env !== 'dev' && out.env !== 'prod') throw new UsageError(`--env must be dev or prod, got: ${out.env}`);
  return out;
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 20) {
    throw new Fail(1, `Node 22 is required (running ${process.versions.node})`);
  }
  if (major !== 22) {
    console.error(`warn: written and tested on Node 22 — running ${process.versions.node}, continuing anyway`);
  }
}

// ---------------------------------------------------------------- api/wrangler.toml (bucket names)

/** Cut a TOML line at the first # that is not inside a double-quoted string. */
function stripTomlComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inString = !inString;
    else if (line[i] === '#' && !inString) return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(raw) {
  if (raw.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
    if (m) return m[1].replace(/\\(["\\])/g, '$1');
  }
  return raw; // number / bool / bare string — only string values are compared
}

/** Just enough TOML for wrangler.toml: table headers + flat key/values. */
function parseTomlTables(text) {
  const tables = [];
  let current = { path: [], kv: new Map() };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const header = /^\[\[\s*(\S+)\s*\]\]$/.exec(line) || /^\[\s*(\S+)\s*\]$/.exec(line);
    if (header) {
      current = { path: header[1].split('.'), kv: new Map() };
      tables.push(current);
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (kv) current.kv.set(kv[1], parseTomlValue(kv[2].trim()));
  }
  return tables;
}

/**
 * The R2 bucket for `envName`: the top-level [[r2_buckets]] bound as MEDIA is
 * prod; dev's is the [[env.dev.r2_buckets]] MEDIA entry (wrangler does not
 * inherit bindings into environments, so dev redeclares everything).
 */
function bucketFromWranglerToml(text, envName) {
  const wanted = envName === 'dev' ? ['env', 'dev', 'r2_buckets'] : ['r2_buckets'];
  for (const table of parseTomlTables(text)) {
    if (table.path.length !== wanted.length || table.path.some((part, i) => part !== wanted[i])) continue;
    if (table.kv.get('binding') !== 'MEDIA') continue;
    const name = table.kv.get('bucket_name');
    if (typeof name === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/i.test(name)) return name;
  }
  return null;
}

function readBucket(envName) {
  let text;
  try {
    text = fs.readFileSync(WRANGLER_TOML, 'utf8');
  } catch {
    throw new Fail(1, `cannot read ${WRANGLER_TOML} — run from the repo root`);
  }
  const bucket = bucketFromWranglerToml(text, envName);
  if (!bucket) {
    const where = envName === 'dev' ? '[env.dev] r2_buckets' : 'top-level [[r2_buckets]]';
    throw new Fail(1, `no MEDIA bucket_name found under ${where} in api/wrangler.toml (env=${envName})`);
  }
  return bucket;
}

// ---------------------------------------------------------------- wrangler runner (execFile, never a shell)

/**
 * Prefer a wrangler installed in node_modules; fall back to npx. Both are
 * plain JS CLIs, so they run through the node binary itself — execFile with no
 * shell, which on Windows cannot even spawn npx.cmd directly.
 */
function resolveRunner() {
  for (const base of [API_DIR, REPO_ROOT]) {
    const req = createRequire(path.join(base, 'package.json'));
    try {
      const pkgPath = req.resolve('wrangler/package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.wrangler;
      if (typeof bin === 'string' && bin) {
        const binPath = path.resolve(path.dirname(pkgPath), bin);
        if (fs.existsSync(binPath)) return { label: 'wrangler (node_modules)', argv: [binPath] };
      }
    } catch {
      /* wrangler is not installed relative to this root */
    }
  }
  const nodeDir = path.dirname(process.execPath);
  const npxCandidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'), // Windows install layout
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), // Unix layout
  ];
  const npxCli = npxCandidates.find((c) => fs.existsSync(c));
  if (npxCli) return { label: 'npx wrangler', argv: [npxCli, '--yes', 'wrangler'] };
  throw new Fail(1, 'no wrangler found: npm install wrangler in the repo (or api/), or make npx available');
}

let RUNNER; // set in main()
let OPTS; // set in main(): the parsed CLI options

/** Wrangler versions disagree on whether `r2 object` needs --env for a dev
 *  bucket, so (dev only) try without it, retry with it, then remember which
 *  worked for the rest of the run. prod is the top-level config: no --env. */
let devNeedsEnvFlag; // undefined = not learned yet

async function wranglerOnce(args, timeoutMs) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [...RUNNER.argv, ...args], {
      cwd: API_DIR,
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout ?? ''), stderr: '' };
  } catch (e) {
    if (e && e.killed) {
      return { ok: false, stdout: '', stderr: `wrangler timed out after ${Math.round(timeoutMs / 1000)}s` };
    }
    return { ok: false, stdout: String(e?.stdout ?? ''), stderr: String(e?.stderr ?? e?.message ?? 'unknown error') };
  }
}

async function runWrangler(args, timeoutMs) {
  if (OPTS.env !== 'dev') return wranglerOnce(args, timeoutMs);
  if (devNeedsEnvFlag === true) return wranglerOnce([...args, '--env', 'dev'], timeoutMs);
  const withoutEnv = await wranglerOnce(args, timeoutMs);
  if (withoutEnv.ok) {
    devNeedsEnvFlag = false;
    return withoutEnv;
  }
  if (devNeedsEnvFlag === false) return withoutEnv;
  const withEnv = await wranglerOnce([...args, '--env', 'dev'], timeoutMs);
  if (withEnv.ok) {
    devNeedsEnvFlag = true;
    log('note: this wrangler needs "--env dev" for dev R2 — using it for the rest of this run');
    return withEnv;
  }
  return {
    ok: false,
    stdout: withEnv.stdout,
    stderr: `first attempt, without --env dev:\n${tail(withoutEnv)}\nsecond attempt, with --env dev:\n${tail(withEnv)}`,
  };
}

/** Last ~15 non-empty lines of a wrangler failure (stderr first: that is where wrangler reports errors). */
function tail(res) {
  const text = (res.stderr && res.stderr.trim()) || (res.stdout && res.stdout.trim()) || 'no output';
  return text.split(/\r?\n/).filter((l) => l !== '').slice(-15).join('\n');
}

// "object not found" vs a real failure (auth, missing bucket, network...):
const OBJECT_NOT_FOUND_RE = /(?:\bobject\b|\bkey\b)[^\n]{0,120}\bnot\s+(?:be\s+)?found|NoSuchKey|HTTP\s*404|status[: ]+404\b/i;
const BUCKET_MISSING_RE = /\bbucket\b[^\n]{0,120}\bnot\s+(?:be\s+)?found|\bcould not find bucket\b/i;

function objectNotFound(res) {
  const text = `${res.stdout}\n${res.stderr}`;
  if (BUCKET_MISSING_RE.test(text)) return false; // bucket-level problem is a real failure
  return OBJECT_NOT_FOUND_RE.test(text);
}

// ---------------------------------------------------------------- the APK file

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function hasZipMagic(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(2);
    return fs.readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x50 && head[1] === 0x4b; // "PK"
  } finally {
    fs.closeSync(fd);
  }
}

async function inspectApk(apkPath) {
  let stat;
  try {
    stat = fs.statSync(apkPath);
  } catch {
    throw new UsageError(`APK not found: ${apkPath}`);
  }
  if (!stat.isFile()) throw new UsageError(`not a file: ${apkPath}`);
  if (path.extname(apkPath).toLowerCase() !== '.apk') {
    throw new UsageError(`expected an .apk file, got: ${path.basename(apkPath)}`);
  }
  if (!hasZipMagic(apkPath)) {
    throw new UsageError(`${apkPath} has no ZIP header — that is not an APK (a plain rename will not do)`);
  }
  return { size: stat.size, sha256: await sha256File(apkPath) };
}

// ---------------------------------------------------------------- current manifest

/**
 * The published app/manifest.json, or null when there is none yet. A manifest
 * that exists but cannot be parsed is a hard error: guessing its versionCode
 * could break the "only move up" rule.
 */
async function fetchCurrentManifest(bucket) {
  const res = await runWrangler(['r2', 'object', 'get', `${bucket}/${MANIFEST_KEY}`, '--pipe', '--remote'], GET_TIMEOUT_MS);
  if (res.ok) {
    let data;
    try {
      data = JSON.parse(res.stdout);
    } catch {
      throw new Fail(3, `${bucket}/${MANIFEST_KEY} is not valid JSON — fix or delete it by hand before publishing`);
    }
    const versionCode = Number(data?.versionCode);
    if (!Number.isInteger(versionCode) || versionCode < 0) {
      throw new Fail(3, `${bucket}/${MANIFEST_KEY} has no usable versionCode — fix it by hand before publishing`);
    }
    const minSupported = Number(data?.minSupported);
    return {
      versionCode,
      versionName: typeof data?.versionName === 'string' ? data.versionName : '',
      minSupported: Number.isInteger(minSupported) && minSupported >= 0 ? minSupported : null,
    };
  }
  if (objectNotFound(res)) {
    log(`no ${MANIFEST_KEY} in bucket ${bucket} yet — this is the first publish for this env`);
    return null;
  }
  throw new Fail(3, `could not read ${bucket}/${MANIFEST_KEY} — fix wrangler/R2 access first (nothing was uploaded):\n${tail(res)}`);
}

// ---------------------------------------------------------------- publish

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(USAGE);
    return;
  }
  checkNodeVersion();
  RUNNER = resolveRunner();
  OPTS = args;

  const bucket = readBucket(args.env);
  const apkPath = path.resolve(args.apk);
  const { size, sha256 } = await inspectApk(apkPath);
  const apkKey = `${APK_KEY_PREFIX}${args.versionCode}.apk`;

  log(`env=${args.env} bucket=${bucket} runner=${RUNNER.label}`);
  log(`apk ${apkPath} (${size} bytes, ${fmtBytes(size)}) sha256=${sha256}`);

  const current = await fetchCurrentManifest(bucket);
  if (current) log(`published: versionCode=${current.versionCode} versionName=${current.versionName || '?'} minSupported=${current.minSupported ?? '?'}`);
  if (current && args.versionCode <= current.versionCode) {
    throw new Fail(
      2,
      `refusing to publish: versionCode ${args.versionCode} is not newer than the published ${current.versionCode} ` +
        `(${bucket}/${MANIFEST_KEY}) — versionCodes only move up, re-publishing an old one would do nothing`,
    );
  }

  let minSupported;
  if (args.soft) {
    minSupported = current?.minSupported ?? 0;
    if (current && current.minSupported === null) {
      log('note: the published manifest has no minSupported — treating it as 0 (soft)');
    }
  } else {
    minSupported = args.versionCode;
  }
  if (minSupported > args.versionCode) {
    throw new Fail(
      2,
      `refusing to publish: minSupported ${minSupported} > versionCode ${args.versionCode} ` +
        '(the published manifest is inconsistent — publish without --soft to force, or fix it by hand)',
    );
  }

  const manifest = { versionCode: args.versionCode, versionName: args.versionName, sha256, size, minSupported };

  // 1) APK first. If this fails, nothing is published and devices keep the old version.
  log(`uploading ${apkKey} (APK first) ...`);
  const putApk = await runWrangler(['r2', 'object', 'put', `${bucket}/${apkKey}`, '--file', apkPath, '--remote'], PUT_TIMEOUT_MS);
  if (!putApk.ok) {
    throw new Fail(3, `APK upload failed — manifest NOT touched, devices keep the old version:\n${tail(putApk)}`);
  }

  // 2) Manifest last — this is the switch that makes phones see the new APK.
  log(`uploading ${MANIFEST_KEY} (manifest last) ...`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rice-pos-publish-'));
  let putManifest;
  try {
    const manifestPath = path.join(tmpDir, 'manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    putManifest = await runWrangler(
      ['r2', 'object', 'put', `${bucket}/${MANIFEST_KEY}`, '--file', manifestPath, '--remote'],
      GET_TIMEOUT_MS,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (!putManifest.ok) {
    throw new Fail(
      3,
      `${apkKey} was uploaded but the MANIFEST upload failed — devices keep the old version. ` +
        `Re-run this command with the same versionCode (both uploads are idempotent):\n${tail(putManifest)}`,
    );
  }

  log('');
  log('published:');
  log(`  env           ${args.env}`);
  log(`  bucket        ${bucket}`);
  log(`  versionCode   ${args.versionCode} (was ${current ? current.versionCode : 'none'})`);
  log(`  versionName   ${args.versionName}`);
  log(`  apk           ${apkKey} (${fmtBytes(size)})`);
  log(`  sha256        ${sha256}`);
  log(`  minSupported  ${minSupported} — ${args.soft ? 'soft: kept from the previous manifest, update is a banner only' : 'force: devices below it are blocked until they update'}`);
  log(`  manifest      ${MANIFEST_KEY}`);
}

// ---------------------------------------------------------------- helpers

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  const shown = unit === 0 || Number.isInteger(rounded) ? String(Math.round(value)) : rounded.toFixed(1);
  return `${shown} ${units[unit]}`;
}

// ---------------------------------------------------------------- entry point / exports

const invokedDirectly = import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href;
if (invokedDirectly) {
  main().catch((e) => {
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}`);
      console.error('run with --help for usage');
      process.exit(1);
    }
    console.error(`error: ${e instanceof Fail ? e.message : (e?.stack ?? e)}`);
    process.exit(e instanceof Fail ? e.exitCode : 1);
  });
}

// exported for ad-hoc testing under node --input-type=module / --eval
export { parseArgs, parseTomlTables, bucketFromWranglerToml, objectNotFound, fmtBytes };
