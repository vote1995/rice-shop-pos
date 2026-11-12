import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Staff POS Android app. The built SPA (dist/, via `npm run cap:sync`) is
 * bundled into the APK — no server.url — and served from https://localhost
 * (androidScheme), from where it calls the API on the absolute origin baked
 * in at build time (VITE_API_BASE, see .env.android / src/api.ts API_BASE).
 */
const config: CapacitorConfig = {
  appId: 'win.twostackmaxgame.pos',
  appName: 'POS ร้านข้าว',
  webDir: 'dist',
  server: {
    // Local origin becomes https://localhost (no cleartext http://localhost).
    androidScheme: 'https',
  },
}

export default config
