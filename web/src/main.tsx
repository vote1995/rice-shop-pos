import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import PosApp from './pos/PosApp'
import OwnerApp from './owner/OwnerApp'

function pickApp() {
  // Owner mode: owner.* subdomain (production, behind Cloudflare Access) or /owner path (dev).
  if (window.location.hostname.startsWith('owner.')) return <OwnerApp />
  if (window.location.pathname.startsWith('/owner')) return <OwnerApp />
  return <PosApp />
}

createRoot(document.getElementById('root')!).render(<StrictMode>{pickApp()}</StrictMode>)
