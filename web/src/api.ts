// Typed fetch wrapper for the Rust Worker API (served under /api).

// Force-update (feat/app-update): the native app reports the build it runs so
// the server can answer 426, and the pure decision helpers + the ApkInstaller
// plugin wrapper live beside it. apkInstaller.ts never imports this file.
import { nativeAppVersion } from './native/apkInstaller'
import type { AppManifest } from './native/apkInstaller'

/**
 * Origin every /api/... request is prefixed with. "" (VITE_API_BASE unset) is
 * the normal web build: same-origin relative URLs, byte-identical to before.
 * The Capacitor Android build (.env.android -> `vite build --mode android`)
 * serves the SPA from https://localhost, so it must call the API on its real
 * absolute origin and rely on the server's CORS headers instead.
 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? ''

/** Full URL of an /api/... path (same-origin relative when API_BASE is ""). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`
}

export interface DeviceCreds {
  device_id: string
  device_token: string
}

export type AuthMode = 'none' | 'device' | 'session' | 'both'

const DEVICE_ID_KEY = 'pos.device_id'
const DEVICE_TOKEN_KEY = 'pos.device_token'
const SESSION_KEY = 'pos.session'

/** API error: status 0 + code "network" means the request never reached the server. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly message: string
  readonly extra: Record<string, unknown>
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.message = message
    this.extra = extra
  }
}

// ---- force update (feat/app-update) ---------------------------------------
// Every /api response passes through this block. A 426 upgrade_required is the
// ONLY thing that can block the app; the X-App-Latest header of any other
// response only feeds the dismissible new-version banner of UpdateGate. A
// request that never reached a decision (network error = status 0, or a 5xx)
// records NOTHING - undecidable is never treated as update required.

/** What a 426 told us: the newest build and the oldest one still allowed. */
export interface UpgradeRequired {
  latest: number
  minSupported: number
}

let upgradeRequired: UpgradeRequired | null = null
let latestVersionCode: number | null = null
const appVersionListeners = new Set<() => void>()

function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function notifyAppVersion(): void {
  for (const listener of appVersionListeners) listener()
}

/**
 * 426 {error:'upgrade_required', latest:int, minSupported:int} - record it for
 * UpdateGate. It is NOT an auth failure and is never retried: the call still
 * throws its normal ApiError (code 'upgrade_required'); the gate simply covers
 * the screen so nothing underneath is reachable.
 */
function noteUpgradeRequired(extra: Record<string, unknown>): void {
  const latest = finiteCount(extra['latest'])
  const minSupported = finiteCount(extra['minSupported'])
  const next: UpgradeRequired = {
    latest: latest ?? upgradeRequired?.latest ?? 0,
    minSupported: minSupported ?? upgradeRequired?.minSupported ?? 0,
  }
  if (
    upgradeRequired !== null &&
    upgradeRequired.latest === next.latest &&
    upgradeRequired.minSupported === next.minSupported
  ) {
    return
  }
  upgradeRequired = next
  notifyAppVersion()
}

/** X-App-Latest on a healthy response: the newest versionCode, banner only. */
function noteLatestHeader(res: Response): void {
  const raw = res.headers.get('X-App-Latest')
  if (raw === null || raw === '') return
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) return
  if (latestVersionCode !== null && latestVersionCode >= n) return
  latestVersionCode = n
  notifyAppVersion()
}

/** Non-null once a 426 was received: UpdateGate must block the whole app. */
export function getUpgradeRequired(): UpgradeRequired | null {
  return upgradeRequired
}

/** Newest versionCode the server mentioned in X-App-Latest (null = never). */
export function getLatestVersionCode(): number | null {
  return latestVersionCode
}

/** Subscribe to the two values above; returns the unsubscribe function. */
export function subscribeAppVersion(listener: () => void): () => void {
  appVersionListeners.add(listener)
  return () => {
    appVersionListeners.delete(listener)
  }
}

/** Typed check for 'the server refused this build' (not auth, not network). */
export function isUpgradeRequiredError(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 426 || e.code === 'upgrade_required')
}

