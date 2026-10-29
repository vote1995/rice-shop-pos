import { useCallback, useEffect, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { api, deleteMenuImage, errorCode, friendlyError, getMediaUsage, mediaUrl, uploadMenuImage } from '../api'
import type { Markup, MediaUsage, MenuData, MenuItem, MenuOption, MenuType, OptionGroup, Shop } from '../api'
import { prepareMenuImage } from '../imageResize'

type Channel = 'grab' | 'lineman' | 'foodpanda'

const CHANNELS: Array<{ id: Channel; label: string }> = [
  { id: 'grab', label: 'Grab' },
  { id: 'lineman', label: 'LINE MAN' },
  { id: 'foodpanda', label: 'Foodpanda' },
]

// ---- baht <-> satang (backend stores INTEGER satang; UI shows/enters baht) ----

function fmtBaht(satang: number): string {
  const b = satang / 100
  return Number.isInteger(b) ? String(b) : b.toFixed(2).replace(/0$/, '')
}

function satangToInput(satang: number | null | undefined): string {
  return satang === null || satang === undefined ? '' : fmtBaht(satang)
}

/** '' -> null (not set); anything unparsable -> 'invalid'. */
function bahtToSatang(s: string): number | null | 'invalid' {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return 'invalid'
  const v = Math.round(n * 100)
  return Number.isSafeInteger(v) ? v : 'invalid'
}

function typeLabel(t: MenuType): string {
  return t === 'rice_curry' ? 'ข้าวราดแกง' : 'ตามสั่ง'
}

function priceLine(it: MenuItem): string {
  if (it.menu_type === 'rice_curry') {
    const parts = [`1 อย่าง ${fmtBaht(it.base_price)}`]
    if (it.price_2 !== null) parts.push(`2 อย่าง ${fmtBaht(it.price_2)}`)
    if (it.price_3 !== null) parts.push(`3 อย่าง ${fmtBaht(it.price_3)}`)
    return `${parts.join(' / ')} บาท`
  }
  const extras: string[] = []
  if (it.grab_price !== null) extras.push(`Grab ${fmtBaht(it.grab_price)}`)
  if (it.lineman_price !== null) extras.push(`LINE MAN ${fmtBaht(it.lineman_price)}`)
  if (it.foodpanda_price !== null) extras.push(`Foodpanda ${fmtBaht(it.foodpanda_price)}`)
  return `${fmtBaht(it.base_price)} บาท${extras.length > 0 ? ` · ${extras.join(' · ')}` : ''}`
}

// ---- menu item images (M1-5b) ----

function fmtMB(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(1)
}

/** Thai message for image upload failures (client resize + server quota). */
function imageErrorText(e: unknown): string {
  const code = errorCode(e)
  if (code === 'media_quota') return 'เกินโควต้ารูปภาพของเดือนนี้'
  if (code === 'image_too_large') return 'รูปใหญ่เกินไป'
  if (e instanceof Error && e.message === 'รูปใหญ่เกินไป') return e.message
  return friendlyError(e)
}

// ---- form drafts (string inputs, converted on submit) ----

interface ItemDraft {
  id: string | null
  name: string
  category: string
  menu_type: MenuType
  base: string
  price2: string
  price3: string
  grab: string
  lineman: string
  foodpanda: string
  cost: string
  sortOrder: string
}

function itemDraft(it?: MenuItem): ItemDraft {
  if (!it) {
    return {
      id: null,
      name: '',
      category: '',
      menu_type: 'rice_curry',
      base: '',
      price2: '',
      price3: '',
      grab: '',
      lineman: '',
      foodpanda: '',
      cost: '',
      sortOrder: '',
    }
  }
  return {
    id: it.id,
    name: it.name,
    category: it.category,
    menu_type: it.menu_type,
    base: satangToInput(it.base_price),
    price2: satangToInput(it.price_2),
    price3: satangToInput(it.price_3),
    grab: satangToInput(it.grab_price),
    lineman: satangToInput(it.lineman_price),
    foodpanda: satangToInput(it.foodpanda_price),
    cost: satangToInput(it.cost),
    sortOrder: String(it.sort_order),
  }
}

interface ItemValues {
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
  sort_order: number
}

interface GroupDraft {
  name: string
  required: boolean
  maxSelect: string
  tierPricing: boolean
}

function groupDraft(g?: OptionGroup): GroupDraft {
  return {
    name: g?.name ?? '',
    required: g?.required ?? false,
    maxSelect: g?.max_select === null || g?.max_select === undefined ? '' : String(g.max_select),
    tierPricing: g?.tier_pricing ?? false,
  }
}

interface GroupValues {
  name: string
  required: boolean
  max_select: number | null
  tier_pricing: boolean
}

interface OptionDraft {
  name: string
  priceAdd: string
}

function optionDraft(o?: MenuOption): OptionDraft {
  return { name: o?.name ?? '', priceAdd: o ? fmtBaht(o.price_add) : '' }
}

interface OptionValues {
  name: string
  price_add: number
}

type MarkupKind = 'none' | 'percent' | 'baht'

interface MarkupField {
  kind: MarkupKind
  value: string
}

type MarkupFormState = Record<Channel, MarkupField>

function markupField(m: Markup | undefined): MarkupField {
  if (!m) return { kind: 'none', value: '' }
  return { kind: m.kind, value: m.kind === 'baht' ? fmtBaht(m.value) : String(m.value) }
}

function markupFormFrom(data: MenuData | null): MarkupFormState {
  if (!data) {
    return { grab: { kind: 'none', value: '' }, lineman: { kind: 'none', value: '' }, foodpanda: { kind: 'none', value: '' } }
  }
  return {
    grab: markupField(data.channel_markup.grab),
    lineman: markupField(data.channel_markup.lineman),
    foodpanda: markupField(data.channel_markup.foodpanda),
  }
}

export default function MenuPanel() {
  const [shops, setShops] = useState<Shop[]>([])
  const [shopId, setShopId] = useState('')
  const [data, setData] = useState<MenuData | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [itemForm, setItemForm] = useState<{ mode: 'add' } | { mode: 'edit'; id: string } | null>(null)
  const [groupForm, setGroupForm] = useState<
    { mode: 'add'; itemId: string | null } | { mode: 'edit'; id: string } | null
  >(null)
  const [optionForm, setOptionForm] = useState<{ mode: 'add'; groupId: string } | { mode: 'edit'; id: string } | null>(
    null,
  )
  const [markupForm, setMarkupForm] = useState<MarkupFormState>(() => markupFormFrom(null))
  const [usage, setUsage] = useState<MediaUsage | null>(null)

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
      setData(null)
      return
    }
    setBusy(true)
    try {
      const d = await api<MenuData>('GET', `/api/owner/shops/${encodeURIComponent(shopId)}/menu`)
      setData(d)
      setMsg('')
    } catch (e) {
      setMsg(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }, [shopId])

  useEffect(() => {
    void load()
  }, [load])

  // media usage footer line (informational only — failures are ignored)
  const loadUsage = useCallback(async () => {
    try {
      setUsage(await getMediaUsage())
    } catch {
      // the quota line is not worth an error message
    }
  }, [])

  useEffect(() => {
    void loadUsage()
  }, [loadUsage])

  // switching shops invalidates any open form / expansion
  useEffect(() => {
    setExpanded(new Set())
    setItemForm(null)
    setGroupForm(null)
    setOptionForm(null)
  }, [shopId])

  // markup card follows the freshly loaded data (also re-syncs after save)
  useEffect(() => {
    setMarkupForm(markupFormFrom(data))
  }, [data])

  const items = data ? [...data.items].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'th')) : []
  const groups = data
    ? [...data.option_groups].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'th'))
    : []
  const options = data ? [...data.options].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'th')) : []

  const categories: string[] = []
  for (const it of items) if (!categories.includes(it.category)) categories.push(it.category)

  /** Run one mutation with busy flag + friendly error + reload. Returns success. */
  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true)
    try {
      await fn()
      setMsg('')
      await load()
      return true
    } catch (e) {
      setMsg(friendlyError(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  /** Swap one item in local state after an image upload/delete (no full reload). */
  function itemImageChanged(updated: MenuItem) {
    setData((prev) => (prev ? { ...prev, items: prev.items.map((i) => (i.id === updated.id ? updated : i)) } : prev))
    void loadUsage()
  }

  function itemPutBody(it: MenuItem, over: Record<string, unknown>): Record<string, unknown> {
    return {
      name: it.name,
      category: it.category,
      menu_type: it.menu_type,
      base_price: it.base_price,
      price_2: it.price_2,
      price_3: it.price_3,
      grab_price: it.grab_price,
      lineman_price: it.lineman_price,
      foodpanda_price: it.foodpanda_price,
      cost: it.cost,
      sort_order: it.sort_order,
      status: it.status,
      sold_out: it.sold_out,
      ...over,
    }
  }

  async function saveItem(v: ItemValues) {
    if (!shopId) return
    const editId = itemForm?.mode === 'edit' ? itemForm.id : null
    const existing = editId ? items.find((i) => i.id === editId) : undefined
    const ok = await run(async () => {
      if (editId) {
        // PUT requires ALL keys; nullable ones as null.
        await api('PUT', `/api/owner/menu-items/${encodeURIComponent(editId)}`, {
          name: v.name,
          category: v.category,
          menu_type: v.menu_type,
          base_price: v.base_price,
          price_2: v.menu_type === 'rice_curry' ? v.price_2 : null,
          price_3: v.menu_type === 'rice_curry' ? v.price_3 : null,
          grab_price: v.menu_type === 'made_to_order' ? v.grab_price : null,
          lineman_price: v.menu_type === 'made_to_order' ? v.lineman_price : null,
          foodpanda_price: v.menu_type === 'made_to_order' ? v.foodpanda_price : null,
          cost: v.cost,
          sort_order: v.sort_order,
          status: existing?.status ?? 'active',
          sold_out: existing?.sold_out ?? false,
        })
        return
      }
      const body: Record<string, unknown> = {
        id: crypto.randomUUID(),
        shop_id: shopId,
        name: v.name,
        category: v.category,
        menu_type: v.menu_type,
        base_price: v.base_price,
        sort_order: v.sort_order,
      }
      if (v.menu_type === 'rice_curry') {
        if (v.price_2 !== null) body.price_2 = v.price_2
        if (v.price_3 !== null) body.price_3 = v.price_3
      }
      if (v.menu_type === 'made_to_order') {
        if (v.grab_price !== null) body.grab_price = v.grab_price
        if (v.lineman_price !== null) body.lineman_price = v.lineman_price
        if (v.foodpanda_price !== null) body.foodpanda_price = v.foodpanda_price
      }
      if (v.cost !== null) body.cost = v.cost
      await api('POST', '/api/owner/menu-items', body)
    })
    if (ok) setItemForm(null)
  }

  async function toggleItemSoldOut(it: MenuItem) {
    await run(() => api('PUT', `/api/owner/menu-items/${encodeURIComponent(it.id)}`, itemPutBody(it, { sold_out: !it.sold_out })))
  }

  async function toggleItemStatus(it: MenuItem) {
    const status = it.status === 'active' ? 'inactive' : 'active'
    await run(() => api('PUT', `/api/owner/menu-items/${encodeURIComponent(it.id)}`, itemPutBody(it, { status })))
  }

  async function saveGroup(v: GroupValues) {
    if (!shopId || !groupForm) return
    const gf = groupForm
    // at most one tier-pricing group per item (backend rule, checked early)
    const targetItemId = gf.mode === 'add' ? gf.itemId : (groups.find((g) => g.id === gf.id)?.menu_item_id ?? null)
    if (v.tier_pricing && targetItemId !== null) {
      const clash = groups.some((g) => g.menu_item_id === targetItemId && g.tier_pricing && g.id !== (gf.mode === 'edit' ? gf.id : ''))
      if (clash) {
        setMsg('เมนูนี้มีกลุ่ม "นับจำนวนแกง" อยู่แล้ว — หนึ่งเมนูมีได้กลุ่มเดียว')
        return
      }
    }
    const ok = await run(async () => {
      if (gf.mode === 'add') {
        await api('POST', '/api/owner/option-groups', {
          id: crypto.randomUUID(),
          shop_id: shopId,
          menu_item_id: gf.itemId,
          name: v.name,
          required: v.required,
          max_select: v.max_select,
          tier_pricing: v.tier_pricing,
        })
      } else {
        const cur = groups.find((g) => g.id === gf.id)
        await api('PUT', `/api/owner/option-groups/${encodeURIComponent(gf.id)}`, {
          name: v.name,
          required: v.required,
          max_select: v.max_select,
          tier_pricing: v.tier_pricing,
          sort_order: cur?.sort_order ?? 0,
        })
      }
    })
    if (ok) setGroupForm(null)
  }

  async function deleteGroup(g: OptionGroup) {
    if (!window.confirm(`ลบกลุ่ม "${g.name}"? ตัวเลือกทั้งหมดในกลุ่มนี้จะถูกลบด้วย`)) return
    await run(() => api('DELETE', `/api/owner/option-groups/${encodeURIComponent(g.id)}`))
  }

  async function saveOption(v: OptionValues) {
    if (!optionForm) return
    const of = optionForm
    const ok = await run(async () => {
      if (of.mode === 'add') {
        await api('POST', '/api/owner/options', {
          id: crypto.randomUUID(),
          option_group_id: of.groupId,
          name: v.name,
          price_add: v.price_add,
        })
      } else {
        const cur = options.find((o) => o.id === of.id)
        await api('PUT', `/api/owner/options/${encodeURIComponent(of.id)}`, {
          name: v.name,
          price_add: v.price_add,
          sort_order: cur?.sort_order ?? 0,
          sold_out: cur?.sold_out ?? false,
        })
      }
    })
    if (ok) setOptionForm(null)
  }

  async function toggleOptionSoldOut(o: MenuOption) {
    await run(() =>
      api('PUT', `/api/owner/options/${encodeURIComponent(o.id)}`, {
        name: o.name,
        price_add: o.price_add,
        sort_order: o.sort_order,
        sold_out: !o.sold_out,
      }),
    )
  }

  async function deleteOption(o: MenuOption) {
    if (!window.confirm(`ลบตัวเลือก "${o.name}"?`)) return
    await run(() => api('DELETE', `/api/owner/options/${encodeURIComponent(o.id)}`))
  }

  function setMarkupField(ch: Channel, patch: Partial<MarkupField>) {
    setMarkupForm((prev) => ({ ...prev, [ch]: { ...prev[ch], ...patch } }))
  }

  async function saveMarkup() {
    if (!shopId) return
    const body: Record<string, Markup> = {}
    for (const ch of CHANNELS) {
      const f = markupForm[ch.id]
      if (f.kind === 'none') continue
      const t = f.value.trim()
      const n = Number(t)
      if (t === '' || !Number.isFinite(n) || n < 0) {
        setMsg(`ค่าส่วนต่างของ ${ch.label} ไม่ถูกต้อง`)
        return
      }
      if (f.kind === 'percent') {
        if (!Number.isInteger(n) || n > 300) {
          setMsg(`เปอร์เซ็นต์ของ ${ch.label} ต้องเป็นตัวเลข 0-300`)
          return
        }
        body[ch.id] = { kind: 'percent', value: n }
      } else {
        body[ch.id] = { kind: 'baht', value: Math.round(n * 100) }
      }
    }
    await run(() => api('PUT', `/api/owner/shops/${encodeURIComponent(shopId)}/channel-markup`, body))
  }

  // ---- rendering helpers ----

  const groupsOfItem = (itemId: string) => groups.filter((g) => g.menu_item_id === itemId)
  const shopGroups = groups.filter((g) => g.menu_item_id === null)
  const optionsOf = (groupId: string) => options.filter((o) => o.option_group_id === groupId)

  function renderGroup(g: OptionGroup) {
    const opts = optionsOf(g.id)
    const item = items.find((i) => i.id === g.menu_item_id)
    const showTier = g.tier_pricing || item?.menu_type === 'rice_curry'
    const groupEditHere = groupForm?.mode === 'edit' && groupForm.id === g.id
    const optAddHere = optionForm?.mode === 'add' && optionForm.groupId === g.id
    const optEditId = optionForm?.mode === 'edit' ? optionForm.id : null
    const optEditHere = optEditId !== null && opts.some((o) => o.id === optEditId)
    const editingOption = optEditId !== null ? options.find((o) => o.id === optEditId) : undefined
    return (
      <div className="group-block" key={g.id}>
        {groupEditHere ? (
          <GroupForm
            title="แก้ไขกลุ่มตัวเลือก"
            initial={groupDraft(g)}
            showTier={showTier}
            busy={busy}
            onSave={saveGroup}
            onCancel={() => setGroupForm(null)}
          />
        ) : (
          <div className="row">
            <strong className="grow">{g.name}</strong>
            {g.tier_pricing ? <span className="badge approved">นับแกงคิดราคา</span> : null}
            <span className={`badge ${g.required ? 'approved' : ''}`}>{g.required ? 'ต้องเลือก' : 'เลือกได้'}</span>
            <span className="muted small">{g.max_select === null ? 'ไม่จำกัด' : `สูงสุด ${g.max_select} อย่าง`}</span>
          </div>
        )}
        <div className="list">
          {opts.map((o) => (
            <div className="row opt-line" key={o.id}>
              <span className="grow">
                {o.name} <span className="muted small">+{fmtBaht(o.price_add)} บาท</span>
              </span>
              {o.sold_out ? <span className="badge pending">ของหมด</span> : null}
              <button className="btn ghost" disabled={busy} onClick={() => setOptionForm({ mode: 'edit', id: o.id })}>
                แก้ไข
              </button>
              <button className="btn" disabled={busy} onClick={() => void toggleOptionSoldOut(o)}>
                {o.sold_out ? 'มีของ' : 'ของหมด'}
              </button>
              <button className="btn danger" disabled={busy} onClick={() => void deleteOption(o)}>
                ลบ
              </button>
            </div>
          ))}
          {opts.length === 0 ? <p className="muted small">ยังไม่มีตัวเลือกในกลุ่มนี้</p> : null}
        </div>
        {optAddHere || optEditHere ? (
          <OptionForm
            title={optAddHere ? 'เพิ่มตัวเลือก' : 'แก้ไขตัวเลือก'}
            initial={optionDraft(editingOption)}
            busy={busy}
            onSave={saveOption}
            onCancel={() => setOptionForm(null)}
          />
        ) : (
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => setOptionForm({ mode: 'add', groupId: g.id })}>
              เพิ่มตัวเลือก
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => setGroupForm({ mode: 'edit', id: g.id })}>
              แก้ไขกลุ่ม
            </button>
            <button className="btn danger" disabled={busy} onClick={() => void deleteGroup(g)}>
              ลบกลุ่ม
            </button>
          </div>
        )}
      </div>
    )
  }

  const editItemId = itemForm?.mode === 'edit' ? itemForm.id : null
  const editingItem = editItemId !== null ? items.find((i) => i.id === editItemId) : undefined

  return (
    <section>
      {msg ? (
        <p className="error" role="alert">
          {msg}
        </p>
      ) : null}
      <label>
        ร้าน
        <select value={shopId} onChange={(e) => setShopId(e.target.value)} disabled={busy}>
          {shops.length === 0 ? <option value="">— ยังไม่มีร้าน —</option> : null}
          {shops.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      {usage ? (
        <p className="muted small">
          พื้นที่รูป: {fmtMB(usage.stored_bytes)} / {fmtMB(usage.limits.max_total_bytes)} MB · อัปโหลดเดือนนี้{' '}
          {usage.class_a.toLocaleString()} / {usage.limits.max_class_a_per_month.toLocaleString()} · เปิดดูรูป{' '}
          {usage.class_b.toLocaleString()} / {usage.limits.max_class_b_per_month.toLocaleString()}
        </p>
      ) : null}

      <div className="row">
        <h2 className="grow">เมนู ({items.length})</h2>
        <button className="btn ghost" disabled={busy} onClick={() => void load()}>
          รีเฟรช
        </button>
        <button className="btn primary" disabled={busy || !shopId} onClick={() => setItemForm({ mode: 'add' })}>
          เพิ่มเมนู
        </button>
      </div>

      {itemForm ? (
        <ItemForm
          key={editItemId ?? 'new'}
          title={editItemId !== null ? `แก้ไขเมนู: ${editingItem?.name ?? ''}` : 'เพิ่มเมนู'}
          initial={itemDraft(editingItem)}
          item={editingItem}
          categories={categories}
          busy={busy}
          onSave={saveItem}
          onCancel={() => setItemForm(null)}
          onImageChanged={itemImageChanged}
        />
      ) : null}

      {categories.length === 0 ? <p className="muted">ยังไม่มีเมนู — กด "เพิ่มเมนู" เพื่อเริ่ม</p> : null}
      {categories.map((cat) => (
        <div key={cat}>
          <h3 className="menu-cat">{cat}</h3>
          <div className="list">
            {items
              .filter((i) => i.category === cat)
              .map((it) => (
                <div className={`item ${it.status === 'active' ? 'ok-item' : ''}`} key={it.id}>
                  <div className="row">
                    {it.image_key ? (
                      <img
                        src={mediaUrl(it.image_key)}
                        alt=""
                        width={40}
                        height={40}
                        loading="lazy"
                        style={{ objectFit: 'cover', borderRadius: 6, flex: 'none' }}
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                    ) : null}
                    <strong className="grow">{it.name}</strong>
                    <span className="badge">{typeLabel(it.menu_type)}</span>
                    {it.sold_out ? <span className="badge pending">ของหมด</span> : null}
                    {it.status === 'inactive' ? <span className="badge revoked">ปิดขาย</span> : null}
                  </div>
                  <p className="muted small">{priceLine(it)}</p>
                  <div className="row">
                    <button className="btn" disabled={busy} onClick={() => setItemForm({ mode: 'edit', id: it.id })}>
                      แก้ไข
                    </button>
                    <button className="btn" disabled={busy} onClick={() => void toggleItemSoldOut(it)}>
                      {it.sold_out ? 'มีของ' : 'ของหมด'}
                    </button>
                    <button className="btn" disabled={busy} onClick={() => void toggleItemStatus(it)}>
                      {it.status === 'active' ? 'ปิดขาย' : 'เปิดขาย'}
                    </button>
                    <button className="btn ghost" disabled={busy} onClick={() => toggleExpanded(it.id)}>
                      {expanded.has(it.id) ? 'ซ่อนตัวเลือก' : 'ตัวเลือก'}
                    </button>
                  </div>
                  {expanded.has(it.id) ? (
                    <div className="subblock">
                      {groupsOfItem(it.id).map((g) => renderGroup(g))}
                      {groupsOfItem(it.id).length === 0 ? <p className="muted small">ยังไม่มีกลุ่มตัวเลือกของเมนูนี้</p> : null}
                      {groupForm?.mode === 'add' && groupForm.itemId === it.id ? (
                        <GroupForm
                          title="เพิ่มกลุ่มตัวเลือก (เฉพาะเมนูนี้)"
                          initial={groupDraft()}
                          showTier={it.menu_type === 'rice_curry'}
                          busy={busy}
                          onSave={saveGroup}
                          onCancel={() => setGroupForm(null)}
                        />
                      ) : (
                        <button className="btn ghost" disabled={busy} onClick={() => setGroupForm({ mode: 'add', itemId: it.id })}>
                          เพิ่มกลุ่มตัวเลือก
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
          </div>
        </div>
      ))}

      <section className="card">
        <h2>ตัวเลือกใช้ได้ทุกเมนู</h2>
        <p className="muted small">กลุ่มตัวเลือกระดับร้าน เช่น ข้าวเพิ่ม ไข่ดาว — ใช้ได้กับทุกเมนู</p>
        {shopGroups.map((g) => renderGroup(g))}
        {shopGroups.length === 0 ? <p className="muted small">ยังไม่มีกลุ่มระดับร้าน</p> : null}
        {groupForm?.mode === 'add' && groupForm.itemId === null ? (
          <GroupForm
            title="เพิ่มกลุ่มตัวเลือก (ทุกเมนู)"
            initial={groupDraft()}
            showTier={false}
            busy={busy}
            onSave={saveGroup}
            onCancel={() => setGroupForm(null)}
          />
        ) : (
          <button className="btn" disabled={busy || !shopId} onClick={() => setGroupForm({ mode: 'add', itemId: null })}>
            เพิ่มกลุ่มตัวเลือก
          </button>
        )}
      </section>

      <section className="card">
        <h2>ค่าส่วนต่างเดลิเวอรี่</h2>
        <p className="muted small">ใช้กับเมนูตามสั่งที่ไม่ได้ตั้งราคาแอปเอง — ราคาในแอป = ราคาหน้าร้าน + ค่าส่วนต่าง</p>
        {CHANNELS.map((ch) => {
          const f = markupForm[ch.id]
          return (
            <div className="row markup-row" key={ch.id}>
              <span className="grow">
                <strong>{ch.label}</strong>
              </span>
              <select
                value={f.kind}
                disabled={busy}
                onChange={(e) => setMarkupField(ch.id, { kind: e.target.value as MarkupKind })}
              >
                <option value="none">ไม่บวก</option>
                <option value="percent">%</option>
                <option value="baht">บาทต่อจาน</option>
              </select>
              <input
                value={f.value}
                disabled={busy || f.kind === 'none'}
                inputMode="decimal"
                placeholder={f.kind === 'percent' ? 'เช่น 10' : 'เช่น 5'}
                onChange={(e) => setMarkupField(ch.id, { value: e.target.value })}
              />
            </div>
          )
        })}
        <div className="row">
          <button className="btn primary" disabled={busy || !shopId} onClick={() => void saveMarkup()}>
            บันทึกค่าส่วนต่าง
          </button>
        </div>
      </section>
    </section>
  )
}

// ---- forms (plain function components, local validation, parent sends the request) ----

function ItemForm({
  title,
  initial,
  item,
  categories,
  busy,
  onSave,
  onCancel,
  onImageChanged,
}: {
  title: string
  initial: ItemDraft
  /** Only for an item that already exists — images need a saved id. */
  item: MenuItem | undefined
  categories: string[]
  busy: boolean
  onSave: (v: ItemValues) => Promise<void>
  onCancel: () => void
  onImageChanged: (updated: MenuItem) => void
}) {
  const [d, setD] = useState<ItemDraft>(initial)
  const [err, setErr] = useState('')
  const [imgBusy, setImgBusy] = useState(false)
  const [imgErr, setImgErr] = useState('')

  async function pickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow picking the same file again
    if (!file || !item) return
    setImgBusy(true)
    setImgErr('')
    try {
      const blob = await prepareMenuImage(file)
      onImageChanged(await uploadMenuImage(item.id, blob))
    } catch (ex) {
      setImgErr(imageErrorText(ex))
    } finally {
      setImgBusy(false)
    }
  }

  async function removeImage() {
    if (!item) return
    setImgBusy(true)
    setImgErr('')
    try {
      onImageChanged(await deleteMenuImage(item.id))
    } catch (ex) {
      setImgErr(imageErrorText(ex))
    } finally {
      setImgBusy(false)
    }
  }

  function set<K extends keyof ItemDraft>(k: K, v: ItemDraft[K]) {
    setD((prev) => ({ ...prev, [k]: v }))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const name = d.name.trim()
    const category = d.category.trim()
    if (!name) {
      setErr('กรอกชื่อเมนู')
      return
    }
    if (!category) {
      setErr('กรอกหมวด เช่น ราดแกง / ตามสั่ง / เครื่องดื่ม')
      return
    }
    const base = bahtToSatang(d.base)
    if (base === null || base === 'invalid') {
      setErr('กรอกราคา (บาท) ให้ถูกต้อง')
      return
    }
    let p2: number | null = null
    let p3: number | null = null
    if (d.menu_type === 'rice_curry') {
      const v2 = bahtToSatang(d.price2)
      const v3 = bahtToSatang(d.price3)
      if (v2 === 'invalid' || v3 === 'invalid') {
        setErr('ราคา 2/3 อย่าง (บาท) ไม่ถูกต้อง')
        return
      }
      p2 = v2
      p3 = v3
      if (p2 !== null && p2 < base) {
        setErr('ราคา 2 อย่าง ต้องไม่ต่ำกว่าราคา 1 อย่าง')
        return
      }
      if (p3 !== null && p3 < (p2 ?? base)) {
        setErr('ราคา 3 อย่าง ต้องไม่ต่ำกว่าราคา 2 อย่าง')
        return
      }
    }
    let grab: number | null = null
    let lineman: number | null = null
    let foodpanda: number | null = null
    if (d.menu_type === 'made_to_order') {
      for (const ch of CHANNELS) {
        const v = bahtToSatang(d[ch.id])
        if (v === 'invalid') {
          setErr(`ราคา ${ch.label} (บาท) ไม่ถูกต้อง`)
          return
        }
        if (ch.id === 'grab') grab = v
        else if (ch.id === 'lineman') lineman = v
        else foodpanda = v
      }
    }
    const cost = bahtToSatang(d.cost)
    if (cost === 'invalid') {
      setErr('ต้นทุน/จาน (บาท) ไม่ถูกต้อง')
      return
    }
    const so = d.sortOrder.trim() === '' ? 0 : Number(d.sortOrder.trim())
    if (!Number.isInteger(so)) {
      setErr('ลำดับการแสดงต้องเป็นตัวเลข')
      return
    }
    setErr('')
    await onSave({
      name,
      category,
      menu_type: d.menu_type,
      base_price: base,
      price_2: p2,
      price_3: p3,
      grab_price: grab,
      lineman_price: lineman,
      foodpanda_price: foodpanda,
      cost,
      sort_order: so,
    })
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{title}</h2>
      {err ? <p className="error small">{err}</p> : null}
      <label>
        ชื่อเมนู
        <input value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="เช่น ข้าวราดแกง 1 อย่าง" />
      </label>
      <label>
        หมวด
        <input
          list="menu-category-list"
          value={d.category}
          onChange={(e) => set('category', e.target.value)}
          placeholder="เช่น ราดแกง"
        />
        <datalist id="menu-category-list">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>
      <div className="row">
        <span className="muted small">ประเภท:</span>
        <label className="check">
          <input
            type="radio"
            name="menu-type"
            checked={d.menu_type === 'rice_curry'}
            onChange={() => set('menu_type', 'rice_curry')}
          />
          ข้าวราดแกง
        </label>
        <label className="check">
          <input
            type="radio"
            name="menu-type"
            checked={d.menu_type === 'made_to_order'}
            onChange={() => set('menu_type', 'made_to_order')}
          />
          ตามสั่ง
        </label>
      </div>
      <label>
        {d.menu_type === 'rice_curry' ? 'ราคา 1 อย่าง (บาท)' : 'ราคา (บาท)'}
        <input value={d.base} onChange={(e) => set('base', e.target.value)} inputMode="decimal" placeholder="เช่น 40" />
      </label>
      {d.menu_type === 'rice_curry' ? (
        <div className="row">
          <label className="grow">
            ราคา 2 อย่าง (บาท)
            <input value={d.price2} onChange={(e) => set('price2', e.target.value)} inputMode="decimal" placeholder="เช่น 50" />
          </label>
          <label className="grow">
            ราคา 3 อย่าง (บาท)
            <input value={d.price3} onChange={(e) => set('price3', e.target.value)} inputMode="decimal" placeholder="เช่น 60" />
          </label>
        </div>
      ) : (
        <div className="row">
          {CHANNELS.map((ch) => (
            <label className="grow" key={ch.id}>
              {ch.label} (บาท)
              <input
                value={d[ch.id]}
                onChange={(e) => set(ch.id, e.target.value)}
                inputMode="decimal"
                placeholder="ใช้ค่าส่วนต่างร้าน"
              />
            </label>
          ))}
        </div>
      )}
      <label>
        ต้นทุน/จาน (บาท, ไม่บอกก็ได้)
        <input value={d.cost} onChange={(e) => set('cost', e.target.value)} inputMode="decimal" placeholder="เช่น 25" />
      </label>
      <label>
        ลำดับการแสดง (ตัวเลขเล็กอยู่หน้า)
        <input
          value={d.sortOrder}
          onChange={(e) => set('sortOrder', e.target.value.replace(/[^\d]/g, ''))}
          inputMode="numeric"
          placeholder="เช่น 0"
        />
      </label>
      {item ? (
        <>
          <div className="row">
            {item.image_key ? (
              <img
                src={mediaUrl(item.image_key)}
                alt={`รูป ${item.name}`}
                width={64}
                height={64}
                style={{ objectFit: 'cover', borderRadius: 8, flex: 'none' }}
              />
            ) : (
              <div
                aria-hidden="true"
                style={{ width: 64, height: 64, borderRadius: 8, background: '#e5e5e5', flex: 'none' }}
              />
            )}
            <label className="grow">
              รูปเมนู (ถ้ามี)
              <input type="file" accept="image/*" disabled={busy || imgBusy} onChange={pickImage} />
            </label>
            {imgBusy ? <span className="muted small">กำลังอัปโหลด…</span> : null}
            {item.image_key ? (
              <button className="btn danger" type="button" disabled={busy || imgBusy} onClick={() => void removeImage()}>
                ลบรูป
              </button>
            ) : null}
          </div>
          {imgErr ? <p className="error small">{imgErr}</p> : null}
        </>
      ) : null}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy}>
          บันทึก
        </button>
        <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>
          ยกเลิก
        </button>
      </div>
    </form>
  )
}

function GroupForm({
  title,
  initial,
  showTier,
  busy,
  onSave,
  onCancel,
}: {
  title: string
  initial: GroupDraft
  showTier: boolean
  busy: boolean
  onSave: (v: GroupValues) => Promise<void>
  onCancel: () => void
}) {
  const [d, setD] = useState<GroupDraft>(initial)
  const [err, setErr] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    const name = d.name.trim()
    if (!name) {
      setErr('กรอกชื่อกลุ่ม เช่น เลือกแกง 1 อย่าง')
      return
    }
    let max: number | null = null
    const t = d.maxSelect.trim()
    if (t !== '') {
      const n = Number(t)
      if (!Number.isInteger(n) || n < 1 || n > 3) {
        setErr('จำนวนที่เลือกได้สูงสุด ต้องเป็น 1-3 (ว่าง = ไม่จำกัด)')
        return
      }
      max = n
    }
    setErr('')
    await onSave({ name, required: d.required, max_select: max, tier_pricing: d.tierPricing })
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{title}</h2>
      {err ? <p className="error small">{err}</p> : null}
      <label>
        ชื่อกลุ่ม
        <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="เช่น เลือกแกง / ข้าวเพิ่ม" />
      </label>
      <label className="check">
        <input type="checkbox" checked={d.required} onChange={(e) => setD({ ...d, required: e.target.checked })} />
        ต้องเลือกอย่างน้อย 1 อย่าง
      </label>
      <label>
        เลือกได้สูงสุด (ว่าง = ไม่จำกัด)
        <input
          value={d.maxSelect}
          onChange={(e) => setD({ ...d, maxSelect: e.target.value.replace(/[^\d]/g, '') })}
          inputMode="numeric"
          placeholder="เช่น 1"
        />
      </label>
      {showTier ? (
        <label className="check">
          <input type="checkbox" checked={d.tierPricing} onChange={(e) => setD({ ...d, tierPricing: e.target.checked })} />
          นับจำนวนแกงเพื่อคิดราคา
        </label>
      ) : null}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy}>
          บันทึก
        </button>
        <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>
          ยกเลิก
        </button>
      </div>
    </form>
  )
}

function OptionForm({
  title,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  title: string
  initial: OptionDraft
  busy: boolean
  onSave: (v: OptionValues) => Promise<void>
  onCancel: () => void
}) {
  const [d, setD] = useState<OptionDraft>(initial)
  const [err, setErr] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    const name = d.name.trim()
    if (!name) {
      setErr('กรอกชื่อตัวเลือก')
      return
    }
    const p = bahtToSatang(d.priceAdd)
    if (p === 'invalid') {
      setErr('ราคาเพิ่ม (บาท) ไม่ถูกต้อง')
      return
    }
    setErr('')
    await onSave({ name, price_add: p ?? 0 })
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{title}</h2>
      {err ? <p className="error small">{err}</p> : null}
      <label>
        ชื่อตัวเลือก
        <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="เช่น แกงเขียวหวาน" />
      </label>
      <label>
        ราคาเพิ่ม (บาท, 0 = ไม่เพิ่ม)
        <input
          value={d.priceAdd}
          onChange={(e) => setD({ ...d, priceAdd: e.target.value })}
          inputMode="decimal"
          placeholder="เช่น 0 หรือ 10"
        />
      </label>
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy}>
          บันทึก
        </button>
        <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>
          ยกเลิก
        </button>
      </div>
    </form>
  )
}
