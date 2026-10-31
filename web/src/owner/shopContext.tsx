//! OWNER shop context (UI-2) — ONE shop picker for the whole owner app.
//!
//! Before this, every owner panel fetched GET /api/owner/shops on its own and
//! kept its own `shopId`, so the sidebar card was read-only and the same list
//! was selected in five places. Now OwnerApp mounts <OwnerShopProvider>, the
//! sidebar card is the only switcher, and the panels just read `shopId` (their
//! data still refetches when it changes, because shopId is in their effect
//! deps exactly as before).
//!
//! The selection is remembered in localStorage ('owner.shop'), so a reload
//! reopens the shop the owner was looking at; the first shop is the fallback
//! when nothing (or something stale/deleted) is remembered. `reload()` exists
//! for the "ร้าน" page, which creates shops.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, friendlyError } from '../api'
import type { Shop } from '../api'

/** localStorage key of the remembered selection. */
const SHOP_KEY = 'owner.shop'

export interface OwnerShopValue {
  shops: Shop[]
  /** the selected shop id ('' while loading / when the owner has no shop yet) */
  shopId: string
  setShopId: (id: string) => void
  /** the selected row, or null — handy for the sidebar card and defaults */
  shop: Shop | null
  /** refetch the list; the "ร้าน" page calls it after creating a shop */
  reload: () => Promise<void>
  /** friendly Thai message of the last failed load ('' when fine) */
  error: string
}

const OwnerShopContext = createContext<OwnerShopValue | null>(null)

/** The remembered id, '' when nothing (or storage is unavailable). */
function rememberedShopId(): string {
  try {
    return localStorage.getItem(SHOP_KEY) ?? ''
  } catch {
    return ''
  }
}

export function OwnerShopProvider({ children }: { children: ReactNode }) {
  const [shops, setShops] = useState<Shop[]>([])
  const [shopId, setShopIdState] = useState<string>(rememberedShopId)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    try {
      const ss = await api<Shop[]>('GET', '/api/owner/shops')
      setShops(ss)
      setError('')
      // keep the selection when it still exists, else take the first shop
      setShopIdState((cur) => (cur !== '' && ss.some((s) => s.id === cur) ? cur : (ss[0]?.id ?? '')))
    } catch (e) {
      setError(friendlyError(e))
    }
  }, [])

  // ONE load per mount: every panel and the sidebar share the result.
  useEffect(() => {
    void reload()
  }, [reload])

  const setShopId = useCallback((id: string) => {
    setShopIdState(id)
    try {
      localStorage.setItem(SHOP_KEY, id)
    } catch {
      /* private mode: remember the choice for this session only */
    }
  }, [])

  const value = useMemo<OwnerShopValue>(
    () => ({ shops, shopId, setShopId, shop: shops.find((s) => s.id === shopId) ?? null, reload, error }),
    [shops, shopId, setShopId, reload, error],
  )

  return <OwnerShopContext.Provider value={value}>{children}</OwnerShopContext.Provider>
}

/** The one shop selection of the owner app — needs <OwnerShopProvider> above it. */
export function useOwnerShop(): OwnerShopValue {
  const v = useContext(OwnerShopContext)
  if (v === null) throw new Error('useOwnerShop() must be used inside <OwnerShopProvider>')
  return v
}