/**
 * X-App-Version on every request the native app makes (browsers/PWA send
 * nothing). The versionCode is read through the ApkInstaller plugin once and
 * cached; when the plugin is missing or throws, no header is sent at all.
 */
async function appVersionHeader(): Promise<Record<string, string>> {
  const v = await nativeAppVersion()
  return v === null ? {} : { 'X-App-Version': String(v.versionCode) }
}

/** Shared body parser of api()/apiBinary(): JSON when possible, ApiError when !ok. */
async function readResponse(res: Response): Promise<unknown> {
  const text = await res.text()
  let data: unknown
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = undefined
    }
  }
  if (!res.ok) {
    const obj = (data !== null && typeof data === 'object' ? data : {}) as Record<string, unknown>
    const code = typeof obj['error'] === 'string' ? obj['error'] : `http_${res.status}`
    const message = typeof obj['message'] === 'string' ? obj['message'] : `HTTP ${res.status}`
    if (res.status === 426 || code === 'upgrade_required') noteUpgradeRequired(obj)
    else noteLatestHeader(res)
    throw new ApiError(res.status, code, message, obj)
  }
  noteLatestHeader(res)
  return data
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  auth: AuthMode = 'none',
): Promise<T> {
  const headers: Record<string, string> = await appVersionHeader()
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (auth === 'device' || auth === 'both') {
    const token = localStorage.getItem(DEVICE_TOKEN_KEY)
    if (token) headers['X-Device-Token'] = token
  }
  if (auth === 'session' || auth === 'both') {
    const token = sessionStorage.getItem(SESSION_KEY)
    if (token) headers['Authorization'] = `Bearer ${token}`
  }
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้')
  }
  return (await readResponse(res)) as T
}

/**
 * api() always JSON-stringifies its body, so the raw-bytes image upload goes
 * through this variant (same error parsing, explicit Content-Type).
 */
async function apiBinary<T>(method: string, path: string, blob: Blob, contentType: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: { 'Content-Type': contentType, ...(await appVersionHeader()) },
      credentials: 'same-origin',
      body: blob,
    })
  } catch {
    throw new ApiError(0, 'network', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้')
  }
  return (await readResponse(res)) as T
}

/** Public, forever-cached URL of a stored image (MenuItem.image_key). */
export function mediaUrl(key: string): string {
  // apiUrl(): the Capacitor build loads these <img> from the absolute API
  // origin (the web build keeps the same-origin relative URL).
  return apiUrl(`/api/media/${key}`) // server-made key: menu/{uuid}/{uuid}.{ext}, URL-safe
}

/** PUT /api/owner/menu-items/{id}/image — body is the raw WebP/JPEG bytes. */
export function uploadMenuImage(itemId: string, blob: Blob): Promise<MenuItem> {
  return apiBinary<MenuItem>(
    'PUT',
    `/api/owner/menu-items/${encodeURIComponent(itemId)}/image`,
    blob,
    blob.type === 'image/webp' || blob.type === 'image/jpeg' ? blob.type : 'image/jpeg',
  )
}

/** DELETE /api/owner/menu-items/{id}/image — returns the item with image_key null. */
export function deleteMenuImage(itemId: string): Promise<MenuItem> {
  return api<MenuItem>('DELETE', `/api/owner/menu-items/${encodeURIComponent(itemId)}/image`)
}

/** GET /api/owner/media-usage */
export function getMediaUsage(): Promise<MediaUsage> {
  return api<MediaUsage>('GET', '/api/owner/media-usage')
}

/**
 * GET /api/app/manifest - the newest APK build the server offers, for the
 * native force-update check (shape = AppManifest of native/apkInstaller.ts).
 * Authenticated like every other staff call; UpdateGate treats any failure
 * (offline, 5xx, not logged in) as silent and never blocks on it.
 */
export function getAppManifest(): Promise<AppManifest> {
  return api<AppManifest>('GET', '/api/app/manifest', undefined, 'both')
}

