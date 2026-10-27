import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { configured } from './lib/supabase'
import { E2EEProvider } from './lib/e2ee'
import { CoupleChannelProvider } from './lib/channel'
import { CallProvider } from './lib/calls'
import { PlayerProvider } from './lib/player'
import { Shell } from './components/Shell'
import { AuthPages, ResetPassword } from './pages/Auth'
import Pairing from './pages/Pairing'
import Home from './pages/Home'
import Chat from './pages/Chat'
import Memories from './pages/Memories'
import Letters from './pages/Letters'
import Playlist from './pages/Playlist'
import Calls from './pages/Calls'
import Settings from './pages/Settings'

const Splash = ({ text = 'Loading…' }: { text?: string }) => (
  <div className="splash"><h1>2 Fold <span>🌎💕</span></h1><p>{text}</p></div>
)

function UpdateBanner() {
  const [reg, setReg] = useState<ServiceWorkerRegistration | null>(null)
  useEffect(() => {
    const h = (e: Event) => setReg((e as CustomEvent).detail)
    window.addEventListener('twofold:update', h)
    return () => window.removeEventListener('twofold:update', h)
  }, [])
  if (!reg) return null
  return <div className="banner">A new version is ready. <button className="link" onClick={() => reg.waiting?.postMessage('SKIP_WAITING')}>Reload</button></div>
}

function Gate() {
  const { loading, session, recovery, couple } = useAuth()
  if (!configured) {
    return <div className="splash"><h1>Setup needed</h1><p>Copy <code>.env.example</code> to <code>.env</code> and set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>, then restart.</p></div>
  }
  if (loading) return <Splash />
  if (recovery) return <ResetPassword />
  if (!session) return <AuthPages />
  if (couple === undefined) return <Splash text="Opening our little world…" />
  if (couple === null || couple.memberCount < 2) return <Pairing />
  return (
    <E2EEProvider>
      <CoupleChannelProvider>
        <CallProvider>
          <PlayerProvider>
            <Routes>
              <Route element={<Shell />}>
                <Route index element={<Home />} />
                <Route path="chat" element={<Chat />} />
                <Route path="memories" element={<Memories />} />
                <Route path="letters" element={<Letters />} />
                <Route path="playlist" element={<Playlist />} />
                <Route path="calls" element={<Calls />} />
                <Route path="settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </PlayerProvider>
        </CallProvider>
      </CoupleChannelProvider>
    </E2EEProvider>
  )
}

export default function App() {
  return <AuthProvider><UpdateBanner /><Gate /></AuthProvider>
}
