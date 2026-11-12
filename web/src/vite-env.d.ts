/// <reference types="vite/client" />

/** UTC build stamp injected by vite.config.ts (define). */
declare const __APP_BUILD__: string

interface ImportMetaEnv {
  /**
   * Absolute API origin for the Capacitor Android build (.env.android, e.g.
   * "https://pos-dev.twostackmaxgame.win"). Unset/empty in the normal web
   * build, where every /api/... URL stays same-origin and relative.
   */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