// ---- owner slips (slip reader phase 1): upload photos -> AI reads them ----

/** GET /api/owner/slips?shop_id=… — the reader state + the 50 newest slips. */
export function listSlips(shopId: string): Promise<SlipsData> {
  return api<SlipsData>('GET', `/api/owner/slips?shop_id=${encodeURIComponent(shopId)}`)
}

/** POST /api/owner/slips `{id, shop_id}` -> a draft row (idempotent on id). */
export function createSlip(id: string, shopId: string): Promise<Slip> {
  return api<Slip>('POST', '/api/owner/slips', { id, shop_id: shopId })
}

/** PUT /api/owner/slips/{id}/pages/{page} — body is the raw JPEG bytes. */
export function uploadSlipPage(id: string, page: number, blob: Blob): Promise<Slip> {
  return apiBinary<Slip>('PUT', `/api/owner/slips/${encodeURIComponent(id)}/pages/${page}`, blob, 'image/jpeg')
}

/** POST /api/owner/slips/{id}/submit — the cloud read may run IN this request (10-60 s). */
export function submitSlip(id: string): Promise<Slip> {
  return api<Slip>('POST', `/api/owner/slips/${encodeURIComponent(id)}/submit`)
}

/** GET /api/owner/slips/{id} — one slip with its parsed result. */
export function getSlip(id: string): Promise<Slip> {
  return api<Slip>('GET', `/api/owner/slips/${encodeURIComponent(id)}`)
}

/** DELETE /api/owner/slips/{id} -> 204 No Content (refused while 'reading'). */
export async function deleteSlip(id: string): Promise<void> {
  await api<void>('DELETE', `/api/owner/slips/${encodeURIComponent(id)}`)
}

/**
 * GET /api/owner/slips/{id}/pages/{n} as a blob: URL for an <img>. The pages
 * are private, so this is a plain fetch (same-origin = the Access cookie) +
 * an object URL, never a bare URL the browser would load unauthenticated.
 */
