// Post-build step: make dist/sw.js host-aware.
//
// owner.* is behind Cloudflare Access and must NEVER run a service worker (see
// src/main.tsx). Devices that got a worker from an older build are stuck: the
// worker answers navigations itself, never reaches Access (so the session never
// renews) and its own update check gets a cross-origin 302 it cannot follow.
// Once `/sw.js` is reachable on the owner host (an Access "Bypass" policy for
// that single path), the browser's update check fetches THIS file; on owner.*
// it runs the self-destruct branch below (clear caches, unregister, reload the
// open tabs). On every other host the original Workbox worker runs unchanged.
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = new URL('../dist/sw.js', import.meta.url)
const MARK = '/*owner-killswitch*/'
const original = readFileSync(FILE, 'utf8')
if (original.startsWith(MARK)) {
  console.log('sw-owner-killswitch: already applied')
  process.exit(0)
}

const kill = `self.addEventListener("install",()=>{self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil((async()=>{
try{for(const k of await caches.keys())await caches.delete(k)}catch(_){}
try{await self.registration.unregister()}catch(_){}
try{const cs=await self.clients.matchAll({type:"window",includeUncontrolled:true});for(const c of cs){try{c.navigate(c.url)}catch(_){}}}catch(_){}
})())});`

// the closing brace goes on its own line: the original may end in a //# comment
const wrapped = `${MARK}if(self.location.hostname.startsWith("owner.")){${kill}}else{${original}\n}\n`
writeFileSync(FILE, wrapped)
console.log('sw-owner-killswitch: applied')
