// OWNER menu editor (M1-6b) — "ประเภท / หัวข้อ / ตัวเลือก" model.
//
// A "ประเภท" (type) = one menu_items row (e.g. ก๋วยเตี๋ยว, base price 40).
// Its "หัวข้อ" (lists) = option_groups with menu_item_id = that item
// (เส้น, น้ำซุป, พิเศษ, เพิ่ม). "ตัวเลือก" (choices) = options in a group.
// Staff pick a type then tick choices; price = base + sum(price_add).
//
// Everything autosaves on blur / on tap (no save button); the local state is
// patched from each API response instead of reloading the whole menu.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties } from 'react'
import { api, deleteMenuImage, errorCode, friendlyError, mediaUrl, uploadMenuImage } from '../api'
import type { ChannelMarkup, Markup, MenuData, MenuItem, MenuOption, OptionGroup } from '../api'
import { prepareMenuImage } from '../imageResize'
import { useOwnerShop } from './shopContext'

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

/** '' -> null (not set); anything unparsable -> 'invalid'. */
function bahtToSatang(s: string): number | null | 'invalid' {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return 'invalid'
  const v = Math.round(n * 100)
  return Number.isSafeInteger(v) ? v : 'invalid'
}

/** Thai message for image upload failures (client resize + server quota). */
function imageErrorText(e: unknown): string {
  const code = errorCode(e)
  if (code === 'media_quota') return 'เกินโควต้ารูปภาพของเดือนนี้'
  if (code === 'image_too_large') return 'รูปใหญ่เกินไป'
  if (e instanceof Error && e.message === 'รูปใหญ่เกินไป') return e.message
  return friendlyError(e)
}

// ---- list pick mode: one cycle button instead of two checkboxes ----
// one = required + max 1 · opt = optional pick 1 · many = optional, unlimited.

type GroupMode = 'one' | 'opt' | 'many'

const MODE_LABEL: Record<GroupMode, string> = {
  one: 'ต้องเลือก 1',
  opt: 'เลือก 1 หรือไม่เลือก',
  many: 'ติ๊กใส่ได้ (ไม่ติ๊ก = ไม่ใส่)',
}

const NEXT_MODE: Record<GroupMode, GroupMode> = { one: 'opt', opt: 'many', many: 'one' }

function modeOf(g: OptionGroup): GroupMode {
  if (g.max_select === 1) return g.required ? 'one' : 'opt'
  return 'many'
}

function modeFields(m: GroupMode): { required: boolean; max_select: number | null } {
  if (m === 'one') return { required: true, max_select: 1 }
  if (m === 'opt') return { required: false, max_select: 1 }
  return { required: false, max_select: null }
}

// ---- delivery markup form state (same shape as the old MenuPanel) ----

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

// PUT /api/owner/menu-items/{id} replaces ALL mutable fields — build the full
// body from the current row and override only what this screen edits.
/** The หมวด (type) a menu is grouped under (owner side only). A menu that was never
 *  given one is its own หมวด: the menu's name stands in for it. */
function catOf(it: MenuItem): string {
  const c = it.category.trim()
  return c === '' ? it.name.trim() : c
}

/** The หมวด the owner actually chose; '' = none chosen (the name stands in). */
function chosenCat(it: MenuItem): string {
  const c = it.category.trim()
  return c === it.name.trim() ? '' : c
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

// ---- inline styles (kept local: this screen shares the app CSS untouched) ----

const CARD_TAP: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  alignItems: 'stretch',
  textAlign: 'left',
  background: 'transparent',
  border: 0,
  padding: 0,
  minHeight: 44,
  fontWeight: 400,
}

const NAME_INPUT: CSSProperties = { width: 'auto', flex: '1 1 0', minWidth: 0 }
const PRICE_INPUT: CSSProperties = { width: 72, flex: '0 0 72px', minWidth: 0, textAlign: 'right' }
const MODE_BTN: CSSProperties = { flex: 'none', fontSize: '0.85rem', padding: '4px 10px', minHeight: 44 }
const X_BTN: CSSProperties = { flex: 'none', minWidth: 44, padding: '4px 10px', minHeight: 44 }