export async function slipPageUrl(id: string, page: number): Promise<string> {
  let res: Response
  try {
    res = await fetch(apiUrl(`/api/owner/slips/${encodeURIComponent(id)}/pages/${page}`), {
      headers: await appVersionHeader(),
    })
  } catch {
    throw new ApiError(0, 'network', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้')
  }
  if (!res.ok) {
    // the same 426 handling as readResponse(): record it, do not guess a code
    if (res.status === 426) {
      noteUpgradeRequired({})
      throw new ApiError(res.status, 'upgrade_required', `HTTP ${res.status}`)
    }
    noteLatestHeader(res)
    throw new ApiError(res.status, `http_${res.status}`, `HTTP ${res.status}`)
  }
  noteLatestHeader(res)
  return URL.createObjectURL(await res.blob())
}

/** Transient problems (network / upstream) are always just "retry" — never "logged out". */
export function friendlyError(e: unknown): string {
  if (!(e instanceof ApiError)) return 'ลองใหม่อีกครั้ง'
  // Server messages are English for logs; the UI is Thai (3.67), keyed by error code.
  switch (e.code) {
    case 'network':
    case 'upstream_unavailable':
      return 'เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง'
    case 'invalid_pin': {
      const left = e.extra['attempts_left']
      return typeof left === 'number' ? `PIN ไม่ถูกต้อง (ลองได้อีก ${left} ครั้ง)` : 'PIN ไม่ถูกต้อง'
    }
    case 'pin_locked':
      return 'ใส่ PIN ผิดหลายครั้ง ระบบล็อกชั่วคราว'
    case 'invalid_credentials':
      return 'ไม่พบผู้ใช้นี้ในร้าน'
    case 'session_invalid':
      return 'หมดเวลาเข้าใช้งาน กรุณาเข้าสู่ระบบใหม่'
    case 'device_pending':
      return 'เครื่องนี้ยังรอเจ้าของอนุมัติ'
    case 'device_revoked':
      return 'เครื่องนี้ถูกเพิกถอนแล้ว'
    case 'invalid_device':
      return 'ไม่รู้จักเครื่องนี้ กรุณาลงทะเบียนใหม่'
    case 'unauthorized':
      return 'กรุณาเข้าสู่ระบบใหม่ (รีเฟรชหน้า)'
    case 'forbidden':
      return 'ไม่มีสิทธิ์ทำรายการนี้'
    case 'not_found':
      return 'ไม่พบข้อมูล อาจถูกลบหรือเปลี่ยนไปแล้ว'
    case 'conflict':
      return 'ข้อมูลซ้ำหรือสถานะเปลี่ยนไปแล้ว กรุณารีเฟรช'
    case 'bad_request':
      return 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง'
    case 'upgrade_required':
      return 'ต้องอัปเดตแอปก่อนใช้งานต่อ'
    default:
      return 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง'
  }
}

export function errorCode(e: unknown): string {
  return e instanceof ApiError ? e.code : ''
}

export function errorExtra(e: unknown): Record<string, unknown> {
  return e instanceof ApiError ? e.extra : {}
}

// ---- device credentials (localStorage) / session token (sessionStorage only) ----

export function getDevice(): DeviceCreds | null {
  try {
    const id = localStorage.getItem(DEVICE_ID_KEY)
    const token = localStorage.getItem(DEVICE_TOKEN_KEY)
    return id && token ? { device_id: id, device_token: token } : null
  } catch {
    return null
  }
}

export function saveDevice(creds: DeviceCreds): void {
  localStorage.setItem(DEVICE_ID_KEY, creds.device_id)
  localStorage.setItem(DEVICE_TOKEN_KEY, creds.device_token)
}

export function clearDevice(): void {
  localStorage.removeItem(DEVICE_ID_KEY)
  localStorage.removeItem(DEVICE_TOKEN_KEY)
}

export function getSession(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

export function setSession(token: string): void {
  sessionStorage.setItem(SESSION_KEY, token)
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY)
}

/** 3.56: device revoked — wipe every local trace (localStorage, sessionStorage, IndexedDB). */
export async function wipeAllStorage(): Promise<void> {
  try {
    localStorage.clear()
  } catch {
    // ignore
  }
  try {
    sessionStorage.clear()
  } catch {
    // ignore
  }
  try {
    const idb = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }
    if (typeof idb.databases === 'function') {
      for (const db of await idb.databases()) {
        if (db.name) void indexedDB.deleteDatabase(db.name)
      }
    }
  } catch {
    // ignore
  }
}

// ---- endpoint response types ----

export interface RegisterResponse {
  device_id: string
  device_token: string
  status: string
}

export interface DeviceStatus {
  device_id: string
  status: 'pending' | 'approved' | 'revoked'
  shop_id: string | null
  shop_name: string | null
}

export interface Staff {
  id: string
  name: string
  locked_until: number | null
}

export interface PinResponse {
  session_token: string
  expires_at: number
  user: { id: string; name: string }
}

export interface OwnerMe {
  user_id: string
  email: string
}

export interface Shop {
  id: string
  name: string
}

export interface OwnerDevice {
  id: string
  shop_id: string | null
  name: string
  model: string | null
  status: string
  registered_at: string | null
  approved_at: string | null
  revoked_at: string | null
  last_sync_at: string | null
}

export interface OwnerStaff {
  id: string
  shop_id: string
  name: string
  status: string
  locked_until: number | string | null
}

// ---- owner menu (money = INTEGER satang; UI shows/enters baht) ----

export type MenuType = 'rice_curry' | 'made_to_order'

export interface MenuItem {
  id: string
  shop_id: string
  name: string
  category: string
  menu_type: MenuType
  base_price: number
  price_2: number | null
  price_3: number | null
  grab_price: number | null
  lineman_price: number | null
  foodpanda_price: number | null
  cost: number | null
  image_key: string | null
  sold_out: boolean
  /** derived (0010): an auto_block ingredient behind this item ran out */
  stock_out?: boolean
  status: 'active' | 'inactive'
  sort_order: number
  created_at: string | null
  updated_at: string | null
}

