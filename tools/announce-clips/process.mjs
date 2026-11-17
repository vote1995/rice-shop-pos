#!/usr/bin/env node
// Turns the raw OneCore clips (synthesize.ps1) into the announcement clips shipped in
// web/public/announce/: trim silence, compress the dynamics so the average level rises
// without distortion, normalize every clip to the same peak just below full scale (so
// nothing clips), write 16-bit mono WAV. Dependency-free (no ffmpeg on the build machine).
//   node tools/announce-clips/process.mjs <raw dir> [out dir]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rawDir = process.argv[2]
const outDir = process.argv[3] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/public/announce')
if (!rawDir) { console.error('usage: node tools/announce-clips/process.mjs <raw dir> [out dir]'); process.exit(1) }

const TARGET_PEAK = 0.89 // -1 dBFS: loud, but a full dB of headroom — never clips
const TRIM_DB = -42 // below this (relative to the clip's peak) at the edges is silence
const PAD_MS = 12
const COMP = { thresholdDb: -28, ratio: 4, attackMs: 4, releaseMs: 70 }

function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV')
  let pos = 12, fmt = null, data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4), size = buf.readUInt32LE(pos + 4), body = pos + 8
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
    if (id === 'data') { data = buf.subarray(body, Math.min(body + size, buf.length)); break }
    pos = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('missing fmt/data')
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`unsupported WAV (format ${fmt.format}, ${fmt.bits} bit)`)
  const frames = Math.floor(data.length / (2 * fmt.channels)), s = new Float32Array(frames)
  for (let i = 0; i < frames; i++) { let sum = 0; for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2); s[i] = sum / fmt.channels / 32768 }
  return { rate: fmt.rate, samples: s }
}

const peakOf = (s) => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
const rmsOf = (s) => Math.sqrt(s.reduce((a, v) => a + v * v, 0) / Math.max(1, s.length))
const db = (x) => 20 * Math.log10(Math.max(x, 1e-9))

function trim(s, rate) {
  const limit = peakOf(s) * Math.pow(10, TRIM_DB / 20), pad = Math.round((PAD_MS / 1000) * rate)
  let a = 0, b = s.length - 1
  while (a < b && Math.abs(s[a]) < limit) a++
  while (b > a && Math.abs(s[b]) < limit) b--
  return s.slice(Math.max(0, a - pad), Math.min(s.length, b + 1 + pad))
}

// Long pauses INSIDE a clip (the voice pauses between syllable groups) make the sentence drag:
// any silent run longer than MAX_GAP_MS is cut down to KEEP_GAP_MS.
const MAX_GAP_MS = 140, KEEP_GAP_MS = 90
function squeezeGaps(s, rate) {
  const limit = peakOf(s) * Math.pow(10, TRIM_DB / 20)
  const maxGap = Math.round((MAX_GAP_MS / 1000) * rate), keep = Math.round((KEEP_GAP_MS / 1000) * rate), half = keep >> 1
  const out = []
  let i = 0
  while (i < s.length) {
    if (Math.abs(s[i]) >= limit) { out.push(s[i++]); continue }
    let j = i
    while (j < s.length && Math.abs(s[j]) < limit) j++ // [i, j) is a silent run
    if (j - i > maxGap) { for (let k = i; k < i + half; k++) out.push(s[k]); for (let k = j - (keep - half); k < j; k++) out.push(s[k]) }
    else for (let k = i; k < j; k++) out.push(s[k])
    i = j
  }
  return Float32Array.from(out)
}

function compress(s, rate) { // feed-forward peak-detecting compressor, gain only ever reduces
  const out = new Float32Array(s.length), th = COMP.thresholdDb
  const att = Math.exp(-1 / ((COMP.attackMs / 1000) * rate)), rel = Math.exp(-1 / ((COMP.releaseMs / 1000) * rate))
  let env = 0
  for (let i = 0; i < s.length; i++) {
    const x = Math.abs(s[i])
    env = x > env ? att * env + (1 - att) * x : rel * env + (1 - rel) * x
    const over = db(env) - th
    const gainDb = over > 0 ? -over * (1 - 1 / COMP.ratio) : 0
    out[i] = s[i] * Math.pow(10, gainDb / 20)
  }
  return out
}

function fade(s, rate) { const n = Math.round(0.004 * rate); for (let i = 0; i < n && i < s.length; i++) { const g = i / n; s[i] *= g; s[s.length - 1 - i] *= g } return s }

function writeWav(file, s, rate) {
  const buf = Buffer.alloc(44 + s.length * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + s.length * 2, 4); buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(s.length * 2, 40)
  for (let i = 0; i < s.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s[i] * 32767))), 44 + i * 2)
  fs.writeFileSync(file, buf)
}

fs.mkdirSync(outDir, { recursive: true })
let before = 0, after = 0, n = 0, bytes = 0
console.log('clip       dur(s)  rms_in  rms_out  peak_out')
for (const f of fs.readdirSync(rawDir).filter((x) => x.endsWith('.wav')).sort()) {
  const { rate, samples } = readWav(fs.readFileSync(path.join(rawDir, f)))
  let s = squeezeGaps(trim(samples, rate), rate)
  const rmsIn = rmsOf(s)
  s = compress(s, rate)
  const k = TARGET_PEAK / Math.max(peakOf(s), 1e-6)
  for (let i = 0; i < s.length; i++) s[i] *= k
  s = fade(s, rate)
  writeWav(path.join(outDir, f), s, rate)
  const rmsOut = rmsOf(s)
  before += db(rmsIn); after += db(rmsOut); n++; bytes += 44 + s.length * 2
  console.log(`${f.replace('.wav', '').padEnd(10)} ${(s.length / rate).toFixed(2).padStart(5)}  ${db(rmsIn).toFixed(1).padStart(6)}  ${db(rmsOut).toFixed(1).padStart(7)}  ${db(peakOf(s)).toFixed(1).padStart(7)}`)
}
console.log(`\n${n} clips, ${(bytes / 1024).toFixed(0)} KB total, sample rate ${'(per clip)'}; mean RMS ${(before / n).toFixed(1)} dBFS -> ${(after / n).toFixed(1)} dBFS (+${((after - before) / n).toFixed(1)} dB), all peaks <= ${db(TARGET_PEAK).toFixed(1)} dBFS`)
