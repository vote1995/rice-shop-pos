// OWNER stock tab (M1-6c) — sub-tab "คงเหลือ" (approximate ingredient balance
// with เติม/นับจริง/แก้ไข) and sub-tab "สูตร (ต่อจาน)" (which ingredients one
// plate of each menu type / option consumes).
//
// Patterns copied from MenuEditor: the shop selector, ONE busy flag, one
// friendly-error line, and local state patched from each API response
// instead of reloading the whole list after every mutation. Sheets reuse the
// POS .sheet styles; ingredient responses don't carry used_today, so the old
// row's value is kept while patching.
//
// qty is an approximation (last count − sold by recipe), which is why every
// amount reads "เหลือประมาณ" and the owner corrects it with "นับจริง".
// move_id is generated ONCE per sheet open, so a retry after a network error
// can never double-count (the server dedupes by move_id).
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { ApiError, api, friendlyError } from '../api'
import type {
  Ingredient,
  MenuData,
  MenuItem,
  RecipeUse,
  Shop,
  StockData,
  StockIngredient,
} from '../api'

type SubTab = 'balance' | 'recipe'

/** Unit suggestions of the new-ingredient sheet (design Main.dc.html). */
const UNIT_CHIPS = ['ถุง', 'กก.', 'ฟอง', 'แพ็ค', 'ขวด', 'หม้อ']

/** Quick-add chips of the restock sheet. */
const QUICK_ADDS = [1, 5, 10]

/** Which recipe target a uses sheet edits (the item's "ทุกจานใช้" or one option). */
interface RecipeTarget {
  itemId: string
  /** null = the menu item itself, otherwise one of its options. */
  optionId: string | null
}

