import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>,
)

// Service worker: app shell + push only (see public/sw.js). Update handling: a new worker waits and the
// UpdateBanner in App offers "Reload"; nothing is force-reloaded under the user.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    const announce = () => window.dispatchEvent(new CustomEvent('twofold:update', { detail: reg }))
    if (reg.waiting) announce()
    reg.addEventListener('updatefound', () => {
      reg.installing?.addEventListener('statechange', function () {
        if (this.state === 'installed' && navigator.serviceWorker.controller) announce()
      })
    })
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000)
  }).catch(() => {})
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload() } })
}
