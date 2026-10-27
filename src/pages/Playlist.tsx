import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { isPlayable, usePlayer } from '../lib/player'
import { formatDuration } from '../lib/callState'
import { fileExt, mb, uuid } from '../lib/format'
import { Icon } from '../components/Icon'

const AUDIO = ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/flac', 'audio/x-m4a']
const MAX = 25 * 1048576
const httpsOnly = (u: string) => { try { return new URL(u).protocol === 'https:' } catch { return false } }

export default function Playlist() {
  const { user, couple } = useAuth()
  const p = usePlayer()
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [url, setUrl] = useState('')
  const [art, setArt] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const nextPos = () => (p.tracks.length ? p.tracks[p.tracks.length - 1].position + 1 : 1)

  async function add(kind: 'url' | 'link' | 'upload', file?: File) {
    if (!user || !couple) return
    if (!title.trim()) return setMsg('Give the song a title.')
    if (art && !httpsOnly(art)) return setMsg('Artwork must be an https:// image link.')
    if (kind !== 'upload' && !httpsOnly(url)) return setMsg('Paste an https:// link.')
    setBusy(true); setMsg(null)
    let storage_path: string | null = null
    if (kind === 'upload' && file) {
      if (!AUDIO.includes(file.type)) { setBusy(false); return setMsg('Unsupported audio type.') }
      if (file.size > MAX) { setBusy(false); return setMsg(`Audio files can be up to ${mb(MAX)}.`) }
      storage_path = `${couple.id}/${user.id}/${uuid()}.${fileExt(file.name)}`
      const up = await supabase.storage.from('playlist-audio').upload(storage_path, file, { contentType: file.type, upsert: false })
      if (up.error) { setBusy(false); return setMsg('Upload failed. Please try again.') }
    }
    const { error } = await supabase.from('playlist_tracks').insert({
      couple_id: couple.id, added_by: user.id, title: title.trim(), artist: artist.trim(), source: kind,
      url: kind === 'upload' ? null : url.trim(), storage_path, artwork_url: art.trim() || null, position: nextPos(),
    })
    setBusy(false)
    if (error) { if (storage_path) await supabase.storage.from('playlist-audio').remove([storage_path]); return setMsg('Couldn’t add the song.') }
    setTitle(''); setArtist(''); setUrl(''); setArt(''); if (fileRef.current) fileRef.current.value = ''
    await p.reload()
  }

  async function remove(i: number) {
    const t = p.tracks[i]; if (!confirm(`Remove “${t.title}”?`)) return
    const { error } = await supabase.from('playlist_tracks').delete().eq('id', t.id)
    if (error) return setMsg('Couldn’t remove it.')
    if (t.storage_path && t.added_by === user?.id) await supabase.storage.from('playlist-audio').remove([t.storage_path])
    await p.reload()
  }
  async function move(i: number, dir: -1 | 1) {
    const a = p.tracks[i], b = p.tracks[i + dir]; if (!a || !b) return
    // swap positions
    const r1 = await supabase.from('playlist_tracks').update({ position: b.position }).eq('id', a.id)
    const r2 = await supabase.from('playlist_tracks').update({ position: a.position }).eq('id', b.id)
    if (r1.error || r2.error) setMsg('Couldn’t reorder.')
    await p.reload()
  }

  return (
    <div className="page">
      <h2 className="title">🎵 Our Playlist</h2>
      <section className="panel player-card">
        {p.current ? <>
          <b>{p.current.title}</b><small className="muted">{p.current.artist}</small>
          <input type="range" min={0} max={p.duration || 0} step={1} value={Math.min(p.position, p.duration || 0)} onChange={(e) => p.seek(Number(e.target.value))} aria-label="Seek" />
          <div className="row between"><small>{formatDuration(p.position)}</small><small>{formatDuration(p.duration)}</small></div>
        </> : <p className="muted">Pick a song to play.</p>}
        <div className="row center">
          <button className="icon-btn" onClick={p.prev} aria-label="Previous"><Icon name="prev" /></button>
          <button className="icon-btn accent big" onClick={p.toggle} aria-label={p.playing ? 'Pause' : 'Play'}><Icon name={p.playing ? 'pause' : 'play'} /></button>
          <button className="icon-btn" onClick={p.next} aria-label="Next"><Icon name="next" /></button>
        </div>
        <label className="row"><Icon name="speaker-low" /><input type="range" min={0} max={1} step={0.05} value={p.volume} onChange={(e) => p.setVolume(Number(e.target.value))} aria-label="Volume" /></label>
        {p.error && <p className="error" role="alert">{p.error}</p>}
        <p className="muted small">Music keeps playing when you switch pages. With the screen off it relies on your phone allowing background audio — installed app and uploaded or direct-link audio work best.</p>
      </section>

      <section className="panel">
        <h3>Add a song 🎶</h3>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Song title" aria-label="Song title" />
        <input value={artist} onChange={(e) => setArtist(e.target.value)} maxLength={200} placeholder="Artist" aria-label="Artist" />
        <input value={art} onChange={(e) => setArt(e.target.value)} placeholder="Artwork image link (optional, https)" aria-label="Artwork link" />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Direct audio link or any song link (https)" aria-label="Song link" />
        <div className="row">
          <button className="btn" disabled={busy || !url} onClick={() => add('url')}>Add direct audio link</button>
          <button className="btn" disabled={busy || !url} onClick={() => add('link')}>Add as web link</button>
        </div>
        <input ref={fileRef} type="file" hidden accept={AUDIO.join(',')} onChange={(e) => { const f = e.target.files?.[0]; if (f) void add('upload', f) }} />
        <button className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}><Icon name="plus" /> Upload an audio file you own</button>
        <p className="muted small">Only add audio you have the right to use. “Web link” entries (YouTube, Spotify, …) open in their own app because those services don’t allow in-app background playback.</p>
        {msg && <p className="error" role="alert">{msg}</p>}
      </section>

      <section>
        {p.loading ? <p className="muted">Loading…</p> : p.tracks.length === 0 ? <p className="muted center empty">Every song reminds me of us. 🤍</p> :
          <ol className="tracks">{p.tracks.map((t, i) => (
            <li key={t.id} className={`track ${i === p.index ? 'now' : ''} ${p.unavailable.has(t.id) ? 'bad' : ''}`}>
              <div className="art" style={t.artwork_url ? { backgroundImage: `url("${t.artwork_url}")` } : undefined}>{!t.artwork_url && <Icon name="music" />}</div>
              <button className="track-main" onClick={() => isPlayable(t) ? p.playIndex(i) : window.open(t.url!, '_blank', 'noopener,noreferrer')}>
                <b>{t.title}</b><small>{t.artist || '—'}{p.unavailable.has(t.id) ? ' · unavailable' : ''}{t.source === 'link' ? ' · opens externally' : ''}</small>
              </button>
              {t.source === 'link' && <a className="icon-btn" href={t.url!} target="_blank" rel="noopener noreferrer" aria-label="Open link"><Icon name="link" /></a>}
              <div className="track-ctl">
                <button className="icon-btn sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><Icon name="up" /></button>
                <button className="icon-btn sm" disabled={i === p.tracks.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><Icon name="down" /></button>
                <button className="icon-btn sm" onClick={() => remove(i)} aria-label="Remove"><Icon name="trash" /></button>
              </div>
            </li>))}</ol>}
      </section>
    </div>
  )
}
