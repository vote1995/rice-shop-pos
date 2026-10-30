import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError, api, friendlyError } from '../api'
import type { OwnerDevice, OwnerMe, OwnerStaff, Shop } from '../api'
import MenuEditor from './MenuEditor'
import StockPanel from './StockPanel'
import { OrdersPanel } from './OrdersPanel'

type Tab = 'orders' | 'devices' | 'shops' | 'staff' | 'menu' | 'stock'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'orders', label: 'ออเดอร์' },
  { id: 'devices', label: 'เครื่อง' },
  { id: 'shops', label: 'ร้าน' },
  { id: 'staff', label: 'พนักงาน' },
  { id: 'menu', label: 'เมนู' },
  { id: 'stock', label: 'สต็อก' },
]

function fmtTime(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '-'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('th-TH')
}

function isLocked(v: string | number | null | undefined): boolean {
  if (v === null || v === undefined || v === '') return false
  const t = new Date(v).getTime()
  return !Number.isNaN(t) && t > Date.now()
}

export default function OwnerApp() {
  const [tab, setTab] = useState<Tab>('devices')
  const [me, setMe] = useState<OwnerMe | null>(null)
  const [denied, setDenied] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    let on = true
    void (async () => {
      try {
        const m = await api<OwnerMe>('GET', '/api/owner/me')
        if (on) setMe(m)
      } catch (e) {
        if (!on) return
        if (e instanceof ApiError && e.status === 403) setDenied(true)
        else setMsg(friendlyError(e))
      }
    })()
    return () => {
      on = false
    }
  }, [])

  if (denied) {
    return (
      <div className="screen">
        <main className="content">
          <div className="card center">
            <h1>POS ร้านข้าว · เจ้าของ</h1>
            <p className="error">บัญชีนี้ไม่มีสิทธิ์เจ้าของร้าน</p>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="screen">
      <header className="bar">
        <span className="brand">POS ร้านข้าว · เจ้าของ</span>
        <span className="muted small">{me ? me.email : '…'}</span>
      </header>
      <nav className="tabs" role="tablist" aria-label="เมนูเจ้าของร้าน">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className="btn" onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <main className="owner-main">
        {msg ? (
          <p className="error" role="alert">
            {msg}
          </p>
        ) : null}
        {tab === 'orders' ? <OrdersPanel /> : null}
        {tab === 'devices' ? <DevicesPanel /> : null}
        {tab === 'shops' ? <ShopsPanel /> : null}
        {tab === 'staff' ? <StaffPanel /> : null}
        {tab === 'menu' ? <MenuEditor /> : null}
        {tab === 'stock' ? <StockPanel /> : null}
      </main>
    </div>
  )
}