export interface OptionGroup {
  id: string
  shop_id: string
  menu_item_id: string | null
  name: string
  required: boolean
  max_select: number | null
  tier_pricing: boolean
  sort_order: number
}

export interface MenuOption {
  id: string
  shop_id: string
  option_group_id: string
  name: string
  price_add: number
  sold_out: boolean
  /** derived (0010): an auto_block ingredient behind this option ran out */
  stock_out?: boolean
  sort_order: number
}

/** kind 'baht' -> value is satang per plate; kind 'percent' -> value 0..300. */
export interface Markup {
  kind: 'percent' | 'baht'
  value: number
}

export interface ChannelMarkup {
  grab?: Markup
  lineman?: Markup
  foodpanda?: Markup
}

/** GET /api/owner/media-usage — this month's upload counters + storage. */
export interface MediaUsage {
  month: string
  class_a: number
  class_b: number
  stored_bytes: number
  limits: {
    max_image_bytes: number
    max_total_bytes: number
    max_class_a_per_month: number
    max_class_b_per_month: number
  }
}

/** GET /api/owner/shops/{shop_id}/menu */
export interface MenuData {
  items: MenuItem[]
  option_groups: OptionGroup[]
  options: MenuOption[]
  channel_markup: ChannelMarkup
  /** Staff menu only: false when this shop has no Beam credentials (no QR). */
  beam_qr?: boolean
}

// ---- owner stock (M1-6c): ingredients + per-plate recipe uses ----

/** One ingredient row. POST/PUT/restock/count responses don't carry used_today. */
export interface Ingredient {
  id: string
  shop_id: string
  name: string
  /** the unit is set once at creation; every number is counted in it */
  unit: string
  /** approximate remaining amount = last count − sold (recipe × plates) */
  qty: number
  alert_level: number
  /** 0010: block the menu when the estimate runs out (server: 0/1) */
  auto_block: boolean
  /** 0010: units that may still go out below 0 (qty + reserve is sellable) */
  reserve: number
  status: 'active' | 'inactive'
  sort_order: number
  created_at: string | null
  updated_at: string | null
}

/** GET stock rows add the amount already sold today. */
export interface StockIngredient extends Ingredient {
  used_today: number
}

/** How much of one ingredient one target (menu item or option) uses per plate. */
export interface RecipeUse {
  id: string
  ingredient_id: string
  menu_item_id: string | null
  option_id: string | null
  /** server-parsed amount; amount_text is what the owner types ("1/10") */
  amount: number
  amount_text: string
}

/** GET /api/owner/shops/{shop_id}/stock */
export interface StockData {
  ingredients: StockIngredient[]
  recipe: RecipeUse[]
}

// ---- owner day view: bills + payments (money = INTEGER satang; times = unix ms) ----

export type OrderType = 'dine_in' | 'take_away' | 'delivery'

/** The four sales channels (orders.channel, schema 0001). */
export type OrderChannel = 'counter' | 'grab' | 'lineman' | 'foodpanda'

export type OrderStatus = 'preparing' | 'served' | 'paid' | 'cancelled'

export type PaymentMethod = 'cash' | 'delivery_app' | 'promptpay'

/** payments.status: a Beam PromptPay charge is 'pending' before it lands. */
export type PaymentStatus = 'succeeded' | 'refunded' | 'pending' | 'expired'

/** The frozen option snapshot of one bill line (order_items.options_json). */
export interface OrderOptionSnapshot {
  id: string
  name: string
  price_add: number
}

/** One bill line exactly as the order JSON reports it. */
export interface OrderItem {
  id: string
  item_name: string
  options: OrderOptionSnapshot[]
  quantity: number
  note: string | null
  unit_price: number
  discount_amount: number
  line_total: number
}

