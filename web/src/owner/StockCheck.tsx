// "ตามสูตร vs ใช้จริง": per ingredient, what the recipes say the sold plates
// (and staff meals) used, against what really went out according to the staff
// counts. Only COUNTED days take part: on such a day
//   real use = recipe use - count_delta
// (count_delta = counted - system estimate; finding LESS on the shelf than
// the estimate means more went into the plates than the recipe says).
// A count also carries the drift since the PREVIOUS count, so the picture is
// exact when the shop counts every evening.

import { useMemo, useState } from 'react'
import type { ReportStockCheckRow } from '../api'

/** |diff| below this share of the recipe use is "ตามสูตร" (normal scatter). */
const OK_BAND = 0.05

interface Compared {
  id: string
  name: string
  unit: string
  recipe: number
  real: number
  /** (real - recipe) / recipe; null when the recipe used nothing. */
  diff: number | null
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function fmtQty(v: number, unit: string): string {
  return `${round2(v).toLocaleString('th-TH', { maximumFractionDigits: 2 })} ${unit}`
}

/** "2026-10-05" -> "5 ต.ค." */
function fmtDayShort(day: string): string {
  const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
  const [, m, d] = day.split('-').map(Number)
  return `${d} ${MONTHS[m - 1] ?? ''}`
}

function compare(rows: ReportStockCheckRow[]): Compared[] {
  const by = new Map<string, Compared>()
  for (const r of rows) {
    if (r.counts === 0) continue
    const c = by.get(r.ingredient_id) ?? { id: r.ingredient_id, name: r.name, unit: r.unit, recipe: 0, real: 0, diff: null }
    c.recipe += r.recipe_use
    c.real += r.recipe_use - r.count_delta
    by.set(r.ingredient_id, c)
  }
  return [...by.values()]
    .map((c) => ({ ...c, diff: c.recipe > 0 ? (c.real - c.recipe) / c.recipe : null }))
    .sort((a, b) => Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0) || a.name.localeCompare(b.name, 'th'))
}

function verdict(c: Compared): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (c.diff === null) {
    return c.real > 0.0001
      ? { text: `หายไป ${fmtQty(c.real, c.unit)} (ไม่มีขาย)`, tone: 'bad' }
      : { text: 'ตรงกับที่นับ', tone: 'ok' }
  }
  const pct = Math.round(c.diff * 100)
  if (Math.abs(c.diff) < OK_BAND) return { text: `ตามสูตร (${pct >= 0 ? '+' : ''}${pct}%)`, tone: 'ok' }
  return c.diff > 0
    ? { text: `ใส่เกิน +${pct}%`, tone: 'bad' }
    : { text: `ใส่น้อย ${pct}%`, tone: 'warn' }
}

export default function StockCheck({ rows }: { rows: ReportStockCheckRow[] }) {
  const countedDays = useMemo(
    () => [...new Set(rows.filter((r) => r.counts > 0).map((r) => r.day))].sort(),
    [rows],
  )
  const [day, setDay] = useState<string>('all')
  const shownDay = day !== 'all' && !countedDays.includes(day) ? 'all' : day
  const compared = useMemo(
    () => compare(shownDay === 'all' ? rows : rows.filter((r) => r.day === shownDay)),
    [rows, shownDay],
  )

  return (
    <section className="card dash-card">
      <div className="dash-head">
        <h2>ตามสูตร vs ใช้จริง</h2>
        <p className="muted small">
          {countedDays.length > 0 ? `จากการนับสต็อก ${countedDays.length} วัน` : 'ยังไม่มีการนับ'}
        </p>
      </div>

      {countedDays.length === 0 ? (
        <p className="muted small">
          ยังไม่มีการนับสต็อกในช่วงนี้ — ให้พนักงานกดแท็บ <strong>นับสต็อก</strong> ทุกเย็นหลังปิดร้าน
          แล้วกราฟจะเทียบว่าใส่วัตถุดิบเกินหรือน้อยกว่าสูตร
        </p>
      ) : (
        <>
          {countedDays.length > 1 ? (
            <div className="chips" role="group" aria-label="เลือกวันที่นับ">
              <button
                type="button"
                className={`chip${shownDay === 'all' ? ' on' : ''}`}
                aria-pressed={shownDay === 'all'}
                onClick={() => setDay('all')}
              >
                รวมทุกวันที่นับ
              </button>
              {countedDays.map((d) => (
                <button
                  type="button"
                  key={d}
                  className={`chip${shownDay === d ? ' on' : ''}`}
                  aria-pressed={shownDay === d}
                  onClick={() => setDay(d)}
                >
                  {fmtDayShort(d)}
                </button>
              ))}
            </div>
          ) : null}

          <div className="sc-legend" aria-hidden="true">
            <span><i className="sc-sw recipe" /> ตามสูตร (จากที่ขาย + สวัสดิการ)</span>
            <span><i className="sc-sw real" /> ใช้จริง (จากการนับ)</span>
          </div>

          <div className="sc-list">
            {compared.map((c) => {
              const max = Math.max(c.recipe, c.real, 0.0001)
              const v = verdict(c)
              return (
                <div
                  className="sc-row"
                  key={c.id}
                  aria-label={`${c.name}: ตามสูตร ${fmtQty(c.recipe, c.unit)}, ใช้จริง ${fmtQty(c.real, c.unit)}, ${v.text}`}
                >
                  <div className="sc-top">
                    <strong className="sc-name">{c.name}</strong>
                    <span className={`sc-verdict ${v.tone}`}>{v.text}</span>
                  </div>
                  <div className="sc-bar" aria-hidden="true">
                    <span className="sc-track"><span className="sc-fill recipe" style={{ width: `${Math.max(0, (c.recipe / max) * 100)}%` }} /></span>
                    <span className="sc-num">{fmtQty(c.recipe, c.unit)}</span>
                  </div>
                  <div className="sc-bar" aria-hidden="true">
                    <span className="sc-track"><span className={`sc-fill real ${v.tone}`} style={{ width: `${Math.max(0, (c.real / max) * 100)}%` }} /></span>
                    <span className="sc-num">{fmtQty(c.real, c.unit)}</span>
                  </div>
                </div>
              )
            })}
          </div>
          <p className="muted small">
            ใช้จริง = ที่ระบบตัดตามสูตร ± ส่วนต่างตอนนับ · ตัวเลขแม่นที่สุดเมื่อนับทุกวัน
            (การนับหนึ่งครั้งรวมส่วนต่างตั้งแต่การนับครั้งก่อน)
          </p>
        </>
      )}
    </section>
  )
}
