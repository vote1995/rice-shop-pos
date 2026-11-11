import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // We register (and, on the owner host, unregister) the service worker
      // ourselves in main.tsx. Do NOT inject the auto register script: it runs
      // from <head> before main.tsx and would re-install the SW on owner.*,
      // where it must stay off (Access 302s block SW updates → stale UI).
      injectRegister: false,
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'POS ร้านข้าว',
        short_name: 'POS',
        description: 'ระบบขายหน้าร้านสำหรับร้านข้าว',
        lang: 'th',
        dir: 'ltr',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        theme_color: '#2e7d32',
        background_color: '#ffffff',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: 'index.html',
        // never let the service worker handle/serve the API (3.52: offline shell only)
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