function DevicesPanel() {
  const [devices, setDevices] = useState<OwnerDevice[]>([])
  const [shops, setShops] = useState<Shop[]>([])
  const [sel, setSel] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      const [ds, ss] = await Promise.all([
        api<OwnerDevice[]>('GET', '/api/owner/devices'),
        api<Shop[]>('GET', '/api/owner/shops'),
      ])
      setDevices(ds)
      setShops(ss)
      setMsg('')
    } catch (e) {
      setMsg(friendlyError(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const shopOf = (d: OwnerDevice): string => shops.find((s) => s.id === d.shop_id)?.name ?? '-'

  async function approve(d: OwnerDevice) {
    const shopId = sel[d.id] ?? shops[0]?.id ?? ''
    if (!shopId) {
      setMsg('ยังไม่มีร้าน — สร้างร้านในแท็บ "ร้าน" ก่อน')
      return
    }
    try {
      await api('POST', `/api/owner/devices/${encodeURIComponent(d.id)}/approve`, { shop_id: shopId })
      await load()
    } catch (e) {
      setMsg(friendlyError(e))
    }
  }

  async function revoke(d: OwnerDevice) {
    if (!window.confirm(`เพิกถอนเครื่อง "${d.name}"?`)) return
    try {
      await api('POST', `/api/owner/devices/${encodeURIComponent(d.id)}/revoke`)
      await load()
    } catch (e) {
      setMsg(friendlyError(e))
    }
  }

  const pending = devices.filter((d) => d.status === 'pending')
  const rest = devices.filter((d) => d.status !== 'pending')

  return (
    <section>
      <div className="row">
        <h2 className="grow">รออนุมัติ ({pending.length})</h2>
        <button className="btn ghost" onClick={() => void load()}>
          รีเฟรช
        </button>
      </div>
      {msg ? <p className="error">{msg}</p> : null}
      {pending.length === 0 ? <p className="muted">ไม่มีเครื่องรออนุมัติ</p> : null}
      <div className="list">
        {pending.map((d) => (
          <div className="item pending-item" key={d.id}>
            <div className="row">
              <strong className="grow">{d.name}</strong>
              <span className="badge pending">รออนุมัติ</span>
            </div>
            <p className="muted small">{d.model ?? '-'}</p>
            <p className="muted small">ลงทะเบียน: {fmtTime(d.registered_at)}</p>
            <div className="row">
              <select
                className="grow"
                value={sel[d.id] ?? shops[0]?.id ?? ''}
                onChange={(e) => setSel({ ...sel, [d.id]: e.target.value })}
              >
                {shops.length === 0 ? <option value="">— สร้างร้านก่อน —</option> : null}
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button className="btn primary" onClick={() => void approve(d)}>
                อนุมัติ
              </button>
            </div>
          </div>
        ))}
      </div>

      <h2>
        เครื่องทั้งหมด ({rest.length})
      </h2>
      <div className="list">
        {rest.map((d) => (
          <div className={`item ${d.status === 'approved' ? 'ok-item' : ''}`} key={d.id}>
            <div className="row">
              <strong className="grow">{d.name}</strong>
              <span className={`badge ${d.status}`}>
                {d.status === 'approved' ? 'ใช้งาน' : 'เพิกถอนแล้ว'}
              </span>
            </div>
            <p className="muted small">
              ร้าน: {shopOf(d)} · ลงทะเบียน: {fmtTime(d.registered_at)} · ใช้งานล่าสุด: {fmtTime(d.last_sync_at)}
            </p>
            {d.status === 'approved' ? (
              <button className="btn danger" onClick={() => void revoke(d)}>
                เพิกถอน
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}

function ShopsPanel() {
  const [shops, setShops] = useState<Shop[]>([])
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      setShops(await api<Shop[]>('GET', '/api/owner/shops'))
      setMsg('')
    } catch (e) {
      setMsg(friendlyError(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    try {
      await api('POST', '/api/owner/shops', { id: crypto.randomUUID(), name: n })
      setName('')
      await load()
    } catch (err) {
      setMsg(friendlyError(err))
    }
  }

  return (
    <section>
      {msg ? <p className="error">{msg}</p> : null}
      <form className="card" onSubmit={add}>
        <h2>เพิ่มร้าน</h2>
        <label>
          ชื่อร้าน
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น ร้านข้าวป้าใจ" />
        </label>
        <button className="btn primary" type="submit">
          เพิ่มร้าน
        </button>
      </form>
      <div className="list">
        {shops.map((s) => (
          <div className="item ok-item" key={s.id}>
            <strong>{s.name}</strong>
            <p className="muted small">{s.id}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function StaffPanel() {
  const [shops, setShops] = useState<Shop[]>([])
  const [shopId, setShopId] = useState('')
  const [staff, setStaff] = useState<OwnerStaff[]>([])
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    let on = true
    void (async () => {
      try {
        const ss = await api<Shop[]>('GET', '/api/owner/shops')
        if (!on) return
        setShops(ss)
        if (ss.length > 0) setShopId((cur) => cur || ss[0].id)
      } catch (e) {
        if (on) setMsg(friendlyError(e))
      }
    })()
    return () => {
      on = false
    }
  }, [])

  const load = useCallback(async () => {
    if (!shopId) {
      setStaff([])
      return
    }
    try {
      setStaff(await api<OwnerStaff[]>('GET', `/api/owner/staff?shop_id=${encodeURIComponent(shopId)}`))
      setMsg('')
    } catch (e) {
      setMsg(friendlyError(e))
    }
  }, [shopId])

  useEffect(() => {
    void load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    const n = name.trim()
    if (!n || !shopId) {
      setMsg('กรอกชื่อพนักงาน และเลือกร้าน')
      return
    }
    if (!/^\d{4,6}$/.test(pin)) {
      setMsg('PIN ต้องเป็นตัวเลข 4-6 หลัก')
      return
    }
    try {
      await api('POST', '/api/owner/staff', { id: crypto.randomUUID(), shop_id: shopId, name: n, pin })
      setName('')
      setPin('')
      await load()
    } catch (err) {
      setMsg(friendlyError(err))
    }
  }

  async function resetPin(s: OwnerStaff) {
    const p = window.prompt(`ตั้ง PIN ใหม่ (4-6 หลัก) สำหรับ ${s.name}`)
    if (p === null) return
    if (!/^\d{4,6}$/.test(p)) {
      setMsg('PIN ต้องเป็นตัวเลข 4-6 หลัก')
      return
    }
    try {
      await api('POST', `/api/owner/staff/${encodeURIComponent(s.id)}/reset-pin`, { pin: p })
      setMsg(`ตั้ง PIN ใหม่ให้ ${s.name} แล้ว`)
    } catch (e) {
      setMsg(friendlyError(e))
    }
  }

  async function revokeStaff(s: OwnerStaff) {
    if (!window.confirm(`ปิดผู้ใช้ "${s.name}"?`)) return
    try {
      await api('POST', `/api/owner/staff/${encodeURIComponent(s.id)}/revoke`)
      await load()
    } catch (e) {
      setMsg(friendlyError(e))
    }
  }

  return (
    <section>
      {msg ? <p className="error">{msg}</p> : null}
      <label>
        ร้าน
        <select value={shopId} onChange={(e) => setShopId(e.target.value)}>
          {shops.length === 0 ? <option value="">— ยังไม่มีร้าน —</option> : null}
          {shops.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="list">
        {staff.map((s) => (
          <div className="item" key={s.id}>
            <div className="row">
              <strong className="grow">{s.name}</strong>
              <span className={`badge ${s.status === 'active' ? 'approved' : 'revoked'}`}>
                {s.status === 'active' ? 'ใช้งาน' : 'ปิดแล้ว'}
              </span>
            </div>
            {isLocked(s.locked_until) ? <p className="error small">PIN ล็อกถึง {fmtTime(s.locked_until)}</p> : null}
            <div className="row">
              <button className="btn" onClick={() => void resetPin(s)}>
                ตั้ง PIN ใหม่
              </button>
              {s.status === 'active' ? (
                <button className="btn danger" onClick={() => void revokeStaff(s)}>
                  ปิดผู้ใช้
                </button>
              ) : null}
            </div>
          </div>
        ))}
        {staff.length === 0 ? <p className="muted">ไม่มีพนักงานในร้านนี้</p> : null}
      </div>
      <form className="card" onSubmit={add}>
        <h2>เพิ่มพนักงาน</h2>
        <label>
          ชื่อ
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ชื่อ-นามสกุล" />
        </label>
        <label>
          PIN (ตัวเลข 4-6 หลัก)
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            placeholder="เช่น 1234"
          />
        </label>
        <button className="btn primary" type="submit">
          เพิ่มพนักงาน
        </button>
      </form>
    </section>
  )
}