export interface Order {
  id: string
  queue_number: number
  order_type: OrderType
  channel: OrderChannel
  table_no: string | null
  note: string | null
  status: OrderStatus
  total_amount: number
  discount_amount: number
  created_by: string
  created_at: number
  paid_at: number | null
  cancelled_at: number | null
  cancel_reason: string | null
  /** NULL = the plates are not out yet (a paid bill can still be cooking). */
  served_at: number | null
  /** สวัสดิการพนักงาน: the staff member's own plate, billed 0 and never
   *  counted as a sale (migration 0007). */
  staff_meal: boolean
  /** members/loyalty (0011): the attached customer, or null = no member. */
  customer_id: string | null
  /** the nickname of customer_id (null when there is none). */
  member_name: string | null
  /** points reserved on this open bill; only deducted when it is paid. */
  points_redeemed: number
  /** points earned, set once when the payment succeeds. */
  points_earned: number
  /** the member's CURRENT balance (null when there is no member). */
  member_points: number | null
  items: OrderItem[]
}

/** One payments row as the owner API reports it (with the refund fields). */
export interface Payment {
  id: string
  method: PaymentMethod
  amount: number
  cash_received: number | null
  cash_change: number | null
  status: PaymentStatus
  refund_amount: number | null
  refund_reason: string | null
  refunded_at: number | null
  created_at: number
}

/** GET /api/owner/shops/{shop_id}/orders?day=YYYY-MM-DD: one bill + its payments. */
export interface OwnerDayOrder extends Order {
  payments: Payment[]
}

export interface OwnerDayOrdersData {
  orders: OwnerDayOrder[]
}

// ---- owner report (M2-R1): GET /api/owner/shops/{shop_id}/report ----
// Money is INTEGER satang like everywhere else; `from`/`to` and the day keys
// are Bangkok calendar days "YYYY-MM-DD"; every bucket counts PAID bills
// only, except `summary`, which also reports cancelled/open ones.

/** summary block: net = paid money minus refunds (satang). */
export interface ReportSummary {
  bills: number
  net: number
  refunds: number
  cancelled: number
  open: number
  plates: number
  avg_bill: number
}

/** One Bangkok day of the period, inclusive. */
export interface ReportDayBucket {
  day: string
  bills: number
  net: number
}

/** One Bangkok hour of the day (0..23, summed over the whole period). */
export interface ReportHourBucket {
  hour: number
  bills: number
  net: number
}

/** Plates sold of one menu type (qty = plates, amount = satang). */
export interface ReportMenuRow {
  menu_item_id: string
  name: string
  qty: number
  amount: number
}

/** Times one choice was picked on lines of that type. */
export interface ReportChoiceRow {
  option_id: string
  name: string
  menu_item_id: string
  qty: number
}

/** Ingredient the filtered bills consumed (already rounded to 4 decimals). */
export interface ReportIngredientRow {
  ingredient_id: string
  name: string
  unit: string
  used: number
  /** of `used`, what went into staff meals (สวัสดิการ). */
  staff_used: number
}

/** Paid bills by payment method ('cash' | 'promptpay' | 'delivery_app' …). */
export interface ReportMethodRow {
  method: string
  bills: number
  net: number
}

/** Staff meals (สวัสดิการ) per staff member; value = menu price in satang. */
export interface ReportStaffMealRow {
  user_id: string
  name: string
  plates: number
  value: number
}

/**
 * The stock journal of one Bangkok day and ingredient. On a day with
 * counts > 0: real use = recipe_use - count_delta (a count that finds LESS
 * than the estimate = more went out than the recipe says).
 */
export interface ReportStockCheckRow {
  day: string
  ingredient_id: string
  name: string
  unit: string
  recipe_use: number
  restock: number
  count_delta: number
  counts: number
}

/** One bill of the capped list; `lines` is a ready-made "2× ข้าวมัน, …" text. */
export interface ReportBillRow {
  id: string
  queue_number: number
  created_at: number
  channel: OrderChannel
  /** + 'staff' / 'staff_cancelled' for staff meals (สวัสดิการ, never a sale). */
  status: OrderStatus | 'staff' | 'staff_cancelled' | 'test' | 'test_cancelled'
  net: number
  lines: string | null
}