/** 1 decimal, ".0" dropped — the design's round1(). */
function fmt1(v: number): string {
  const r = Math.round(v * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

/** '' -> 0, otherwise a non-negative number or null when unparsable. */
function parseQty(s: string): number | null {
  const t = s.trim()
  if (t === '') return 0
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** The amount_text grammar: decimals and fractions ("1/10"); null when bad/empty. */
function parseAmountText(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const slash = t.indexOf('/')
  if (slash > 0) {
    const a = Number(t.slice(0, slash))
    const b = Number(t.slice(slash + 1))
    return Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : null
  }
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** The stored uses of one target (item rows have option_id null). */
function usesOfTarget(recipe: RecipeUse[], t: RecipeTarget): RecipeUse[] {
  return t.optionId !== null
    ? recipe.filter((r) => r.option_id === t.optionId)
    : recipe.filter((r) => r.menu_item_id === t.itemId && r.option_id === null)
}

/** "บะหมี่ 1/10 ถุง, …" of one target, or null when nothing is set yet. */
function usesSummary(recipe: RecipeUse[], t: RecipeTarget, ingredients: StockIngredient[]): string | null {
  const parts = usesOfTarget(recipe, t)
    .map((r) => {
      const ing = ingredients.find((i) => i.id === r.ingredient_id)
      return ing ? `${ing.name} ${r.amount_text} ${ing.unit}` : ''
    })
    .filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : null
}

// ---- inline styles (kept local like MenuEditor: this screen shares the app CSS untouched) ----

/** the tappable name/qty column of a stock row (>=44px tall). */
const ROW_TAP: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  alignItems: 'stretch',
  textAlign: 'left',
  background: 'transparent',
  border: 0,
  padding: 0,
  minHeight: 44,
  fontWeight: 400,
  flex: '1 1 130px',
  minWidth: 0,
}
const ROW_BTN: CSSProperties = { flex: 'none', fontSize: '0.9rem', padding: '6px 10px', minHeight: 44 }
/** design colours of the "ใกล้หมด" state (orange text + warm border). */
const LOW_TEXT = '#B4530E'
const LOW_BORDER = '#E8B98F'

export default function StockPanel() {
  const [shops, setShops] = useState<Shop[]>([])
  const [shopId, setShopId] = useState('')
  const [stock, setStock] = useState<StockData | null>(null)
  const [menu, setMenu] = useState<MenuData | null>(null)
  const [menuErr, setMenuErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [subTab, setSubTab] = useState<SubTab>('balance')
  // one sheet at a time (the design's ingSheet + usesFor)
  const [restockFor, setRestockFor] = useState<StockIngredient | null>(null)
  const [countFor, setCountFor] = useState<StockIngredient | null>(null)
  const [editFor, setEditFor] = useState<StockIngredient | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [usesFor, setUsesFor] = useState<RecipeTarget | null>(null)

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

  const load = useCallback(
    async (reloadMenu = false) => {
      if (!shopId) {
        setStock(null)
        return
      }
      setBusy(true)
      try {
        setStock(await api<StockData>('GET', `/api/owner/shops/${encodeURIComponent(shopId)}/stock`))
        setMsg('')
        if (reloadMenu) {
          setMenu(await api<MenuData>('GET', `/api/owner/shops/${encodeURIComponent(shopId)}/menu`))
          setMenuErr('')
        }
      } catch (e) {
        setMsg(friendlyError(e))
      } finally {
        setBusy(false)
      }
    },
    [shopId],
  )

  useEffect(() => {
    void load()
  }, [load])

  // another shop = another stock list + menu: close sheets, drop the menu
  useEffect(() => {
    setRestockFor(null)
    setCountFor(null)
    setEditFor(null)
    setNewOpen(false)
    setUsesFor(null)
    setMenu(null)
    setMenuErr('')
  }, [shopId])

  // recipes are rarely touched — the menu loads only when that sub-tab opens
  useEffect(() => {
    if (subTab !== 'recipe' || !shopId || menu !== null || menuErr !== '') return
    let on = true
    setBusy(true)
    void (async () => {
      try {
        const d = await api<MenuData>('GET', `/api/owner/shops/${encodeURIComponent(shopId)}/menu`)
        if (!on) return
        setMenu(d)
        setMenuErr('')
      } catch (e) {
        if (on) setMenuErr(friendlyError(e))
      } finally {
        if (on) setBusy(false)
      }
    })()
    return () => {
      on = false
    }
  }, [subTab, shopId, menu, menuErr])

  // ---- local state patching (one row per response, no full reload) ----

  /** merge one Ingredient response, keeping used_today of the previous row. */
  function patchIngredient(row: Ingredient) {
    setStock((prev) =>
      prev
        ? {
            ...prev,
            ingredients: prev.ingredients.some((i) => i.id === row.id)
              ? prev.ingredients.map((i) => (i.id === row.id ? { ...i, ...row, used_today: i.used_today } : i))
              : [...prev.ingredients, { ...row, used_today: 0 }], // freshly created row
          }
        : prev,
    )
  }

  /** PUT /api/owner/recipe replaces ALL uses of one target — swap them in. */
  function replaceUses(t: RecipeTarget, uses: RecipeUse[]) {
    setStock((prev) => {
      if (!prev) return prev
      const gone = new Set(usesOfTarget(prev.recipe, t).map((r) => r.id))
      return { ...prev, recipe: [...prev.recipe.filter((r) => !gone.has(r.id)), ...uses] }
    })
  }

  // ---- derived rows ----

  const ingredients = stock?.ingredients ?? []
  const activeRows = ingredients.filter((i) => i.status === 'active')
  const inactiveRows = ingredients.filter((i) => i.status !== 'active')
  // the badge warns only about ingredients still in use
  const lowCount = activeRows.filter((i) => i.qty <= i.alert_level).length

  function usesTitle(t: RecipeTarget): string {
    if (!menu) return 'วัตถุดิบที่ใช้'
    if (t.optionId !== null) {
      const o = menu.options.find((x) => x.id === t.optionId)
      return `วัตถุดิบของ "${o?.name ?? '?'}"`
    }
    const it = menu.items.find((x) => x.id === t.itemId)
    return `วัตถุดิบที่ใช้ทุกจาน "${it?.name ?? '?'}"`
  }

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

      <div className="seg" role="tablist" aria-label="สต็อก">
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'balance'}
          className={subTab === 'balance' ? 'on' : ''}
          onClick={() => setSubTab('balance')}
        >
          {lowCount > 0 ? `คงเหลือ (ใกล้หมด ${lowCount})` : 'คงเหลือ'}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'recipe'}
          className={subTab === 'recipe' ? 'on' : ''}
          onClick={() => setSubTab('recipe')}
        >
          สูตร (ต่อจาน)
        </button>
      </div>

      {subTab === 'balance' ? renderBalance() : renderRecipe()}

      {restockFor ? (
        <RestockSheet row={restockFor} onClose={() => setRestockFor(null)} onSaved={patchIngredient} />
      ) : null}
      {countFor ? (
        <CountSheet row={countFor} onClose={() => setCountFor(null)} onSaved={patchIngredient} />
      ) : null}
      {editFor ? (
        <EditSheet row={editFor} onClose={() => setEditFor(null)} onSaved={patchIngredient} />
      ) : null}
      {newOpen && shopId ? (
        <NewSheet shopId={shopId} onClose={() => setNewOpen(false)} onSaved={patchIngredient} />
      ) : null}
      {usesFor && stock ? (
        <UsesSheet
          key={usesFor.optionId ?? usesFor.itemId}
          target={usesFor}
          title={usesTitle(usesFor)}
          ingredients={stock.ingredients}
          initialUses={usesOfTarget(stock.recipe, usesFor)}
          onClose={() => setUsesFor(null)}
          onSaved={(uses) => replaceUses(usesFor, uses)}
        />
      ) : null}
    </section>
  )

  // ================= sub-tab A: คงเหลือ =================

  function renderBalance() {
    return (
      <>
        <div className="row">
          <h2 className="grow">วัตถุดิบ ({ingredients.length})</h2>
          <button className="btn ghost" disabled={busy || !shopId} onClick={() => void load()}>
            รีเฟรช
          </button>
        </div>
        <p className="muted small">
          คงเหลือโดยประมาณ = ล่าสุดที่นับ − ที่ขายไป (คิดจากสูตรต่อจาน) · แตะชื่อเพื่อแก้ไข/ปิดใช้
        </p>

        {shopId && !stock && !msg ? <p className="muted">กำลังโหลดสต็อก…</p> : null}

        <div className="list">
          {activeRows.map((row) => (
            <StockRow
              key={row.id}
              row={row}
              onRestock={() => setRestockFor(row)}
              onCount={() => setCountFor(row)}
              onEdit={() => setEditFor(row)}
            />
          ))}
          {inactiveRows.map((row) => (
            <StockRow
              key={row.id}
              row={row}
              dimmed
              onRestock={() => setRestockFor(row)}
              onCount={() => setCountFor(row)}
              onEdit={() => setEditFor(row)}
            />
          ))}
        </div>
        {stock && ingredients.length === 0 ? (
          <p className="muted">ยังไม่มีวัตถุดิบ — กด “+ เพิ่มวัตถุดิบ” เพื่อเริ่ม</p>
        ) : null}

        <button className="btn primary" disabled={busy || !shopId} onClick={() => setNewOpen(true)}>
          + เพิ่มวัตถุดิบ
        </button>
      </>
    )
  }

  // ================= sub-tab B: สูตร (ต่อจาน) =================

  function renderRecipe() {
    const activeItems = menu ? menu.items.filter((i) => i.status === 'active') : []
    return (
      <>
        <div className="row">
          <h2 className="grow">สูตร (ต่อจาน)</h2>
          <button className="btn ghost" disabled={busy || !shopId} onClick={() => void load(true)}>
            รีเฟรช
          </button>
        </div>
        <p className="muted small">ตั้งครั้งเดียวต่อร้าน — คงเหลือจะลดตามสูตรนี้ทุกจานที่ขาย</p>

        {menuErr ? (
          <div className="row">
            <p className="error small grow">{menuErr}</p>
            <button type="button" className="btn ghost" onClick={() => setMenuErr('')}>
              ลองใหม่
            </button>
          </div>
        ) : null}
        {shopId && !menu && menuErr === '' ? <p className="muted">กำลังโหลดเมนู…</p> : null}

        {menu && stock ? (
          <div className="list">
            {activeItems.map((it) => (
              <RecipeCard key={it.id} item={it} menu={menu} stock={stock} onOpen={setUsesFor} />
            ))}
            {activeItems.length === 0 ? (
              <p className="muted">ยังไม่มีประเภทที่เปิดขาย — เพิ่มในแท็บ “เมนู” ก่อน</p>
            ) : null}
          </div>
        ) : null}
      </>
    )
  }
}

// ---------------------------------------------------------------------------
// One ingredient row of the balance list (design oview 'stock')
// ---------------------------------------------------------------------------

function StockRow({
  row,
  dimmed,
  onRestock,
  onCount,
  onEdit,
}: {
  row: StockIngredient
  /** inactive rows sink to the bottom, dimmed */
  dimmed?: boolean
  onRestock: () => void
  onCount: () => void
  onEdit: () => void
}) {
  const low = row.qty <= row.alert_level
  return (
    <div
      className="item"
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        opacity: dimmed ? 0.55 : 1,
        borderColor: low && !dimmed ? LOW_BORDER : undefined,
      }}
    >
      <button type="button" style={ROW_TAP} onClick={onEdit} aria-label={`แก้ไข ${row.name}`}>
        <strong>{row.name}</strong>
        <span
          style={{
            fontSize: '0.95rem',
            fontWeight: 600,
            color: low ? LOW_TEXT : 'var(--green-dark)',
          }}
        >
          เหลือประมาณ {fmt1(row.qty)} {row.unit}
          {low ? ' · ใกล้หมด' : ''}
        </span>
        <span className="muted" style={{ fontSize: '0.8rem' }}>
          ใช้ไปวันนี้ {fmt1(row.used_today)} {row.unit}
        </span>
      </button>
      <button type="button" className="btn primary" style={ROW_BTN} onClick={onRestock}>
        + เติม
      </button>
      <button type="button" className="btn ghost" style={ROW_BTN} onClick={onCount}>
        นับจริง
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// One menu type card of the recipe list: "ทุกจานใช้" + every option row
// ---------------------------------------------------------------------------

function RecipeCard({
  item,
  menu,
  stock,
  onOpen,
}: {
  item: MenuItem
  menu: MenuData
  stock: StockData
  onOpen: (t: RecipeTarget) => void
}) {
  const groups = menu.option_groups.filter((g) => g.menu_item_id === item.id)
  const sum = (t: RecipeTarget) => usesSummary(stock.recipe, t, stock.ingredients)
  return (
    <div className="item">
      <strong>{item.name}</strong>
      <UseRow
        label="ทุกจานใช้:"
        name=""
        summary={sum({ itemId: item.id, optionId: null })}
        onOpen={() => onOpen({ itemId: item.id, optionId: null })}
      />
      {groups.map((g) => {
        const opts = menu.options.filter((o) => o.option_group_id === g.id)
        return (
          <div className="group-block" key={g.id}>
            <div className="group-head">
              <strong>{g.name}</strong>
            </div>
            {opts.map((o) => (
              <UseRow
                key={o.id}
                name={o.name}
                summary={sum({ itemId: item.id, optionId: o.id })}
                onOpen={() => onOpen({ itemId: item.id, optionId: o.id })}
              />
            ))}
            {opts.length === 0 ? <p className="muted small">ยังไม่มีตัวเลือกในหัวข้อนี้</p> : null}
          </div>
        )
      })}
      {groups.length === 0 ? <p className="muted small">ยังไม่มีหัวข้อของประเภทนี้</p> : null}
    </div>
  )
}

/** One tappable recipe row: name + its uses (or muted "ยังไม่ตั้ง"). */
function UseRow({
  label,
  name,
  summary,
  onOpen,
}: {
  /** small muted prefix, e.g. "ทุกจานใช้:" of the item row */
  label?: string
  name: string
  summary: string | null
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      className="btn ghost"
      style={{
        textAlign: 'left',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '2px 8px',
        alignItems: 'baseline',
        fontWeight: 400,
        minHeight: 44,
      }}
      onClick={onOpen}
    >
      {label ? (
        <span className="muted" style={{ flex: 'none', fontSize: '0.9rem' }}>
          {label}
        </span>
      ) : null}
      {name ? (
        <strong style={{ flex: 'none', fontWeight: 700 }}>
          {name}
        </strong>
      ) : null}
      <span
        style={{
          flex: '1 1 100px',
          minWidth: 0,
          fontSize: '0.9rem',
          fontWeight: 600,
          overflowWrap: 'anywhere',
          color: summary ? 'var(--green-dark)' : undefined,
        }}
        className={summary ? undefined : 'muted'}
      >
        {summary ?? 'ยังไม่ตั้ง'}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// + เติม sheet (amount > 0; quick chips; move_id reused on retry)
// ---------------------------------------------------------------------------

function RestockSheet({
  row,
  onClose,
  onSaved,
}: {
  row: StockIngredient
  onClose: () => void
  onSaved: (ing: Ingredient) => void
}) {
  // one move id per sheet open — a retry after a network error reuses it
  const [moveId] = useState(() => crypto.randomUUID())
  const [amount, setAmount] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  function addQuick(n: number) {
    setAmount(fmt1((parseQty(amount) ?? 0) + n))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const t = amount.trim()
    const a = Number(t)
    if (t === '' || !Number.isFinite(a) || a <= 0) {
      setErr(`ใส่จำนวนที่เติมเป็นตัวเลขมากกว่า 0 (${row.unit})`)
      return
    }
    setBusy(true)
    setErr('')
    try {
      onSaved(
        await api<Ingredient>('POST', `/api/owner/ingredients/${encodeURIComponent(row.id)}/restock`, {
          move_id: moveId,
          amount: a,
        }),
      )
      onClose()
    } catch (e) {
      setErr(friendlyError(e)) // sheet stays open: the SAME move_id is retried
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form
        className="sheet"
        role="dialog"
        aria-label={`เติม ${row.name}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2>
          เติม {row.name} ({row.unit})
        </h2>
        <p className="muted small">
          เหลือประมาณ {fmt1(row.qty)} {row.unit} — บวกจากของที่ซื้อมาใหม่
        </p>
        <label>
          ซื้อมาเพิ่มกี่ {row.unit}
          <input
            value={amount}
            inputMode="decimal"
            placeholder="0"
            autoFocus
            disabled={busy}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <div className="chips" role="group" aria-label="เพิ่มเร็ว">
          {QUICK_ADDS.map((n) => (
            <button type="button" key={n} className="chip" disabled={busy} onClick={() => addQuick(n)}>
              +{n}
            </button>
          ))}
        </div>
        {err ? <p className="error small">{err}</p> : null}
        <div className="row">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </button>
          <button type="submit" className="btn primary grow" disabled={busy}>
            บันทึก
          </button>
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// นับจริง sheet (qty >= 0, prefilled with the current approximation)
// ---------------------------------------------------------------------------

function CountSheet({
  row,
  onClose,
  onSaved,
}: {
  row: StockIngredient
  onClose: () => void
  onSaved: (ing: Ingredient) => void
}) {
  // one move id per sheet open — a retry after a network error reuses it
  const [moveId] = useState(() => crypto.randomUUID())
  const [qty, setQty] = useState(() => fmt1(row.qty))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const q = parseQty(qty)
    if (q === null) {
      setErr('ใส่จำนวนที่นับได้เป็นตัวเลข (ใส่ 0 ได้ถ้าหมด)')
      return
    }
    setBusy(true)
    setErr('')
    try {
      onSaved(
        await api<Ingredient>('POST', `/api/owner/ingredients/${encodeURIComponent(row.id)}/count`, {
          move_id: moveId,
          qty: q,
        }),
      )
      onClose()
    } catch (e) {
      setErr(friendlyError(e)) // sheet stays open: the SAME move_id is retried
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form
        className="sheet"
        role="dialog"
        aria-label={`นับจริง ${row.name}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2>นับจริง {row.name}</h2>
        <p className="muted small">
          เหลือประมาณ {fmt1(row.qty)} {row.unit} · ใช้ไปวันนี้ {fmt1(row.used_today)} {row.unit}
        </p>
        <label>
          จำนวนที่นับได้ ({row.unit})
          <input
            value={qty}
            inputMode="decimal"
            placeholder="0"
            autoFocus
            disabled={busy}
            onChange={(e) => setQty(e.target.value)}
          />
        </label>
        <p className="muted small">นับแล้วใส่ตัวเลขจริง — ระบบจะเริ่มนับ “ใช้ไปวันนี้” ใหม่จากตรงนี้</p>
        {err ? <p className="error small">{err}</p> : null}
        <div className="row">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </button>
          <button type="submit" className="btn primary grow" disabled={busy}>
            บันทึก
          </button>
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit sheet (tap the name): name / unit / alert level / เปิด-ปิดใช้ -> PUT
// ---------------------------------------------------------------------------

function EditSheet({
  row,
  onClose,
  onSaved,
}: {
  row: StockIngredient
  onClose: () => void
  onSaved: (ing: Ingredient) => void
}) {
  const [name, setName] = useState(row.name)
  const [unit, setUnit] = useState(row.unit)
  const [alert, setAlert] = useState(() => fmt1(row.alert_level))
  const [active, setActive] = useState(row.status === 'active')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const n = name.trim()
    const u = unit.trim()
    const a = parseQty(alert)
    if (n === '' || u === '') {
      setErr('ใส่ชื่อและหน่วยก่อน')
      return
    }
    if (a === null) {
      setErr('ระดับเตือนต้องเป็นตัวเลข')
      return
    }
    setBusy(true)
    setErr('')
    try {
      onSaved(
        await api<Ingredient>('PUT', `/api/owner/ingredients/${encodeURIComponent(row.id)}`, {
          name: n,
          unit: u,
          alert_level: a,
          status: active ? 'active' : 'inactive',
        }),
      )
      onClose()
    } catch (e) {
      setErr(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form
        className="sheet"
        role="dialog"
        aria-label={`แก้ไข ${row.name}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2>แก้ไข {row.name}</h2>
        <label>
          ชื่อ
          <input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          หน่วย
          <input value={unit} disabled={busy} onChange={(e) => setUnit(e.target.value)} />
        </label>
        <p className="muted small">ตั้งครั้งเดียว — ถ้าเปลี่ยนหน่วย ให้กด “นับจริง” ใหม่ด้วย</p>
        <label>
          เตือนเมื่อเหลือน้อยกว่า ({unit.trim() === '' ? 'หน่วย' : unit.trim()})
          <input
            value={alert}
            inputMode="decimal"
            placeholder="เช่น 1"
            disabled={busy}
            onChange={(e) => setAlert(e.target.value)}
          />
        </label>
        <div className="row">
          <span className={`badge ${active ? 'approved' : 'revoked'}`}>{active ? 'เปิดใช้' : 'ปิดใช้'}</span>
          <span className="grow" />
          <button type="button" className="btn ghost" disabled={busy} onClick={() => setActive((v) => !v)}>
            {active ? 'ปิดใช้วัตถุดิบนี้' : 'เปิดใช้วัตถุดิบนี้'}
          </button>
        </div>
        {err ? <p className="error small">{err}</p> : null}
        <div className="row">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </button>
          <button type="submit" className="btn primary grow" disabled={busy}>
            บันทึก
          </button>
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// New ingredient sheet -> POST /api/owner/ingredients
// ---------------------------------------------------------------------------

function NewSheet({
  shopId,
  onClose,
  onSaved,
}: {
  shopId: string
  onClose: () => void
  onSaved: (ing: Ingredient) => void
}) {
  const [name, setName] = useState('')
  const [unit, setUnit] = useState('')
  const [qty, setQty] = useState('')
  const [alert, setAlert] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const u = unit.trim()

  async function submit(e: FormEvent) {
    e.preventDefault()
    const n = name.trim()
    const q = parseQty(qty)
    const a = parseQty(alert)
    if (n === '' || u === '') {
      setErr('ใส่ชื่อและหน่วยก่อน')
      return
    }
    if (q === null || a === null) {
      setErr('จำนวนและระดับเตือนต้องเป็นตัวเลข')
      return
    }
    setBusy(true)
    setErr('')
    try {
      onSaved(
        await api<Ingredient>('POST', '/api/owner/ingredients', {
          id: crypto.randomUUID(),
          shop_id: shopId,
          name: n,
          unit: u,
          qty: q,
          alert_level: a,
        }),
      )
      onClose()
    } catch (e) {
      setErr(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form
        className="sheet"
        role="dialog"
        aria-label="เพิ่มวัตถุดิบ"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2>เพิ่มวัตถุดิบ</h2>
        <label>
          ชื่อวัตถุดิบ
          <input
            value={name}
            placeholder="เช่น บะหมี่"
            autoFocus
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          หน่วย
          <input
            value={unit}
            placeholder="เช่น ถุง"
            disabled={busy}
            onChange={(e) => setUnit(e.target.value)}
          />
        </label>
        <p className="muted small">ตั้งครั้งเดียว — ทุกจำนวนของวัตถุดิบนี้จะนับในหน่วยนี้เสมอ</p>
        <div className="chips" role="group" aria-label="หน่วยแนะนำ">
          {UNIT_CHIPS.map((x) => (
            <button
              type="button"
              key={x}
              className={`chip${u === x ? ' on' : ''}`}
              disabled={busy}
              onClick={() => setUnit(x)}
            >
              {x}
            </button>
          ))}
        </div>
        <label>
          มีอยู่ตอนนี้{u ? ` (${u})` : ''}
          <input
            value={qty}
            inputMode="decimal"
            placeholder="0"
            disabled={busy}
            onChange={(e) => setQty(e.target.value)}
          />
        </label>
        <label>
          เตือนเมื่อเหลือน้อยกว่า{u ? ` (${u})` : ''}
          <input
            value={alert}
            inputMode="decimal"
            placeholder="เช่น 1"
            disabled={busy}
            onChange={(e) => setAlert(e.target.value)}
          />
        </label>
        {err ? <p className="error small">{err}</p> : null}
        <div className="row">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </button>
          <button type="submit" className="btn primary grow" disabled={busy}>
            บันทึก
          </button>
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// "วัตถุดิบที่ใช้" sheet: one target's uses -> PUT /api/owner/recipe (replaces all)
// ---------------------------------------------------------------------------

function UsesSheet({
  target,
  title,
  ingredients,
  initialUses,
  onClose,
  onSaved,
}: {
  target: RecipeTarget
  title: string
  ingredients: StockIngredient[]
  initialUses: RecipeUse[]
  onClose: () => void
  onSaved: (uses: RecipeUse[]) => void
}) {
  // draft rows: the amount_text as typed; the server parses + validates them
  const [rows, setRows] = useState<Array<{ ingredient_id: string; amount_text: string }>>(() =>
    initialUses.map((r) => ({ ingredient_id: r.ingredient_id, amount_text: r.amount_text })),
  )
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const ingOf = (id: string) => ingredients.find((i) => i.id === id)
  const unused = ingredients.filter((i) => i.status === 'active' && !rows.some((r) => r.ingredient_id === i.id))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const body =
        target.optionId !== null
          ? { option_id: target.optionId, uses: rows }
          : { menu_item_id: target.itemId, uses: rows }
      const res = await api<{ uses: RecipeUse[] }>('PUT', '/api/owner/recipe', body)
      onSaved(res.uses)
      onClose()
    } catch (e) {
      // bad amounts: the server's 400 message names the problem — show it as-is
      setErr(e instanceof ApiError && e.status === 400 ? e.message : friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form
        className="sheet"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2>{title}</h2>
        <p className="muted small">ใส่ปริมาณต่อ 1 จาน พิมพ์เศษส่วนได้ เช่น 1/10 = 1 ถุงทำได้ 10 จาน</p>
        {rows.map((r, idx) => {
          const ing = ingOf(r.ingredient_id)
          const bad = parseAmountText(r.amount_text) === null
          return (
            <div className="row" key={r.ingredient_id} style={{ gap: 8, flexWrap: 'nowrap' }}>
              <span style={{ flex: '1 1 110px', minWidth: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>
                {ing?.name ?? '?'}
              </span>
              <input
                style={{ flex: '0 0 96px', borderColor: bad ? LOW_TEXT : undefined }}
                value={r.amount_text}
                aria-label={`ปริมาณ ${ing?.name ?? ''} ต่อจาน`}
                placeholder="1/10"
                disabled={busy}
                onChange={(e) =>
                  setRows(rows.map((x, j) => (j === idx ? { ...x, amount_text: e.target.value } : x)))
                }
              />
              <span className="muted small" style={{ flex: '0 0 48px' }}>
                {ing?.unit ?? ''}
              </span>
              <button
                type="button"
                className="btn ghost"
                style={{ flex: 'none', minWidth: 44, minHeight: 44, padding: '4px 10px', color: 'var(--danger)' }}
                aria-label={`ไม่ใช้ ${ing?.name ?? ''}`}
                disabled={busy}
                onClick={() => setRows(rows.filter((_, j) => j !== idx))}
              >
                ✕
              </button>
            </div>
          )
        })}
        {rows.length === 0 ? (
          <p className="muted small">ยังไม่ใช้วัตถุดิบ — เพิ่มด้านล่าง หรือกดบันทึกเพื่อล้างทั้งหมด</p>
        ) : null}
        <p className="muted small">แตะเพื่อเพิ่มวัตถุดิบ (เฉพาะที่เปิดใช้)</p>
        <div className="chips" role="group" aria-label="เพิ่มวัตถุดิบ">
          {unused.map((i) => (
            <button
              type="button"
              key={i.id}
              className="chip"
              disabled={busy}
              onClick={() => setRows([...rows, { ingredient_id: i.id, amount_text: '' }])}
            >
              + {i.name}
            </button>
          ))}
          {unused.length === 0 ? <span className="muted small">ใช้ครบทุกวัตถุดิบที่เปิดใช้แล้ว</span> : null}
        </div>
        {err ? <p className="error small">{err}</p> : null}
        <div className="row">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </button>
          <button type="submit" className="btn primary grow" disabled={busy}>
            บันทึก
          </button>
        </div>
      </form>
    </div>
  )
}
