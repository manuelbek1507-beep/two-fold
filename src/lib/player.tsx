// One app-level <audio> element (never recreated on route change) + Media Session integration so playback
// continues when navigating, with the screen off, or with the browser in the background.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { supabase } from './supabase'
import { useAuth } from './auth'
import type { TrackRow } from './types'

interface PlayerCtx {
  tracks: TrackRow[]
  loading: boolean
  index: number
  current: TrackRow | null
  playing: boolean
  buffering: boolean
  position: number
  duration: number
  volume: number
  error: string | null
  unavailable: Set<string>
  reload: () => Promise<void>
  playIndex: (i: number) => Promise<void>
  toggle: () => void
  next: () => void
  prev: () => void
  seek: (t: number) => void
  setVolume: (v: number) => void
}
const Ctx = createContext<PlayerCtx | null>(null)
export const usePlayer = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('usePlayer outside provider')
  return v
}
export const isPlayable = (t: TrackRow) => t.source !== 'link'

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { couple } = useAuth()
  const audio = useRef<HTMLAudioElement>(null)
  const [tracks, setTracks] = useState<TrackRow[]>([])
  const [loading, setLoading] = useState(true)
  const [index, setIndex] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVol] = useState(() => Number(localStorage.getItem('2fold-volume') ?? 0.8))
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set())
  const failures = useRef(0)
  const resumeAfterCall = useRef(false)
  const tracksRef = useRef<TrackRow[]>([]); tracksRef.current = tracks
  const indexRef = useRef(-1); indexRef.current = index

  const reload = useCallback(async () => {
    const { data } = await supabase.from('playlist_tracks').select('*').order('position')
    const rows = (data as TrackRow[]) ?? []
    setTracks(rows); setLoading(false)
    // keep the same track selected if the list was reordered/edited by the partner
    setIndex((i) => {
      const cur = tracksRef.current[i]
      return cur ? rows.findIndex((r) => r.id === cur.id) : i
    })
  }, [])

  useEffect(() => {
    if (!couple) { setTracks([]); setIndex(-1); audio.current?.pause(); return }
    reload()
    const ch = supabase.channel(`playlist:${couple.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'playlist_tracks', filter: `couple_id=eq.${couple.id}` }, () => reload())
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [couple, reload])

  const srcFor = useCallback(async (t: TrackRow): Promise<string | null> => {
    if (t.source === 'upload' && t.storage_path) {
      const { data } = await supabase.storage.from('playlist-audio').createSignedUrl(t.storage_path, 3600)
      return data?.signedUrl ?? null
    }
    return t.source === 'url' ? t.url : null
  }, [])

  const markBad = useCallback((id: string) => setUnavailable((s) => new Set(s).add(id)), [])

  const playIndex = useCallback(async (i: number) => {
    const el = audio.current, t = tracksRef.current[i]
    if (!el || !t) return
    setIndex(i); setError(null); setPosition(0)
    if (!isPlayable(t)) { markBad(t.id); setError(`“${t.title}” is a link and can’t play inside the app.`); return }
    setBuffering(true)
    const src = await srcFor(t)
    if (!src) { markBad(t.id); setBuffering(false); setError(`“${t.title}” is unavailable.`); return }
    el.src = src
    try { await el.play(); failures.current = 0 }
    catch (e) {
      setBuffering(false)
      if ((e as DOMException).name === 'NotAllowedError') setError('Tap play to start (browser blocked autoplay).')
    }
  }, [markBad, srcFor])

  const next = useCallback(() => {
    const list = tracksRef.current; if (!list.length) return
    let i = indexRef.current
    for (let n = 0; n < list.length; n++) { i = (i + 1) % list.length; if (isPlayable(list[i])) return void playIndex(i) }
  }, [playIndex])
  const prev = useCallback(() => {
    const el = audio.current, list = tracksRef.current; if (!el || !list.length) return
    if (el.currentTime > 3) { el.currentTime = 0; return }
    let i = indexRef.current
    for (let n = 0; n < list.length; n++) { i = (i - 1 + list.length) % list.length; if (isPlayable(list[i])) return void playIndex(i) }
  }, [playIndex])
  const toggle = useCallback(() => {
    const el = audio.current; if (!el) return
    if (!el.src) { const i = tracksRef.current.findIndex(isPlayable); if (i >= 0) void playIndex(i); return }
    if (el.paused) el.play().catch(() => setError('Could not resume playback.')); else el.pause()
  }, [playIndex])
  const seek = useCallback((t: number) => { if (audio.current && Number.isFinite(t)) audio.current.currentTime = t }, [])
  const setVolume = useCallback((v: number) => { setVol(v); localStorage.setItem('2fold-volume', String(v)); if (audio.current) audio.current.volume = v }, [])

  // element events
  useEffect(() => {
    const el = audio.current; if (!el) return
    el.volume = volume
    const on = (ev: string, fn: () => void) => { el.addEventListener(ev, fn); return () => el.removeEventListener(ev, fn) }
    const offs = [
      on('play', () => setPlaying(true)), on('pause', () => setPlaying(false)),
      on('waiting', () => setBuffering(true)), on('playing', () => { setBuffering(false); setPlaying(true) }),
      on('loadedmetadata', () => setDuration(el.duration || 0)),
      on('timeupdate', () => {
        setPosition(el.currentTime)
        if ('mediaSession' in navigator && Number.isFinite(el.duration) && el.duration > 0) {
          try { navigator.mediaSession.setPositionState({ duration: el.duration, position: el.currentTime, playbackRate: el.playbackRate }) } catch { /* unsupported */ }
        }
      }),
      on('ended', () => next()),
      on('error', async () => {
        const t = tracksRef.current[indexRef.current]; if (!t) return
        // signed URLs expire: try one refresh at the same position before giving up
        if (t.source === 'upload' && failures.current === 0) {
          failures.current = 1
          const at = el.currentTime, src = await srcFor(t)
          if (src) { el.src = src; el.currentTime = at; el.play().catch(() => {}); return }
        }
        markBad(t.id); setBuffering(false)
        setError(`“${t.title}” couldn’t be played (unavailable or unsupported).`)
        if (++failures.current <= tracksRef.current.length) setTimeout(next, 1200)
      }),
    ]
    return () => offs.forEach((o) => o())
  }, [next, markBad, srcFor])  // eslint-disable-line react-hooks/exhaustive-deps

  // Media Session: lock-screen / notification controls and metadata
  const current = index >= 0 ? tracks[index] ?? null : null
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    ms.metadata = current ? new MediaMetadata({
      title: current.title, artist: current.artist || '2 Fold', album: 'Our Playlist',
      artwork: current.artwork_url ? [{ src: current.artwork_url, sizes: '512x512' }] : [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    }) : null
    ms.playbackState = playing ? 'playing' : 'paused'
  }, [current, playing])
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => { try { ms.setActionHandler(a, h) } catch { /* unsupported */ } }
    set('play', () => audio.current?.play()); set('pause', () => audio.current?.pause())
    set('previoustrack', prev); set('nexttrack', next)
    set('seekto', (d) => { if (d.seekTime != null) seek(d.seekTime) })
    set('seekbackward', (d) => seek((audio.current?.currentTime ?? 0) - (d.seekOffset ?? 10)))
    set('seekforward', (d) => seek((audio.current?.currentTime ?? 0) + (d.seekOffset ?? 10)))
    return () => (['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward'] as MediaSessionAction[]).forEach((a) => set(a, null))
  }, [next, prev, seek])

  // audio focus: pause music during a call, resume afterwards
  useEffect(() => {
    const h = (e: Event) => {
      const active = (e as CustomEvent).detail.active as boolean, el = audio.current; if (!el) return
      if (active && !el.paused) { resumeAfterCall.current = true; el.pause() }
      if (!active && resumeAfterCall.current) { resumeAfterCall.current = false; el.play().catch(() => {}) }
    }
    window.addEventListener('twofold:call', h)
    return () => window.removeEventListener('twofold:call', h)
  }, [])

  const value = useMemo<PlayerCtx>(() => ({
    tracks, loading, index, current, playing, buffering, position, duration, volume, error, unavailable,
    reload, playIndex, toggle, next, prev, seek, setVolume,
  }), [tracks, loading, index, current, playing, buffering, position, duration, volume, error, unavailable, reload, playIndex, toggle, next, prev, seek, setVolume])

  return <Ctx.Provider value={value}>{children}<audio ref={audio} preload="metadata" playsInline /></Ctx.Provider>
}
