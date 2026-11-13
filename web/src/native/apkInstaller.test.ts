//! Checks for the pure helpers of native/apkInstaller.ts. Like pos/points.test.ts
//! the app has no test runner: run with `node src/native/apkInstaller.test.ts`
//! (Node type stripping). Nothing in the app imports this file.

import {
  buildApkUrl,
  fmtBytes,
  installErrorCode,
  installErrorMessage,
  isNewer,
  needsBlock,
  parseManifest,
  progressPercent,
} from './apkInstaller.ts'

let n = 0
function eq(actual: unknown, expected: unknown, label: string): void {
  n += 1
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
  }
}

const good = { versionCode: 8, versionName: '1.2.0', sha256: 'ab'.repeat(32), size: 1000, minSupported: 8, apkUrl: '/api/app/apk?v=8' }
const m = parseManifest(good)
eq(m?.versionCode, 8, 'parse ok')
eq(parseManifest(null), null, 'parse null')
eq(parseManifest({ ...good, sha256: '' }), null, 'parse missing sha')
eq(parseManifest({ ...good, apkUrl: undefined }), null, 'parse missing url')
eq(parseManifest({ ...good, versionCode: 1.5 }), null, 'parse non-integer code')
eq(parseManifest({ ...good, minSupported: undefined })?.minSupported, 0, 'minSupported default 0')

// block only when the installed build is below minSupported; unknowns never block
eq(needsBlock(7, m), true, 'older blocks')
eq(needsBlock(8, m), false, 'equal does not block')
eq(needsBlock(9, m), false, 'newer does not block')
eq(needsBlock(null, m), false, 'unknown current never blocks')
eq(needsBlock(7, null), false, 'unknown manifest never blocks')

eq(isNewer(8, 7), true, 'isNewer yes')
eq(isNewer(7, 7), false, 'isNewer equal')
eq(isNewer(8, null), false, 'isNewer unknown current')

eq(buildApkUrl('https://api.example.com', '/api/app/apk?v=8'), 'https://api.example.com/api/app/apk?v=8', 'url join')
eq(buildApkUrl('https://api.example.com/', 'api/app/apk'), 'https://api.example.com/api/app/apk', 'url join slashes')
eq(buildApkUrl('', '/api/app/apk'), '/api/app/apk', 'url relative base')
eq(buildApkUrl('https://a.example', 'https://b.example/x'), 'https://b.example/x', 'absolute kept')

eq(progressPercent(50, 100), 50, 'percent')
eq(progressPercent(5, 0), 0, 'percent zero total')
eq(progressPercent(500, 100), 100, 'percent clamp high')
eq(progressPercent(-5, 100), 0, 'percent clamp low')

eq(fmtBytes(0), '0 B', 'bytes zero')
eq(fmtBytes(1536), '1.5 KB', 'bytes kb')
eq(fmtBytes(5 * 1024 * 1024), '5 MB', 'bytes whole mb')

eq(installErrorCode({ code: 'sha_mismatch' }), 'sha_mismatch', 'code from code')
eq(installErrorCode({ message: 'x need_permission y' }), 'need_permission', 'code from message')
eq(installErrorCode(undefined), '', 'code unknown')
eq(installErrorMessage('need_permission').includes('ติดตั้งแอปที่ไม่รู้จัก'), true, 'permission message')

console.log(`ok — ${n} checks passed`)