/** GET /api/owner/shops/{shop_id}/report?from&to&tfrom&tto&menu_item_id&option_id&ingredient_id */
export interface ReportData {
  from: string
  to: string
  summary: ReportSummary
  by_day: ReportDayBucket[]
  by_hour: ReportHourBucket[]
  menu: ReportMenuRow[]
  choices: ReportChoiceRow[]
  ingredients: ReportIngredientRow[]
  bills: ReportBillRow[]
  /** the list above never grows past this — show "แสดง N บิลล่าสุด" when equal. */
  bills_capped_at: number
  by_method: ReportMethodRow[]
  staff_meals: ReportStaffMealRow[]
  /** NOT narrowed by the bill filters: the whole date range. */
  stock_check: ReportStockCheckRow[]
}

// ---- owner slips (slip reader phase 1) ----
// Money here is PLAIN BAHT as the reader reports it (not satang like menus),
// times are unix ms like the rest of the owner API.

export type SlipStatus = 'draft' | 'queued' | 'reading' | 'read' | 'failed'

/** Who is reading / did read the slip: the PC agent or Workers AI. */
export type SlipReader = 'local' | 'cloud'

/** One purchased item the reader extracted from the photos. */
export interface SlipLine {
  code: string | null
  name: string
  qty: number | null
  unit: string | null
  unit_price: number | null
  total: number | null
}

/** The reader's normalised output (validated server-side before it is stored). */
export interface SlipResult {
  store: string | null
  /** "YYYY-MM-DD" (CE) or null when unreadable */
  date: string | null
  receipt_no: string | null
  lines: SlipLine[]
  discount: number | null
  grand_total: number | null
}

/** GET /api/owner/slips/{id} — the row with its parsed result. */
export interface Slip {
  id: string
  shop_id: string
  status: SlipStatus
  reader: SlipReader | null
  page_count: number
  attempts: number
  error: string | null
  result: SlipResult | null
  submitted_at: number | null
  read_at: number | null
  created_at: number
}

/** Reader gateway state: is the PC agent up, and is there cloud budget left? */
export interface SlipReaderState {
  local_online: boolean
  local_seen_at: number | null
  cloud_neurons_today: number
  cloud_cap: number
  cloud_available: boolean
  /** slips of this shop waiting in 'queued' */
  waiting_count: number
}

/** GET /api/owner/slips?shop_id=… */
export interface SlipsData {
  reader: SlipReaderState
  slips: Slip[]
}

// ---- members + loyalty points (docs/members-spec.md) ----

/**
 * GET /api/public/join/{shop_id} (no auth) — the public join page data: the
 * shop name (the PDPA data controller shown in the notice) and the consent
 * version the server expects POSTed back with the submission.
 */
export interface PublicShopInfo {
  shop_name: string
  consent_version: string
}

/**
 * One row of GET /api/owner/shops/{shop_id}/customers?q= — `updated_at` is the
 * member's LAST service use (a paid bill), unix ms like the rest of the owner
 * API; it drives point expiry (6 months) and PDPA erasure (1 year).
 */
export interface OwnerCustomer {
  id: string
  nickname: string
  phone: string
  points: number
  consent_at: number
  updated_at: number
}

/**
 * The `customer` object of POST /api/members/lookup. `points` is the member's
 * balance; `available_points` additionally subtracts the points already
 * reserved by the member's OTHER open counter bills (ignoring `order_id`
 * itself), and is what a redemption on this bill is capped by.
 */
export interface MemberLookup {
  id: string
  nickname: string
  phone_last4: string
  points: number
  available_points: number
}

/** POST /api/members/lookup body `{ phone, order_id? }` -> `{ customer }`. */
export interface MemberLookupResult {
  customer: MemberLookup
}

/**
 * PUT /api/orders/{id}/member body: attach/detach a member and set the points
 * to redeem on this bill (multiple of 10; `customer_id: null` detaches).
 */
export interface OrderMemberBody {
  customer_id: string | null
  points: number
}
