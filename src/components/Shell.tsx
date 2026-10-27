import { useEffect, useState } from 'react'
import { NavLink, Outlet, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useCoupleChannel } from '../lib/channel'
import { useCall } from '../lib/calls'
import { Icon } from './Icon'
import { MiniPlayer } from './MiniPlayer'
import { CallOverlay } from './CallOverlay'

const NAV = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/chat', label: 'Chat', icon: 'chat' },
  { to: '/memories', label: 'Memories', icon: 'image' },
  { to: '/letters', label: 'Letters', icon: 'mail' },
  { to: '/playlist', label: 'Playlist', icon: 'music' },
]

export function Shell() {
  const { couple, user } = useAuth()
  const { partnerOnline, connected } = useCoupleChannel()
  const call = useCall()
  const [unread, setUnread] = useState(0)
  const [online, setOnline] = useState(navigator.onLine)

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  // unread badge + delivery receipts (delivered = this device received it, wherever the user is in the app)
  useEffect(() => {
    if (!couple || !user) return
    const count = async () => {
      const { count: n } = await supabase.from('messages').select('id', { count: 'exact', head: true }).neq('sender_id', user.id).is('read_at', null)
      setUnread(n ?? 0)
    }
    count(); supabase.rpc('mark_delivered').then(() => {})
    const ch = supabase.channel(`shell:${couple.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `couple_id=eq.${couple.id}` }, (p) => {
        if (p.eventType === 'INSERT' && (p.new as { sender_id: string }).sender_id !== user.id) supabase.rpc('mark_delivered').then(() => {})
        count()
      }).subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [couple, user])

  // push arrived while the app is open: nothing to show (UI already live), but SW may ask us to refresh calls
  useEffect(() => {
    const h = (e: MessageEvent) => { if (e.data?.type === 'incoming-call-push') { /* calls table realtime already rings */ } }
    navigator.serviceWorker?.addEventListener('message', h)
    return () => navigator.serviceWorker?.removeEventListener('message', h)
  }, [])

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><h1>2 Fold <span>🌎💕</span></h1><p>A little world made for two.</p></div>
        <nav aria-label="Main">
          {[...NAV, { to: '/calls', label: 'Calls', icon: 'phone' }, { to: '/settings', label: 'Settings', icon: 'settings' }].map((n) => (
            <NavLink key={n.to} to={n.to} end={'end' in n ? n.end : false}>
              <Icon name={n.icon} />{n.label}{n.to === '/chat' && unread > 0 && <b className="badge">{unread}</b>}
            </NavLink>
          ))}
        </nav>
        <div className="side-foot"><span className={`dot ${partnerOnline ? 'on' : ''}`} />{couple?.partner?.display_name} · {partnerOnline ? 'online' : 'offline'}</div>
      </aside>

      <header className="top">
        <div className="top-brand">2 Fold <span>🌎💕</span></div>
        <div className="top-actions">
          <span className="presence"><span className={`dot ${partnerOnline ? 'on' : ''}`} />{partnerOnline ? 'Online' : 'Offline'}</span>
          <button className="icon-btn" aria-label="Voice call" disabled={!connected || call.phase !== 'idle'} onClick={() => call.startCall('voice')}><Icon name="phone" /></button>
          <button className="icon-btn" aria-label="Video call" disabled={!connected || call.phase !== 'idle'} onClick={() => call.startCall('video')}><Icon name="video" /></button>
          <Link className="icon-btn mobile-only" to="/settings" aria-label="Settings"><Icon name="settings" /></Link>
        </div>
      </header>
      {!online && <div className="banner">You’re offline. Messages will send once you’re back online.</div>}
      {online && !connected && <div className="banner soft">Connecting to live updates…</div>}

      <main className="main"><Outlet /></main>
      <MiniPlayer />
      <nav className="tabbar" aria-label="Primary">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={'end' in n ? n.end : false}>
            <Icon name={n.icon} /><span>{n.label}</span>{n.to === '/chat' && unread > 0 && <b className="badge">{unread}</b>}
          </NavLink>
        ))}
      </nav>
      <CallOverlay />
    </div>
  )
}
