import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { dateTime } from '../lib/format'
import { Icon } from '../components/Icon'
import type { LetterRow } from '../lib/types'

type Tab = 'inbox' | 'mine' | 'write'
const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso), p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const isLocked = (l: LetterRow) => l.status === 'sent' && !!l.unlock_at && new Date(l.unlock_at) > new Date()

export default function Letters() {
  const { user, couple } = useAuth()
  const [tab, setTab] = useState<Tab>('inbox')
  const [inbox, setInbox] = useState<LetterRow[]>([])
  const [mine, setMine] = useState<LetterRow[]>([])
  const [open, setOpen] = useState<LetterRow | null>(null)
  const [edit, setEdit] = useState<{ id: string | null; title: string; body: string; when: string } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [, tick] = useState(0)
  const partner = couple?.partner?.display_name ?? 'Your person'

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.rpc('inbox_letters'),
      supabase.from('letters').select('id,author_id,title,body,status,sent_at,unlock_at,read_at,updated_at').order('updated_at', { ascending: false }),
    ])
    if (a.error || b.error) setMsg('Couldn’t load letters.')
    setInbox((a.data as LetterRow[]) ?? []); setMine((b.data as LetterRow[]) ?? [])
  }, [])
  useEffect(() => { load() }, [load])
  // re-ask the SERVER when an unlock time passes (the countdown is cosmetic; the server decides access)
  useEffect(() => {
    const t = setInterval(() => { tick((n) => n + 1); if (inbox.some((l) => l.is_locked && l.unlock_at && new Date(l.unlock_at) <= new Date())) load() }, 15000)
    return () => clearInterval(t)
  }, [inbox, load])

  async function read(l: LetterRow) {
    if (l.is_locked) return
    setOpen(l)
    if (!l.read_at) { await supabase.rpc('mark_letter_read', { p_id: l.id }); setInbox((c) => c.map((x) => (x.id === l.id ? { ...x, read_at: new Date().toISOString() } : x))) }
  }

  async function persist(send: boolean) {
    if (!edit || !user || !couple) return
    if (send && !edit.body.trim()) return setMsg('Write something first 💌')
    const unlock = edit.when ? new Date(edit.when) : null
    if (send && unlock && unlock.getTime() <= Date.now() + 30000) return setMsg('Choose a time in the future, or clear it to send now.')
    setBusy(true); setMsg(null)
    const fields = { title: edit.title.trim(), body: edit.body, unlock_at: unlock ? unlock.toISOString() : null, status: send ? 'sent' : 'draft' }
    const { error } = edit.id
      ? await supabase.from('letters').update(fields).eq('id', edit.id)
      : await supabase.from('letters').insert({ ...fields, couple_id: couple.id, author_id: user.id })
    setBusy(false)
    if (error) return setMsg(error.message.includes('delivered') ? 'This letter has already been delivered and can’t be changed.' : 'Couldn’t save the letter.')
    setEdit(null); setTab('mine'); await load()
    setMsg(send ? (unlock ? `Scheduled for ${dateTime(unlock.toISOString())}.` : 'Sent 💌') : 'Draft saved.')
  }
  async function cancelSchedule(l: LetterRow) {
    const { error } = await supabase.from('letters').update({ status: 'draft' }).eq('id', l.id)
    setMsg(error ? 'Couldn’t cancel — it may have just been delivered.' : 'Schedule cancelled — back in drafts.'); await load()
  }
  async function del(l: LetterRow) {
    if (!confirm('Delete this letter?')) return
    const { error } = await supabase.from('letters').delete().eq('id', l.id)
    setMsg(error ? 'Delivered letters can’t be deleted.' : null); await load()
  }

  const state = (l: LetterRow) => l.status === 'draft' ? 'Draft' : isLocked(l) ? `Scheduled · opens ${dateTime(l.unlock_at!)}` : l.read_at ? 'Delivered · read' : 'Delivered'
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

  return (
    <div className="page">
      <h2 className="title">💌 Our Letters</h2>
      <div className="tabs" role="tablist">
        {(['inbox', 'mine', 'write'] as Tab[]).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''}
          onClick={() => { setTab(t); setOpen(null); if (t === 'write' && !edit) setEdit({ id: null, title: '', body: '', when: '' }) }}>
          {t === 'inbox' ? `From ${partner}` : t === 'mine' ? 'My letters' : 'Write'}</button>)}
      </div>
      {msg && <p className="success" role="status" onClick={() => setMsg(null)}>{msg}</p>}

      {tab === 'inbox' && !open && (inbox.length === 0 ? <p className="muted center empty">Letters from {partner} will appear here. 💕</p> :
        inbox.map((l) => (
          <button key={l.id} className={`letter ${l.is_locked ? 'locked' : ''} ${!l.read_at && !l.is_locked ? 'unread' : ''}`} onClick={() => read(l)} disabled={l.is_locked}>
            {l.is_locked ? <><Icon name="lock" /><b>A letter is waiting for you</b><small>Opens {dateTime(l.unlock_at!)}</small></>
              : <><Icon name="mail" /><b>{l.title || 'Untitled letter'}</b><small>{dateTime(l.unlock_at ?? l.sent_at!)}{!l.read_at && ' · new'}</small></>}
          </button>)))}
      {tab === 'inbox' && open && (
        <article className="panel letter-open"><button className="link" onClick={() => setOpen(null)}>← Back</button>
          <h3>{open.title || 'Untitled letter'}</h3><p className="pre">{open.body}</p><small className="muted">{dateTime(open.unlock_at ?? open.sent_at!)}</small></article>)}

      {tab === 'mine' && (mine.length === 0 ? <p className="muted center empty">Nothing written yet.</p> : mine.map((l) => (
        <div key={l.id} className="letter-row panel">
          <b>{l.title || 'Untitled letter'}</b><small className="muted">{state(l)}</small>
          <p className="pre clip">{l.body}</p>
          <div className="row">
            {(l.status === 'draft' || isLocked(l)) && <button className="btn" onClick={() => { if (isLocked(l)) { void cancelSchedule(l) } else setEdit({ id: l.id, title: l.title, body: l.body ?? '', when: toLocalInput(l.unlock_at) }) ; if (l.status === 'draft') setTab('write') }}>
              <Icon name="edit" /> {isLocked(l) ? 'Cancel & edit' : 'Edit'}</button>}
            {(l.status === 'draft' || isLocked(l)) && <button className="btn danger" onClick={() => del(l)}><Icon name="trash" /> Delete</button>}
          </div>
        </div>)))}

      {tab === 'write' && edit && (
        <section className="panel">
          <input value={edit.title} maxLength={200} placeholder="Title…" aria-label="Title" onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
          <textarea rows={9} maxLength={20000} value={edit.body} placeholder="Write what’s on your heart…" aria-label="Letter" onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
          <label className="row">Unlock at (optional)
            <input type="datetime-local" value={edit.when} onChange={(e) => setEdit({ ...edit, when: e.target.value })} /></label>
          <p className="muted small">Your time zone: {tz}. The server keeps it locked until that exact moment — {partner} can’t read it earlier, even by changing their clock.</p>
          <div className="row"><button className="btn" disabled={busy} onClick={() => persist(false)}>Save draft</button>
            <button className="btn primary" disabled={busy} onClick={() => persist(true)}>{edit.when ? 'Schedule 💌' : 'Send now 💌'}</button>
            {edit.id && <button className="link" onClick={() => setEdit({ id: null, title: '', body: '', when: '' })}>New letter</button>}</div>
        </section>)}
    </div>
  )
}
