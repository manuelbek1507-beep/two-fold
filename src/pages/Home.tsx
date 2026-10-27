import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useCoupleChannel } from '../lib/channel'
import { usePlayer } from '../lib/player'
import { Icon } from '../components/Icon'
import { dateTime } from '../lib/format'
import { formatDuration } from '../lib/callState'
import type { CallRow, MemoryRow } from '../lib/types'

function greeting(name: string) {
  const h = new Date().getHours()
  return `${h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}, ${name}`
}

export default function Home() {
  const { couple, user } = useAuth()
  const { partnerOnline } = useCoupleChannel()
  const player = usePlayer()
  const [mem, setMem] = useState<{ m: MemoryRow; url: string }[]>([])
  const [unreadLetters, setUnreadLetters] = useState(0)
  const [lastCall, setLastCall] = useState<CallRow | null>(null)
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    if (!user) return
    ;(async () => {
      const { data } = await supabase.from('memories').select('*').order('taken_on', { ascending: false }).order('created_at', { ascending: false }).limit(3)
      const rows = (data as MemoryRow[]) ?? []
      const imgs = rows.filter((r) => r.media_type === 'image')
      const { data: signed } = imgs.length ? await supabase.storage.from('memories').createSignedUrls(imgs.map((r) => r.media_path), 3600) : { data: [] }
      setMem(imgs.map((m, i) => ({ m, url: signed?.[i]?.signedUrl ?? '' })).filter((x) => x.url))
      const { data: inbox } = await supabase.rpc('inbox_letters')
      setUnreadLetters(((inbox as { read_at: string | null; is_locked: boolean }[]) ?? []).filter((l) => !l.read_at && !l.is_locked).length)
      const { data: calls } = await supabase.from('calls').select('*').eq('state', 'ended').order('created_at', { ascending: false }).limit(5)
      setLastCall(((calls as CallRow[]) ?? []).find((c) => !c.hidden_by.includes(user.id)) ?? null)
      const { count } = await supabase.from('messages').select('id', { count: 'exact', head: true }).neq('sender_id', user.id).is('read_at', null)
      setUnread(count ?? 0)
    })()
  }, [user])

  const partner = couple?.partner?.display_name ?? 'your person'
  return (
    <div className="page">
      <section className="hero">
        <h2>{greeting(couple?.me.display_name ?? 'sweetheart')} <Icon name="heart" className="heart-outline" /></h2>
        <p>Another day, another reason to be grateful for you. You’re my favourite place. <span className="pink">♥</span></p>
        <p className="muted"><span className={`dot ${partnerOnline ? 'on' : ''}`} /> {partner} is {partnerOnline ? 'online now' : 'offline'}</p>
      </section>

      <section className="cards">
        <Link to="/chat" className="dash-card"><Icon name="chat" /><b>Chat</b><small>{unread ? `${unread} new` : 'Talk, always.'}</small></Link>
        <Link to="/memories" className="dash-card"><Icon name="image" /><b>Memories</b><small>Our moments.</small></Link>
        <Link to="/letters" className="dash-card"><Icon name="mail" /><b>Letters</b><small>{unreadLetters ? `${unreadLetters} unread` : 'Words that stay.'}</small></Link>
        <Link to="/playlist" className="dash-card"><Icon name="music" /><b>Playlist</b><small>{player.tracks.length} songs</small></Link>
      </section>

      <section className="panel">
        <div className="panel-head"><h3><Icon name="image" />Recent memories</h3><Link to="/memories" className="link">View all</Link></div>
        {mem.length ? <div className="thumbs">{mem.map(({ m, url }) => <Link key={m.id} to="/memories"><img src={url} alt={m.caption || 'Memory'} loading="lazy" /></Link>)}</div>
          : <p className="muted">Your little memories live here. <Link to="/memories" className="link">Add the first one →</Link></p>}
      </section>

      <section className="panel">
        <div className="panel-head"><h3><Icon name="phone" />Last call</h3><Link to="/calls" className="link">History</Link></div>
        {lastCall ? <p>{lastCall.caller_id === user?.id ? 'You called' : `${partner} called`} · {lastCall.end_reason}
          {lastCall.duration_seconds ? ` · ${formatDuration(lastCall.duration_seconds)}` : ''}<br /><small className="muted">{dateTime(lastCall.created_at)}</small></p>
          : <p className="muted">No calls yet.</p>}
      </section>

      {player.current && (
        <section className="panel"><div className="panel-head"><h3><Icon name="music" />Now playing</h3></div>
          <p><b>{player.current.title}</b> {player.current.artist && <span className="muted">— {player.current.artist}</span>}</p></section>
      )}
      <p className="forever">Forever isn’t long enough ♡</p>
    </div>
  )
}
