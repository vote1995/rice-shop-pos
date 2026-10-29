// Typed fetch wrapper for the Rust Worker API (same-origin, served under /api).

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

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  auth: AuthMode = 'none',
): Promise<T> {
  const headers: Record<string, string> = {}
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
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้')
  }
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
    throw new ApiError(res.status, code, message, obj)
  }
  return data as T
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

/** GET /api/owner/shops/{shop_id}/menu */
export interface MenuData {
  items: MenuItem[]
  option_groups: OptionGroup[]
  options: MenuOption[]
  channel_markup: ChannelMarkup
}
