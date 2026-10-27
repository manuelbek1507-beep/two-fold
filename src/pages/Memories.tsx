import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { Icon } from '../components/Icon'
import { dateLong, fileExt, mb, uuid } from '../lib/format'
import type { MemoryRow } from '../lib/types'

const PAGE = 24
const IMG = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']
const VID = ['video/mp4', 'video/webm', 'video/quicktime']
const MAX = 50 * 1048576
interface Item { m: MemoryRow; url: string }
interface Upload { id: string; name: string; state: 'uploading' | 'done' | 'failed'; error?: string }

export default function Memories() {
  const { user, couple } = useAuth()
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ups, setUps] = useState<Upload[]>([])
  const [caption, setCaption] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [view, setView] = useState<number | null>(null)
  const [editing, setEditing] = useState<{ id: string; caption: string; taken_on: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cursor = useRef<{ taken_on: string; created_at: string } | null>(null)

  const sign = async (rows: MemoryRow[]): Promise<Item[]> => {
    if (!rows.length) return []
    const { data } = await supabase.storage.from('memories').createSignedUrls(rows.map((r) => r.media_path), 3600)
    return rows.map((m, i) => ({ m, url: data?.[i]?.signedUrl ?? '' }))
  }

  const load = useCallback(async (reset: boolean) => {
    setErr(null); if (reset) { setLoading(true); cursor.current = null }
    let q = supabase.from('memories').select('*').order('taken_on', { ascending: false }).order('created_at', { ascending: false }).limit(PAGE)
    if (!reset && cursor.current) q = q.or(`taken_on.lt.${cursor.current.taken_on},and(taken_on.eq.${cursor.current.taken_on},created_at.lt.${cursor.current.created_at})`)
    const { data, error } = await q
    if (error) { setErr('Couldn’t load memories. Please try again.'); setLoading(false); return }
    const rows = (data as MemoryRow[]) ?? []
    const signed = await sign(rows)
    if (rows.length) cursor.current = { taken_on: rows[rows.length - 1].taken_on, created_at: rows[rows.length - 1].created_at }
    setItems((cur) => (reset ? signed : [...cur, ...signed])); setMore(rows.length === PAGE); setLoading(false)
  }, [])
  useEffect(() => { load(true) }, [load])

  async function onFiles(files: FileList | null) {
    if (!files || !user || !couple) return
    for (const f of Array.from(files)) {
      const id = uuid()
      const isImg = IMG.includes(f.type), isVid = VID.includes(f.type)
      if (!isImg && !isVid) { setUps((u) => [...u, { id, name: f.name, state: 'failed', error: 'Unsupported file type' }]); continue }
      if (f.size > MAX) { setUps((u) => [...u, { id, name: f.name, state: 'failed', error: `Larger than ${mb(MAX)}` }]); continue }
      setUps((u) => [...u, { id, name: f.name, state: 'uploading' }])
      const path = `${couple.id}/${user.id}/${uuid()}.${fileExt(f.name)}`
      const up = await supabase.storage.from('memories').upload(path, f, { contentType: f.type, upsert: false })
      if (up.error) { setUps((u) => u.map((x) => (x.id === id ? { ...x, state: 'failed', error: 'Upload failed — tap Add to retry' } : x))); continue }
      const { error } = await supabase.from('memories').insert({
        couple_id: couple.id, created_by: user.id, caption: caption.trim(), taken_on: date, media_path: path,
        media_type: isImg ? 'image' : 'video', mime: f.type, size_bytes: f.size,
      })
      if (error) { await supabase.storage.from('memories').remove([path]); setUps((u) => u.map((x) => (x.id === id ? { ...x, state: 'failed', error: 'Couldn’t save it' } : x))) }
      else setUps((u) => u.map((x) => (x.id === id ? { ...x, state: 'done' } : x)))
    }
    setCaption(''); if (fileRef.current) fileRef.current.value = ''
    await load(true)
  }

  async function save() {
    if (!editing) return
    const { error } = await supabase.from('memories').update({ caption: editing.caption, taken_on: editing.taken_on, updated_at: new Date().toISOString() }).eq('id', editing.id)
    if (error) return setErr('Couldn’t save your changes.')
    setEditing(null); await load(true)
  }
  async function del(it: Item) {
    if (!confirm('Delete this memory for both of you?')) return
    const { error } = await supabase.from('memories').delete().eq('id', it.m.id)
    if (error) return setErr('Couldn’t delete it.')
    await supabase.storage.from('memories').remove([it.m.media_path])
    setView(null); setItems((c) => c.filter((x) => x.m.id !== it.m.id))
  }

  const cur = view !== null ? items[view] : null
  return (
    <div className="page">
      <h2 className="title">📸 Our Memories</h2>
      <section className="panel">
        <h3>Add memories ✨</h3>
        <input value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={1000} placeholder="Caption (optional)" aria-label="Caption" />
        <label className="row">Date <input type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} /></label>
        <input ref={fileRef} type="file" multiple hidden accept={[...IMG, ...VID].join(',')} onChange={(e) => onFiles(e.target.files)} />
        <button className="btn primary" onClick={() => fileRef.current?.click()}><Icon name="plus" /> Choose photos or videos</button>
        <p className="muted small">Photos and videos up to {mb(MAX)}.</p>
        {ups.map((u) => <p key={u.id} className={u.state === 'failed' ? 'error' : 'muted'}>{u.state === 'uploading' ? '⏳ Uploading' : u.state === 'done' ? '✓ Saved' : '✗'} {u.name}{u.error ? ` — ${u.error}` : ''}</p>)}
      </section>
      {err && <p className="error" role="alert">{err}</p>}
      {loading ? <p className="muted">Loading memories…</p> : items.length === 0 ? <p className="muted center empty">🌙 Your little memories live here.</p> : (
        <div className="gallery">
          {items.map((it, i) => (
            <button key={it.m.id} className="tile" onClick={() => setView(i)} aria-label={it.m.caption || `Memory from ${it.m.taken_on}`}>
              {it.m.media_type === 'image' ? <img src={it.url} alt="" loading="lazy" /> : <video src={it.url} preload="metadata" muted />}
              {it.m.media_type === 'video' && <span className="play-badge"><Icon name="play" /></span>}
              <span className="tile-date">{dateLong(it.m.taken_on + 'T12:00:00')}</span>
            </button>
          ))}
        </div>
      )}
      {more && <button className="btn" onClick={() => load(false)}>Load more</button>}

      {cur && (
        <div className="lightbox" role="dialog" aria-modal="true">
          <button className="lb-close" aria-label="Close" onClick={() => { setView(null); setEditing(null) }}><Icon name="x" /></button>
          <div className="lb-media">
            {cur.m.media_type === 'image' ? <img src={cur.url} alt={cur.m.caption} /> : <video src={cur.url} controls autoPlay playsInline />}
          </div>
          <div className="lb-info">
            {editing?.id === cur.m.id ? (
              <>
                <input value={editing.caption} maxLength={1000} onChange={(e) => setEditing({ ...editing, caption: e.target.value })} aria-label="Caption" />
                <input type="date" value={editing.taken_on} onChange={(e) => setEditing({ ...editing, taken_on: e.target.value })} />
                <button className="btn primary" onClick={save}>Save</button> <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              </>
            ) : (
              <>
                <p>{cur.m.caption || <span className="muted">No caption</span>}</p>
                <small className="muted">{dateLong(cur.m.taken_on + 'T12:00:00')}</small>
                {cur.m.created_by === user?.id && (
                  <div className="row"><button className="btn" onClick={() => setEditing({ id: cur.m.id, caption: cur.m.caption, taken_on: cur.m.taken_on })}><Icon name="edit" /> Edit</button>
                    <button className="btn danger" onClick={() => del(cur)}><Icon name="trash" /> Delete</button></div>
                )}
              </>
            )}
            <div className="row">
              <button className="btn" disabled={view === 0} onClick={() => setView((v) => (v ?? 1) - 1)}>‹ Newer</button>
              <button className="btn" disabled={view === items.length - 1} onClick={() => setView((v) => (v ?? 0) + 1)}>Older ›</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