export default function MenuEditor() {
  const { shopId } = useOwnerShop()
  const [data, setData] = useState<MenuData | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<{ text: string; bad: boolean } | null>(null)
  const [focusOptId, setFocusOptId] = useState<string | null>(null)
  const [markupForm, setMarkupForm] = useState<MarkupFormState>(() => markupFormFrom(null))
  const [markupMsg, setMarkupMsg] = useState<{ text: string; bad: boolean } | null>(null)
  const [imgBusy, setImgBusy] = useState(false)
  const [imgErr, setImgErr] = useState('')
  // "template" copy sheet (open only while one item is being edited)
  const [tplOpen, setTplOpen] = useState(false)
  const saveTimer = useRef<number | null>(null)

  const load = useCallback(async () => {
    if (!shopId) {
      setData(null)
      return
    }
    setBusy(true)
    try {
      setData(await api<MenuData>('GET', `/api/owner/shops/${encodeURIComponent(shopId)}/menu`))
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

  // switching shops leaves the editor open on nothing
  useEffect(() => {
    setEditId(null)
  }, [shopId])

  // the template sheet belongs to ONE item: leaving the editor or switching
  // items/shops must close it, or it would pop open on the next item
  useEffect(() => {
    setTplOpen(false)
  }, [editId, shopId])

  // markup card follows the freshly loaded data (also re-syncs after save)
  useEffect(() => {
    setMarkupForm(markupFormFrom(data))
  }, [data])

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    },
    [],
  )

  /** Tiny autosave feedback line ("บันทึกแล้ว" / error) in the editor header. */
  function flash(text: string, bad = false) {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    setSaveState({ text, bad })
    saveTimer.current = window.setTimeout(() => setSaveState(null), bad ? 4000 : 1500)
  }

  // ---- local state patching (one row per response, no full reload) ----

  function upsertItem(it: MenuItem) {
    setData((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.some((x) => x.id === it.id) ? prev.items.map((x) => (x.id === it.id ? it : x)) : [...prev.items, it],
          }
        : prev,
    )
  }

  function upsertGroup(g: OptionGroup) {
    setData((prev) =>
      prev
        ? {
            ...prev,
            option_groups: prev.option_groups.some((x) => x.id === g.id)
              ? prev.option_groups.map((x) => (x.id === g.id ? g : x))
              : [...prev.option_groups, g],
          }
        : prev,
    )
  }

  function upsertOption(o: MenuOption) {
    setData((prev) =>
      prev
        ? {
            ...prev,
            options: prev.options.some((x) => x.id === o.id) ? prev.options.map((x) => (x.id === o.id ? o : x)) : [...prev.options, o],
          }
        : prev,
    )
  }

  function dropGroup(id: string) {
    setData((prev) =>
      prev
        ? {
            ...prev,
            option_groups: prev.option_groups.filter((g) => g.id !== id),
            options: prev.options.filter((o) => o.option_group_id !== id),
          }
        : prev,
    )
  }

  function dropOption(id: string) {
    setData((prev) => (prev ? { ...prev, options: prev.options.filter((o) => o.id !== id) } : prev))
  }

  // ---- mutations (each returns success so the input can keep or revert) ----

  async function saveItemFields(it: MenuItem, over: Record<string, unknown>): Promise<boolean> {
    try {
      upsertItem(await api<MenuItem>('PUT', `/api/owner/menu-items/${encodeURIComponent(it.id)}`, itemPutBody(it, over)))
      flash('บันทึกแล้ว')
      return true
    } catch (e) {
      flash(friendlyError(e), true)
      return false
    }
  }

  async function saveGroupFields(
    g: OptionGroup,
    patch: { name?: string; required?: boolean; max_select?: number | null },
  ): Promise<boolean> {
    try {
      upsertGroup(
        await api<OptionGroup>('PUT', `/api/owner/option-groups/${encodeURIComponent(g.id)}`, {
          name: patch.name ?? g.name,
          required: patch.required ?? g.required,
          max_select: patch.max_select === undefined ? g.max_select : patch.max_select,
          tier_pricing: g.tier_pricing,
          sort_order: g.sort_order,
        }),
      )
      flash('บันทึกแล้ว')
      return true
    } catch (e) {
      flash(friendlyError(e), true)
      return false
    }
  }

  async function saveOptionFields(o: MenuOption, patch: { name?: string; price_add?: number }): Promise<boolean> {
    try {
      upsertOption(
        await api<MenuOption>('PUT', `/api/owner/options/${encodeURIComponent(o.id)}`, {
          name: patch.name ?? o.name,
          price_add: patch.price_add ?? o.price_add,
          sort_order: o.sort_order,
          sold_out: o.sold_out,
        }),
      )
      flash('บันทึกแล้ว')
      return true
    } catch (e) {
      flash(friendlyError(e), true)
      return false
    }
  }

  /** เปิดขาย/ปิดขาย switch on a type card (errors go to the panel message). */
  async function toggleStatus(it: MenuItem) {
    const status = it.status === 'active' ? 'inactive' : 'active'
    try {
      upsertItem(await api<MenuItem>('PUT', `/api/owner/menu-items/${encodeURIComponent(it.id)}`, itemPutBody(it, { status })))
    } catch (e) {
      setMsg(friendlyError(e))
    }
  }

  // "+ เพิ่มประเภท": item ประเภทใหม่ (base 0) + one pick-one list "เมนู".
  async function addType() {
    if (!shopId) return
    const name = 'ประเภทใหม่'
    const itemId = crypto.randomUUID()
    try {
      const item = await api<MenuItem>('POST', '/api/owner/menu-items', {
        id: itemId,
        shop_id: shopId,
        name,
        category: name,
        menu_type: 'made_to_order',
        base_price: 0,
        price_2: null,
        price_3: null,
        grab_price: null,
        lineman_price: null,
        foodpanda_price: null,
        cost: null,
        sort_order: null,
      })
      upsertItem(item)
      upsertGroup(
        await api<OptionGroup>('POST', '/api/owner/option-groups', {
          id: crypto.randomUUID(),
          shop_id: shopId,
          menu_item_id: itemId,
          name: 'เมนู',
          required: true,
          max_select: 1,
          tier_pricing: false,
          sort_order: null,
        }),
      )
      setEditId(itemId)
    } catch (e) {
      setMsg(friendlyError(e))
    }
  }

  // "+ เพิ่มหัวข้อ": pick-one group หัวข้อใหม่ with one seeded choice.
  // "+ เพิ่มของเสริม": a tick list (optional, many) - unticked = not added.
  async function addList(it: MenuItem, mode: GroupMode = 'one') {
    if (!shopId) return
    try {
      const g = await api<OptionGroup>('POST', '/api/owner/option-groups', {
        id: crypto.randomUUID(),
        shop_id: shopId,
        menu_item_id: it.id,
        name: mode === 'many' ? 'ของเพิ่ม' : 'หัวข้อใหม่',
        ...modeFields(mode),
        tier_pricing: false,
        sort_order: null,
      })
      upsertGroup(g)
      const o = await api<MenuOption>('POST', '/api/owner/options', {
        id: crypto.randomUUID(),
        option_group_id: g.id,
        name: 'ตัวเลือกใหม่',
        price_add: 0,
        sort_order: null,
      })
      upsertOption(o)
      setFocusOptId(o.id)
      flash('บันทึกแล้ว')
    } catch (e) {
      flash(friendlyError(e), true)
    }
  }

  // The API rejects empty names, so new choices are seeded as "ตัวเลือกใหม่"
  // and the input is focused + selected for immediate renaming.
  async function addOption(g: OptionGroup) {
    try {
      const o = await api<MenuOption>('POST', '/api/owner/options', {
        id: crypto.randomUUID(),
        option_group_id: g.id,
        name: 'ตัวเลือกใหม่',
        price_add: 0,
        sort_order: null,
      })
      upsertOption(o)
      setFocusOptId(o.id)
      flash('บันทึกแล้ว')
    } catch (e) {
      flash(friendlyError(e), true)
    }
  }

  /** Template copy landed: close the sheet, flash, and (แก้ไข) focus + select
   *  the first copied option so the owner can rename it right away. */
  function templateApplied(focusFirst: string | null) {
    setTplOpen(false)
    if (focusFirst !== null) setFocusOptId(focusFirst)
    flash('คัดลอกหัวข้อแล้ว')
  }

  // Never-sold types are deleted for real; ones on old bills are hidden
  // (server decides, `archived` says which). Either way they leave both apps.
  async function deleteType(it: MenuItem) {
    if (!window.confirm(`ลบประเภท "${it.name}"? หัวข้อและตัวเลือกทั้งหมดจะหายไปจากหน้าขาย`)) return
    try {
      const r = await api<{ archived: boolean }>('DELETE', `/api/owner/menu-items/${encodeURIComponent(it.id)}`)
      setData((prev) => (prev ? { ...prev, items: prev.items.filter((x) => x.id !== it.id) } : prev))
      setEditId(null)
      flash(r.archived ? 'ลบแล้ว (บิลเก่ายังเก็บไว้)' : 'ลบแล้ว')
    } catch (e) {
      flash(friendlyError(e), true)
    }
  }

  async function deleteList(g: OptionGroup) {
    if (!window.confirm(`ลบหัวข้อ "${g.name}"? ตัวเลือกทั้งหมดในหัวข้อนี้จะถูกลบด้วย`)) return
    try {
      await api('DELETE', `/api/owner/option-groups/${encodeURIComponent(g.id)}`)
      dropGroup(g.id)
      flash('ลบแล้ว')
    } catch (e) {
      flash(friendlyError(e), true)
    }
  }

  async function deleteOption(o: MenuOption) {
    if (!window.confirm(`ลบตัวเลือก "${o.name}"?`)) return
    try {
      await api('DELETE', `/api/owner/options/${encodeURIComponent(o.id)}`)
      dropOption(o.id)
      flash('ลบแล้ว')
    } catch (e) {
      flash(friendlyError(e), true)
    }
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
        setMarkupMsg({ text: `ค่าส่วนต่างของ ${ch.label} ไม่ถูกต้อง`, bad: true })
        return
      }
      if (f.kind === 'percent') {
        if (!Number.isInteger(n) || n > 300) {
          setMarkupMsg({ text: `เปอร์เซ็นต์ของ ${ch.label} ต้องเป็นตัวเลข 0-300`, bad: true })
          return
        }
        body[ch.id] = { kind: 'percent', value: n }
      } else {
        body[ch.id] = { kind: 'baht', value: Math.round(n * 100) }
      }
    }
    try {
      const saved = await api<ChannelMarkup>('PUT', `/api/owner/shops/${encodeURIComponent(shopId)}/channel-markup`, body)
      setData((prev) => (prev ? { ...prev, channel_markup: saved } : prev))
      setMarkupMsg({ text: 'บันทึกค่าส่วนต่างแล้ว', bad: false })
    } catch (e) {
      setMarkupMsg({ text: friendlyError(e), bad: true })
    }
  }

  // ---- menu image row (client resizes, server stores) ----

  async function pickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow picking the same file again
    if (!file || !editItem) return
    setImgBusy(true)
    setImgErr('')
    try {
      upsertItem(await uploadMenuImage(editItem.id, await prepareMenuImage(file)))
      flash('บันทึกรูปแล้ว')
    } catch (ex) {
      setImgErr(imageErrorText(ex))
    } finally {
      setImgBusy(false)
    }
  }

  async function removeImage() {
    if (!editItem) return
    setImgBusy(true)
    setImgErr('')
    try {
      upsertItem(await deleteMenuImage(editItem.id))
      flash('ลบรูปแล้ว')
    } catch (ex) {
      setImgErr(imageErrorText(ex))
    } finally {
      setImgBusy(false)
    }
  }

  // ---- derived rows (server order kept: sort_order, created_at, id) ----

  const items = data ? data.items : []
  /** หมวด the owner chose, in menu order (the datalists suggest these) */
  const categories = Array.from(new Set(items.map(chosenCat).filter((c) => c !== '')))
  /** the list view: one block per หมวด (a menu with none is grouped under its own name) */
  const catGroups: { label: string; items: MenuItem[] }[] = Array.from(new Set(items.map(catOf))).map((c) => ({
    label: c,
    items: items.filter((i) => catOf(i) === c),
  }))
  /** Lists of one item: attached to it, not shop-wide, not tier-pricing. */
  const listsOf = (itemId: string) =>
    data ? data.option_groups.filter((g) => g.menu_item_id === itemId && !g.tier_pricing) : []
  /** Old shop-wide lists (menu_item_id null): they show on EVERY type at the counter. */
  const sharedLists = data ? data.option_groups.filter((g) => g.menu_item_id === null && !g.tier_pricing) : []
  const optionsOf = (groupId: string) => (data ? data.options.filter((o) => o.option_group_id === groupId) : [])
  /** Template sources: OTHER items that already have option lists (tier-pricing
   *  groups never count — they are rice_curry-specific and never copied). */
  const templateSources = data
    ? data.items.filter(
        (x) => x.id !== editId && data.option_groups.some((g) => g.menu_item_id === x.id && !g.tier_pricing),
      )
    : []

  const editItem = editId !== null ? items.find((i) => i.id === editId) : undefined

  function baseLabel(it: MenuItem): string {
    return it.base_price > 0 ? `เริ่ม ฿${fmtBaht(it.base_price)}` : 'ราคาตามตัวเลือก'
  }

  function listsSummary(it: MenuItem): string {
    const parts = listsOf(it.id).map((g) => `${g.name} (${optionsOf(g.id).length})`)
    return parts.length > 0 ? parts.join(' · ') : 'ยังไม่มีหัวข้อ'
  }

  // ================= TYPE EDITOR =================

  if (editItem) {
    const it = editItem
    const lists = listsOf(it.id)
    return (
      <section>
        <div className="row">
          <button className="btn ghost" style={{ flex: 'none', minWidth: 44 }} onClick={() => setEditId(null)}>
            ← กลับ
          </button>
          <span className="muted small grow">แก้แล้วบันทึกเองอัตโนมัติ — ไม่ต้องกดบันทึก</span>
          {saveState ? (
            <span className={`${saveState.bad ? 'error' : 'muted'} small`} role="status">
              {saveState.text}
            </span>
          ) : null}
        </div>

        <label>
          หมวด (type — พิมพ์เอง ไม่เลือก = ใช้ชื่อเมนูเป็นหมวด)
          <AutoText
            value={chosenCat(it)}
            list="menu-categories"
            placeholder="ไม่เลือก = ใช้ชื่อเมนูเป็นหมวด"
            ariaLabel="หมวด"
            onCommit={(v) => saveItemFields(it, { category: v.trim() === '' ? it.name : v.trim() })}
            allowEmpty
          />
          <datalist id="menu-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>

        <div className="row">
          <label className="grow">
            ชื่อเมนู
            <AutoText
              value={it.name}
              placeholder="เช่น ก๋วยเตี๋ยว"
              onCommit={(v) => saveItemFields(it, chosenCat(it) === '' ? { name: v, category: v } : { name: v })}
              onEmpty={() => flash('กรอกชื่อเมนูก่อน', true)}
            />
          </label>
          <label style={{ flex: '0 0 130px' }}>
            ราคาตั้งต้น ฿
            <AutoBaht
              satang={it.base_price}
              ariaLabel="ราคาตั้งต้น (บาท)"
              onCommit={(s) => saveItemFields(it, { base_price: s })}
              onInvalid={() => flash('ราคาไม่ถูกต้อง', true)}
            />
          </label>
        </div>

        {it.menu_type === 'rice_curry' ? (
          <p className="muted small">เมนูแบบเก่า (ข้าวราดแกงตามจำนวนอย่าง)</p>
        ) : null}

        <div className="row">
          {it.image_key ? (
            <img
              src={mediaUrl(it.image_key)}
              alt={`รูป ${it.name}`}
              width={64}
              height={64}
              style={{ objectFit: 'cover', borderRadius: 8, flex: 'none' }}
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          ) : (
            <div aria-hidden="true" style={{ width: 64, height: 64, borderRadius: 8, background: 'var(--surface-2)', flex: 'none' }} />
          )}
          <label className="grow">
            รูปเมนู (ถ้ามี)
            <input type="file" accept="image/*" disabled={imgBusy} onChange={pickImage} />
          </label>
          {imgBusy ? <span className="muted small">กำลังอัปโหลด…</span> : null}
          {it.image_key ? (
            <button className="btn danger" disabled={imgBusy} onClick={() => void removeImage()}>
              ลบรูป
            </button>
          ) : null}
        </div>
        {imgErr ? <p className="error small">{imgErr}</p> : null}

        {lists.map((g) => {
          const opts = optionsOf(g.id)
          const mode = modeOf(g)
          return (
            <div className="group-block" key={g.id}>
              <div className="row">
                <AutoText
                  value={g.name}
                  ariaLabel="ชื่อหัวข้อ"
                  style={NAME_INPUT}
                  onCommit={(v) => saveGroupFields(g, { name: v })}
                  onEmpty={() => flash('กรอกชื่อหัวข้อก่อน', true)}
                />
                <button
                  className="btn ghost"
                  style={MODE_BTN}
                  title="แตะเพื่อเปลี่ยนโหมด"
                  onClick={() => void saveGroupFields(g, modeFields(NEXT_MODE[mode]))}
                >
                  {MODE_LABEL[mode]}
                </button>
                <button className="btn danger" style={X_BTN} aria-label={`ลบหัวข้อ ${g.name}`} onClick={() => void deleteList(g)}>
                  ✕
                </button>
              </div>
              <div className="row" style={{ gap: 10, padding: '0 2px' }}>
                <span className="muted" style={{ flex: '1 1 140px', minWidth: 0, fontSize: '0.75rem' }}>
                  ตัวเลือก
                </span>
                <span className="muted" style={{ flex: '0 0 84px', fontSize: '0.75rem' }}>
                  +ราคา ฿
                </span>
                <span style={{ flex: '0 0 44px' }} />
              </div>
              {opts.map((o) => (
                <div className="row" style={{ flexWrap: "nowrap" }} key={o.id}>
                  <AutoText
                    value={o.name}
                    ariaLabel="ชื่อตัวเลือก"
                    style={NAME_INPUT}
                    selectOnMount={focusOptId === o.id}
                    onCommit={(v) => saveOptionFields(o, { name: v })}
                    onEmpty={() => flash('กรอกชื่อตัวเลือกก่อน', true)}
                  />
                  <AutoBaht
                    satang={o.price_add}
                    ariaLabel="ราคาบวกเพิ่ม (บาท)"
                    style={PRICE_INPUT}
                    onCommit={(s) => saveOptionFields(o, { price_add: s })}
                    onInvalid={() => flash('ราคาไม่ถูกต้อง', true)}
                  />
                  <button
                    className="btn ghost"
                    style={{ ...X_BTN, color: 'var(--danger)' }}
                    aria-label={`ลบตัวเลือก ${o.name}`}
                    onClick={() => void deleteOption(o)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {opts.length === 0 ? <p className="muted small">ยังไม่มีตัวเลือกในหัวข้อนี้</p> : null}
              <button
                className="btn ghost"
                style={{ alignSelf: 'flex-start', minHeight: 44, border: '1.5px dashed var(--border)', color: 'var(--green-dark)' }}
                onClick={() => void addOption(g)}
              >
                + เพิ่มตัวเลือก
              </button>
            </div>
          )
        })}

        <button
          className="btn ghost"
          style={{ minHeight: 48, borderColor: 'var(--green)', color: 'var(--green-dark)' }}
          disabled={!shopId}
          onClick={() => void addList(it)}
        >
          + เพิ่มหัวข้อ (เช่น เส้น, น้ำซุป)
        </button>
        <button
          className="btn ghost"
          style={{ minHeight: 48, borderColor: 'var(--green)', color: 'var(--green-dark)' }}
          disabled={!shopId}
          onClick={() => void addList(it, 'many')}
        >
          + เพิ่มของเสริม (ติ๊ก = ใส่, ไม่ติ๊ก = ไม่ใส่)
        </button>
        {templateSources.length > 0 ? (
          <button
            className="btn ghost"
            style={{ minHeight: 48, border: '1.5px dashed var(--border)', color: 'var(--green-dark)' }}
            title="คัดลอกหัวข้อและตัวเลือกจากประเภทอื่น มาเป็นชุดใหม่ของประเภทนี้ (ต้นทางไม่เปลี่ยน)"
            disabled={!shopId}
            onClick={() => setTplOpen(true)}
          >
            template
          </button>
        ) : null}
        <button
          className="btn danger"
          style={{ minHeight: 48, marginTop: 16 }}
          disabled={busy}
          onClick={() => void deleteType(it)}
        >
          ลบประเภท "{it.name}"
        </button>

        {tplOpen && data && shopId ? (
          <TemplateSheet
            shopId={shopId}
            item={it}
            menu={data}
            sources={templateSources}
            onClose={() => setTplOpen(false)}
            onGroup={upsertGroup}
            onOption={upsertOption}
            onApplied={templateApplied}
          />
        ) : null}
      </section>
    )
  }

  // ================= TYPE LIST =================

  return (
    <section>
      {msg ? (
        <p className="error" role="alert">
          {msg}
        </p>
      ) : null}

      <div className="row">
        <h2 className="grow">เมนู (ประเภท) {items.length}</h2>
        <button className="btn ghost" disabled={busy || !shopId} onClick={() => void load()}>
          รีเฟรช
        </button>
      </div>
      <p className="muted small">ประเภท = ปุ่มใหญ่ที่พนักงานกดก่อน แล้วค่อยติ๊กตัวเลือกข้างใน</p>

      {shopId && !data && !msg ? <p className="muted">กำลังโหลดเมนู…</p> : null}

      {catGroups.map((g) => (
        <div key={g.label || '__none'}>
          {g.items.length === 1 && g.items[0].name.trim() === g.label ? null : (
            <h3 className="muted" style={{ margin: '12px 0 6px' }}>
              {g.label}
            </h3>
          )}
          <div className="list">
          {g.items.map((it) => (
            <div className={`item ${it.status === 'active' ? 'ok-item' : ''}`} key={it.id}>
              <button type="button" style={CARD_TAP} onClick={() => setEditId(it.id)} aria-label={`แก้ไขประเภท ${it.name}`}>
                <span style={{ display: 'flex', width: '100%', alignItems: 'baseline', gap: 8 }}>
                  <strong
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: '1.05rem',
                      textAlign: 'left',
                      color: it.status === 'active' ? undefined : 'var(--muted)',
                    }}
                  >
                    {it.name}
                  </strong>
                  <span className="muted small">{baseLabel(it)}</span>
                </span>
                <span className="muted small">{listsSummary(it)}</span>
              </button>
              <div className="row">
                <span className={`badge ${it.status === 'active' ? 'approved' : 'revoked'}`}>
                  {it.status === 'active' ? 'เปิดขาย' : 'ปิดขาย'}
                </span>
                <span className="grow" />
                <Switch
                  checked={it.status === 'active'}
                  label={`${it.status === 'active' ? 'ปิดขาย' : 'เปิดขาย'} ${it.name}`}
                  onChange={() => void toggleStatus(it)}
                />
              </div>
            </div>
          ))}
        </div>
  
        </div>
      ))}
      {data && items.length === 0 ? <p className="muted">ยังไม่มีประเภท — กด "+ เพิ่มประเภท" เพื่อเริ่ม</p> : null}

      <button className="btn primary" disabled={busy || !shopId} onClick={() => void addType()}>
        + เพิ่มประเภท
      </button>

      {sharedLists.length > 0 ? (
        <section className="card">
          <h2>ตัวเลือกแบบเก่า (ขึ้นกับทุกประเภท)</h2>
          <p className="muted small">
            หัวข้อเหล่านี้สร้างจากหน้าเมนูแบบเก่า และขึ้นในหน้าขายของทุกประเภท — ถ้าไม่ได้ตั้งใจ ให้ลบทิ้ง
          </p>
          {sharedLists.map((g) => (
            <div className="row" key={g.id} style={{ flexWrap: 'nowrap' }}>
              <span className="grow" style={{ minWidth: 0 }}>
                <strong>{g.name}</strong>
                <span className="muted small"> · {optionsOf(g.id).map((o) => o.name).join(', ') || 'ไม่มีตัวเลือก'}</span>
              </span>
              <button className="btn danger" style={{ flex: 'none', minHeight: 44 }} disabled={busy} onClick={() => void deleteList(g)}>
                ลบ
              </button>
            </div>
          ))}
        </section>
      ) : null}

      <section className="card">
        <h2>ค่าส่วนต่างเดลิเวอรี่</h2>
        <p className="muted small">บวกราคาเมื่อขายผ่านแอปเดลิเวอรี่ ใช้กับทุกประเภท — ราคาในแอป = ราคาหน้าร้าน + ค่าส่วนต่าง</p>
        {markupMsg ? (
          <p className={`${markupMsg.bad ? 'error' : 'muted'} small`} role="status">
            {markupMsg.text}
          </p>
        ) : null}
        {CHANNELS.map((ch) => {
          const f = markupForm[ch.id]
          return (
            <div className="row markup-row" key={ch.id}>
              <span className="grow">
                <strong>{ch.label}</strong>
              </span>
              <select value={f.kind} onChange={(e) => setMarkupField(ch.id, { kind: e.target.value as MarkupKind })}>
                <option value="none">ไม่บวก</option>
                <option value="percent">%</option>
                <option value="baht">บาทต่อจาน</option>
              </select>
              <input
                value={f.value}
                disabled={f.kind === 'none'}
                inputMode="decimal"
                placeholder={f.kind === 'percent' ? 'เช่น 10' : 'เช่น 5'}
                onChange={(e) => setMarkupField(ch.id, { value: e.target.value })}
              />
            </div>
          )
        })}
        <div className="row">
          <button className="btn primary" disabled={!shopId} onClick={() => void saveMarkup()}>
            บันทึกค่าส่วนต่าง
          </button>
        </div>
      </section>
    </section>
  )
}

// ---------------------------------------------------------------------------
// "template" sheet: copy another item's option groups (+ their options) onto
// the item being edited. It is a DEEP copy — every row is POSTed fresh with a
// new id and the CURRENT item's menu_item_id, so the source item is never
// shared, moved or modified. Tier-pricing groups are never offered.
// ---------------------------------------------------------------------------

function TemplateSheet({
  shopId,
  item,
  menu,
  sources,
  onClose,
  onGroup,
  onOption,
  onApplied,
}: {
  shopId: string
  /** the item being edited — every copied group lands on it */
  item: MenuItem
  menu: MenuData
  /** other items that already have option lists, in menu order */
  sources: MenuItem[]
  onClose: () => void
  /** patch helpers of the editor (upsertGroup / upsertOption) */
  onGroup: (g: OptionGroup) => void
  onOption: (o: MenuOption) => void
  /** apply finished: non-null = focus that option's name input ("แก้ไข") */
  onApplied: (focusFirst: string | null) => void
}) {
  // default source = the LAST candidate in menu order (≈ most recently created)
  const [srcId, setSrcId] = useState(() => (sources.length > 0 ? sources[sources.length - 1].id : ''))
  /** group ids whose checkbox is unticked (default: everything gets copied) */
  const [skip, setSkip] = useState<Record<string, boolean>>({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // Fresh row ids per source group, made ONCE per sheet open: a retry after a
  // network error replays the same ids, so the idempotent POSTs never
  // duplicate the groups that already made it (same trick as the stock move_id).
  const planIds = useRef(new Map<string, { group: string; options: string[] }>())

  const listsOfSrc = (id: string) => menu.option_groups.filter((g) => g.menu_item_id === id && !g.tier_pricing)
  const groups = listsOfSrc(srcId)
  const checked = groups.filter((g) => !skip[g.id])
  const optsOf = (groupId: string) => menu.options.filter((o) => o.option_group_id === groupId)

  // เพิ่ม = copy + close; แก้ไข = copy + close + focus the first copied option
  // so the groups stay open for normal inline editing.
  async function apply(thenEdit: boolean) {
    if (checked.length === 0) {
      setErr('ติ๊กหัวข้อที่จะคัดลอกอย่างน้อย 1 หัวข้อ')
      return
    }
    setBusy(true)
    setErr('')
    let firstOptId: string | null = null
    try {
      for (const src of checked) {
        const opts = optsOf(src.id)
        let ids = planIds.current.get(src.id)
        if (!ids) {
          ids = { group: crypto.randomUUID(), options: opts.map(() => crypto.randomUUID()) }
          planIds.current.set(src.id, ids)
        }
        // Same body shape as addList, but with the source's name/policy/order
        // and the CURRENT item's menu_item_id.
        const g = await api<OptionGroup>('POST', '/api/owner/option-groups', {
          id: ids.group,
          shop_id: shopId,
          menu_item_id: item.id,
          name: src.name,
          required: src.required,
          max_select: src.max_select,
          tier_pricing: false,
          sort_order: src.sort_order,
        })
        onGroup(g)
        for (let i = 0; i < opts.length; i++) {
          // Same body shape as addOption, with the source's name/price/order.
          const o = await api<MenuOption>('POST', '/api/owner/options', {
            id: ids.options[i],
            option_group_id: g.id,
            name: opts[i].name,
            price_add: opts[i].price_add,
            sort_order: opts[i].sort_order,
          })
          onOption(o)
          if (firstOptId === null) firstOptId = o.id
        }
      }
      onApplied(thenEdit ? firstOptId : null)
    } catch (e) {
      setErr(friendlyError(e)) // sheet stays open: applying again replays the same ids
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label="template — คัดลอกหัวข้อจากประเภทอื่น"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>template — คัดลอกหัวข้อจากประเภทอื่น</h2>
        <p className="muted small">
          เลือกประเภทที่มีหัวข้อครบแล้ว แล้วติ๊กหัวข้อที่จะคัดลอกมาเป็นชุดใหม่ของ "{item.name}" — ประเภทต้นทางไม่เปลี่ยนแปลง
        </p>
        {sources.length > 0 ? (
          <>
            <label>
              คัดลอกจากประเภท
              <select
                value={srcId}
                disabled={busy}
                onChange={(e) => {
                  setSrcId(e.target.value)
                  setSkip({}) // every group of the new source starts checked
                }}
              >
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({listsOfSrc(s.id).length} หัวข้อ)
                  </option>
                ))}
              </select>
            </label>
            {groups.map((g) => {
              const opts = optsOf(g.id)
              return (
                <div className="group-block" key={g.id}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={!skip[g.id]}
                      disabled={busy}
                      aria-label={`คัดลอกหัวข้อ ${g.name}`}
                      onChange={() => setSkip({ ...skip, [g.id]: !skip[g.id] })}
                    />
                    <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                      <strong>{g.name}</strong>
                      <span className="muted small" style={{ display: 'block' }}>
                        {MODE_LABEL[modeOf(g)]}
                      </span>
                    </span>
                    <span className="badge">{opts.length} ตัวเลือก</span>
                  </label>
                  {opts.map((o) => (
                    <div className="tpl-opt" key={o.id}>
                      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{o.name}</span>
                      <span className="muted small price">+฿{fmtBaht(o.price_add)}</span>
                    </div>
                  ))}
                  {opts.length === 0 ? <p className="muted small">ยังไม่มีตัวเลือกในหัวข้อนี้</p> : null}
                </div>
              )
            })}
          </>
        ) : (
          <p className="muted">ยังไม่มีประเภทอื่นที่มีหัวข้อ — สร้างหัวข้อของประเภทหนึ่งให้เสร็จก่อน แล้วค่อยใช้ template</p>
        )}
        {err ? <p className="error small">{err}</p> : null}
        {busy ? <p className="muted small">กำลังคัดลอก…</p> : null}
        <div className="row">
          <button type="button" className="btn primary grow" disabled={busy || checked.length === 0} onClick={() => void apply(false)}>
            เพิ่ม
          </button>
          <button type="button" className="btn ghost" disabled={busy || checked.length === 0} onClick={() => void apply(true)}>
            แก้ไข
          </button>
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
            ปิด
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- tiny on/off switch (>=44px touch target, inline styles only) ----

function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      style={{ minHeight: 44, minWidth: 60, padding: 8, background: 'transparent', border: 0, cursor: 'pointer' }}
    >
      <span style={{ width: 44, height: 26, borderRadius: 999, padding: 3, display: 'inline-flex', alignItems: 'center', background: checked ? 'var(--green)' : 'var(--border)' }}>
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: 'var(--knob)',
            transform: checked ? 'translateX(18px)' : 'none',
          }}
        />
      </span>
    </button>
  )
}

