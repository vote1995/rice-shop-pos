import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import PosApp from './pos/PosApp'
import OwnerApp from './owner/OwnerApp'

// Runs before React mounts. pos.* is NOT behind Cloudflare Access, so /owner served
// there has no Access JWT and every owner API call 401s — bounce such requests to the
// owner.* host (Access-protected), keeping protocol, port, path, search and hash.
// Only hostnames starting with "pos." redirect; localhost / 127.0.0.1 / LAN IPs /
// anything else serve /owner directly so local development keeps working.
if (
  window.location.hostname.startsWith('pos.') &&
  (window.location.pathname === '/owner' || window.location.pathname.startsWith('/owner/'))
) {
  const ownerHost = window.location.hostname.replace(/^pos\./, 'owner.')
  const { protocol, port, pathname, search, hash } = window.location
  window.location.replace(
    `${protocol}//${ownerHost}${port ? `:${port}` : ''}${pathname}${search}${hash}`,
  )
} else {
  function pickApp() {
    // Owner mode: owner.* subdomain (production, behind Cloudflare Access) or /owner path (dev).
    if (window.location.hostname.startsWith('owner.')) return <OwnerApp />
    if (window.location.pathname.startsWith('/owner')) return <OwnerApp />
    return <PosApp />
  }

  createRoot(document.getElementById('root')!).render(<StrictMode>{pickApp()}</StrictMode>)
}
