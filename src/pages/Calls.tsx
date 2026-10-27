import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useCall } from '../lib/calls'
import { useCoupleChannel } from '../lib/channel'
import { Icon } from '../components/Icon'
import { dateTime } from '../lib/format'
import { formatDuration } from '../lib/callState'
import type { CallRow } from '../lib/types'

export default function Calls() {
  const { user, couple } = useAuth()
  const call = useCall()
  const ch = useCoupleChannel()
  const [rows, setRows] = useState<CallRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('calls').select('*').eq('state', 'ended').order('created_at', { ascending: false }).limit(100)
    if (error) setErr('Couldn’t load call history.')
    setRows(((data as CallRow[]) ?? []).filter((c) => !c.hidden_by.includes(user!.id))); setLoading(false)
  }, [user])
  useEffect(() => { load() }, [load, call.phase])

  async function hide(id: string) {
    const { error } = await supabase.rpc('hide_call', { p_id: id })
    if (error) return setErr('Couldn’t remove it.')
    setRows((r) => r.filter((c) => c.id !== id))
  }
  const label = (c: CallRow) => {
    const out = c.caller_id === user?.id
    switch (c.end_reason) {
      case 'completed': return out ? 'Outgoing · answered' : 'Incoming · answered'
      case 'missed': return out ? 'Outgoing · no answer' : 'Missed'
      case 'declined': return out ? 'Declined by them' : 'You declined'
      case 'cancelled': return out ? 'Cancelled' : 'Missed (cancelled)'
      default: return 'Failed'
    }
  }
  const bad = (c: CallRow) => c.end_reason === 'failed' || (c.end_reason === 'missed' && c.callee_id === user?.id) || (c.end_reason === 'cancelled' && c.callee_id === user?.id)

  return (
    <div className="page">
      <h2 className="title">📞 Calls</h2>
      <div className="row">
        <button className="btn primary" disabled={!ch.connected || call.phase !== 'idle'} onClick={() => call.startCall('voice')}><Icon name="phone" /> Voice call</button>
        <button className="btn primary" disabled={!ch.connected || call.phase !== 'idle'} onClick={() => call.startCall('video')}><Icon name="video" /> Video call</button>
      </div>
      <p className="muted small">Calls are never recorded. Only who called, when, and for how long is kept.</p>
      {err && <p className="error">{err}</p>}
      {loading ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="muted center empty">No calls yet.</p> : (
        <ul className="calls">{rows.map((c) => (
          <li key={c.id} className={bad(c) ? 'bad' : ''}>
            <Icon name={c.caller_id === user?.id ? 'out' : 'in'} />
            <div><b>{c.caller_id === user?.id ? `To ${couple?.partner?.display_name}` : `From ${couple?.partner?.display_name}`}</b>
              <small>{label(c)} · {c.media} · {dateTime(c.created_at)}{c.duration_seconds != null ? ` · ${formatDuration(c.duration_seconds)}` : ''}</small></div>
            <button className="icon-btn sm" aria-label="Remove from my history" onClick={() => hide(c.id)}><Icon name="trash" /></button>
          </li>))}</ul>)}
    </div>
  )
}