// ---- autosave text input: commits on blur, reverts when the save fails ----

function AutoText({
  value,
  onCommit,
  onEmpty,
  placeholder,
  ariaLabel,
  style,
  selectOnMount,
  list,
  allowEmpty,
}: {
  /** id of a <datalist> for typed suggestions. */
  list?: string
  /** an empty value is a valid commit (optional field). */
  allowEmpty?: boolean
  value: string
  onCommit: (v: string) => Promise<boolean> | boolean
  /** name cleared: report + revert without hitting the API. */
  onEmpty?: () => void
  placeholder?: string
  ariaLabel?: string
  style?: CSSProperties
  /** freshly created row: focus + select so typing renames it right away. */
  selectOnMount?: boolean
}) {
  const [t, setT] = useState(value)
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setT(value)
  }, [value])

  useEffect(() => {
    if (selectOnMount && ref.current) {
      ref.current.focus()
      ref.current.select()
    }
  }, [selectOnMount])

  async function commit() {
    const next = t.trim()
    if (next === value) {
      setT(value)
      return
    }
    if (next === '' && !allowEmpty) {
      onEmpty?.()
      setT(value)
      return
    }
    let ok = true
    try {
      ok = await onCommit(next)
    } catch {
      ok = false
    }
    setT(ok === false ? value : next)
  }

  return (
    <input
      ref={ref}
      value={t}
      list={list}
      aria-label={ariaLabel}
      placeholder={placeholder}
      style={style}
      onChange={(e) => setT(e.target.value)}
      onBlur={() => void commit()}
    />
  )
}

// ---- autosave baht input (server value in satang, empty = 0) ----

function AutoBaht({
  satang,
  onCommit,
  onInvalid,
  ariaLabel,
  style,
}: {
  satang: number
  onCommit: (s: number) => Promise<boolean> | boolean
  onInvalid?: () => void
  ariaLabel?: string
  style?: CSSProperties
}) {
  const [t, setT] = useState(() => fmtBaht(satang))

  useEffect(() => {
    setT(fmtBaht(satang))
  }, [satang])

  async function commit() {
    const s = t.trim()
    const n = s === '' ? 0 : bahtToSatang(s)
    if (n === 'invalid' || n === null) {
      onInvalid?.()
      setT(fmtBaht(satang))
      return
    }
    if (n === satang) {
      setT(fmtBaht(satang))
      return
    }
    let ok = true
    try {
      ok = await onCommit(n)
    } catch {
      ok = false
    }
    setT(fmtBaht(ok === false ? satang : n))
  }

  return (
    <input
      value={t}
      aria-label={ariaLabel}
      inputMode="decimal"
      placeholder="0"
      style={style}
      onChange={(e) => setT(e.target.value)}
      onBlur={() => void commit()}
    />
  )
}
