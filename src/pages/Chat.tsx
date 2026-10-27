import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useE2EE } from '../lib/e2ee'
import { useCoupleChannel } from '../lib/channel'
import { decryptBytes, encryptBytes } from '../lib/crypto'
import { dayLabel, mb, timeOnly, uuid } from '../lib/format'
import { Icon } from '../components/Icon'
import type { AttachmentMeta, MessageKind, MessagePayload, MessageRow } from '../lib/types'

const PAGE = 30
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime']
const MAX_IMAGE = 10 * 1048576, MAX_VIDEO = 24 * 1048576, MAX_VOICE_SECONDS = 300
const EMOJI = ['😊', '😘', '🥰', '😂', '😭', '🤍', '💕', '💋', '🌙', '✨', '🫂', '🔥', '🥺', '😴', '🌎', '🎶']

interface Msg {
  key: string            // client_id (stable across pending -> sent)
  id: string | null
  mine: boolean
  kind: MessageKind
  createdAt: string
  payload: MessagePayload | null
  problem: 'not-for-this-device' | 'decrypt' | null
  status: 'sending' | 'failed' | 'sent'
  replyTo: string | null
  deliveredAt: string | null
  readAt: string | null
  retry?: () => void
}

function Attachment({ meta, kind }: { meta: AttachmentMeta; kind: MessageKind }) {
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let revoked = false, made: string | null = null
    ;(async () => {
      try {
        const { data, error } = await supabase.storage.from('chat-media').download(meta.path)
        if (error || !data) throw error
        const plain = await decryptBytes(new Uint8Array(await data.arrayBuffer()), meta.key)
        if (revoked) return
        made = URL.createObjectURL(new Blob([plain as unknown as BlobPart], { type: meta.mime }))
        setUrl(made)
      } catch { if (!revoked) setErr(true) }
    })()
    return () => { revoked = true; if (made) URL.revokeObjectURL(made) }
  }, [meta])
  if (err) return <p className="att-err">Couldn’t load this attachment.</p>
  if (!url) return <div className="att-skel" aria-busy="true">Decrypting…</div>
  if (kind === 'image') return <img className="att" src={url} alt={meta.name} />
  if (kind === 'video') return <video className="att" src={url} controls playsInline preload="metadata" />
  return <audio className="att-audio" src={url} controls preload="metadata" />
}

export default function Chat() {
  const { user, couple } = useAuth()
  const e2ee = useE2EE()
  const ch = useCoupleChannel()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [text, setText] = useState('')
  const [reply, setReply] = useState<Msg | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [emoji, setEmoji] = useState(false)
  const [typing, setTyping] = useState(false)
  const [recording, setRecording] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const lastTyping = useRef(0)
  const recorder = useRef<{ mr: MediaRecorder; chunks: Blob[]; timer: number; stream: MediaStream } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const msgsRef = useRef<Msg[]>([]); msgsRef.current = msgs

  const toMsg = useCallback(async (row: MessageRow): Promise<Msg> => {
    let payload: MessagePayload | null = null, problem: Msg['problem'] = null
    try { payload = await e2ee.decrypt(row) }
    catch (e) { problem = (e as Error).message === 'not-for-this-device' ? 'not-for-this-device' : 'decrypt' }
    return {
      key: row.client_id, id: row.id, mine: row.sender_id === user?.id, kind: row.kind, createdAt: row.created_at,
      payload, problem, status: 'sent', replyTo: row.reply_to, deliveredAt: row.delivered_at, readAt: row.read_at,
    }
  }, [e2ee, user?.id])

  const markRead = useCallback(() => {
    if (document.visibilityState !== 'visible') return
    const latest = [...msgsRef.current].reverse().find((m) => !m.mine && m.id)
    if (latest && !latest.readAt) supabase.rpc('mark_read', { p_upto: latest.createdAt }).then(() => {})
  }, [])

  // initial load
  useEffect(() => {
    if (!e2ee.ready) return
    let cancelled = false
    ;(async () => {
      setLoading(true); setLoadErr(null)
      const { data, error } = await supabase.from('messages').select('*').order('created_at', { ascending: false }).limit(PAGE)
      if (cancelled) return
      if (error) { setLoadErr('Couldn’t load messages. Check your connection and try again.'); setLoading(false); return }
      const rows = ((data as MessageRow[]) ?? []).reverse()
      const list = await Promise.all(rows.map(toMsg))
      if (cancelled) return
      setMsgs(list); setHasMore((data?.length ?? 0) === PAGE); setLoading(false)
    })()
    return () => { cancelled = true }
  }, [e2ee.ready, toMsg])

  // realtime: inserts / receipts / deletes (RLS filters these to our couple)
  useEffect(() => {
    if (!e2ee.ready || !couple) return
    const sub = supabase.channel(`chat-db:${couple.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `couple_id=eq.${couple.id}` }, async (p) => {
        const row = p.new as MessageRow
        if (msgsRef.current.some((m) => m.key === row.client_id && m.status === 'sent')) return
        const m = await toMsg(row)
        setMsgs((cur) => cur.some((x) => x.key === m.key) ? cur.map((x) => (x.key === m.key ? m : x)) : [...cur, m])
        if (!m.mine) { setTyping(false); setTimeout(markRead, 100) }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `couple_id=eq.${couple.id}` }, (p) => {
        const row = p.new as MessageRow
        setMsgs((cur) => cur.map((m) => (m.id === row.id ? { ...m, deliveredAt: row.delivered_at, readAt: row.read_at } : m)))
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (p) => {
        const id = (p.old as { id?: string }).id
        if (id) setMsgs((cur) => cur.filter((m) => m.id !== id))
      })
      .subscribe()
    return () => { supabase.removeChannel(sub) }
  }, [e2ee.ready, couple, toMsg, markRead])

  // typing indicator from partner
  useEffect(() => {
    let t: number
    const off = ch.on('typing', () => { setTyping(true); clearTimeout(t); t = window.setTimeout(() => setTyping(false), 4000) })
    return () => { off(); clearTimeout(t) }
  }, [ch])

  useEffect(() => { markRead() }, [msgs.length, markRead])
  useEffect(() => { const h = () => markRead(); document.addEventListener('visibilitychange', h); return () => document.removeEventListener('visibilitychange', h) }, [markRead])

  useLayoutEffect(() => { if (stick.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight }, [msgs, typing])

  async function loadEarlier() {
    const first = msgs.find((m) => m.status === 'sent'); if (!first) return
    setLoadingMore(true)
    const el = listRef.current, prevH = el?.scrollHeight ?? 0
    const { data, error } = await supabase.from('messages').select('*').lt('created_at', first.createdAt).order('created_at', { ascending: false }).limit(PAGE)
    if (error) { setNotice('Couldn’t load earlier messages.'); setLoadingMore(false); return }
    const older = await Promise.all(((data as MessageRow[]) ?? []).reverse().map(toMsg))
    stick.current = false
    setMsgs((cur) => [...older, ...cur]); setHasMore((data?.length ?? 0) === PAGE); setLoadingMore(false)
    requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - prevH })
  }

  /** Core send: encrypt once, then (re)try the same ciphertext + client id (the server de-duplicates). */
  async function dispatch(kind: MessageKind, payload: MessagePayload, replyTo: Msg | null, existingKey?: string, packet?: Awaited<ReturnType<typeof e2ee.encrypt>>) {
    const clientId = existingKey ?? uuid()
    const base: Msg = {
      key: clientId, id: null, mine: true, kind, createdAt: new Date().toISOString(), payload, problem: null,
      status: 'sending', replyTo: replyTo?.id ?? null, deliveredAt: null, readAt: null,
    }
    setMsgs((cur) => cur.some((m) => m.key === clientId) ? cur.map((m) => (m.key === clientId ? { ...m, status: 'sending', retry: undefined } : m)) : [...cur, base])
    stick.current = true
    try {
      const pkt = packet ?? await e2ee.encrypt(payload, clientId, kind)
      const { data, error } = await supabase.rpc('send_message', {
        p_client_id: clientId, p_kind: kind, p_ciphertext: pkt.ciphertext, p_iv: pkt.iv,
        p_sender_device: e2ee.device!.deviceId, p_reply_to: replyTo?.id ?? null, p_keys: pkt.keys,
      })
      if (error) throw error
      const row = data as MessageRow
      setMsgs((cur) => cur.map((m) => (m.key === clientId ? { ...m, id: row.id, createdAt: row.created_at, status: 'sent', retry: undefined } : m)))
    } catch {
      setMsgs((cur) => cur.map((m) => (m.key === clientId ? { ...m, status: 'failed', retry: () => dispatch(kind, payload, replyTo, clientId, packet) } : m)))
    }
  }

  function submit() {
    const t = text.trim(); if (!t || !e2ee.ready) return
    const r = reply
    setText(''); setReply(null); setEmoji(false)
    void dispatch('text', { text: t }, r)
  }

  async function sendBlob(blob: Blob | File, kind: MessageKind, name: string, seconds?: number) {
    const r = reply; setReply(null)
    const clientId = uuid()
    // show an optimistic "sending" bubble immediately
    setMsgs((cur) => [...cur, { key: clientId, id: null, mine: true, kind, createdAt: new Date().toISOString(), payload: { text: `Sending ${name}…` }, problem: null, status: 'sending', replyTo: r?.id ?? null, deliveredAt: null, readAt: null }])
    stick.current = true
    const attempt = async () => {
      try {
        const { blob: enc, key } = await encryptBytes(new Uint8Array(await blob.arrayBuffer()))
        const path = `${couple!.id}/${user!.id}/${uuid()}`
        const up = await supabase.storage.from('chat-media').upload(path, new Blob([enc as unknown as BlobPart], { type: 'application/octet-stream' }), { contentType: 'application/octet-stream', upsert: false })
        if (up.error) throw up.error
        const payload: MessagePayload = { attachment: { path, key, mime: blob.type || 'application/octet-stream', name, size: blob.size, seconds } }
        setMsgs((cur) => cur.filter((m) => m.key !== clientId))
        await dispatch(kind, payload, r)
      } catch {
        setMsgs((cur) => cur.map((m) => (m.key === clientId ? { ...m, status: 'failed', payload: { text: `Couldn’t send ${name}` }, retry: () => { setMsgs((c) => c.map((x) => (x.key === clientId ? { ...x, status: 'sending', retry: undefined } : x))); void attempt() } } : m)))
      }
    }
    void attempt()
  }

  function onPick(files: FileList | null) {
    const f = files?.[0]; if (!f) return
    if (IMAGE_TYPES.includes(f.type)) { if (f.size > MAX_IMAGE) return setNotice(`Photos can be up to ${mb(MAX_IMAGE)}.`); void sendBlob(f, 'image', f.name) }
    else if (VIDEO_TYPES.includes(f.type)) { if (f.size > MAX_VIDEO) return setNotice(`Videos can be up to ${mb(MAX_VIDEO)}.`); void sendBlob(f, 'video', f.name) }
    else setNotice('Only JPEG, PNG, WebP, GIF photos and MP4, WebM, MOV videos can be sent.')
    if (fileRef.current) fileRef.current.value = ''
  }

  async function toggleRecord() {
    if (recorder.current) { recorder.current.mr.stop(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t))
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      const chunks: Blob[] = []; const started = Date.now()
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      mr.onstop = () => {
        clearInterval(recorder.current?.timer); stream.getTracks().forEach((t) => t.stop())
        const seconds = Math.round((Date.now() - started) / 1000); recorder.current = null; setRecording(null)
        if (seconds >= 1) void sendBlob(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }), 'voice', 'voice-note', seconds)
      }
      const timer = window.setInterval(() => {
        const s = Math.round((Date.now() - started) / 1000); setRecording(s)
        if (s >= MAX_VOICE_SECONDS) mr.stop()
      }, 500)
      recorder.current = { mr, chunks, timer, stream }; setRecording(0); mr.start()
    } catch { setNotice('Microphone permission is needed to record a voice note.') }
  }

  async function remove(m: Msg) {
    if (!m.id) return setMsgs((c) => c.filter((x) => x.key !== m.key))
    const { error } = await supabase.from('messages').delete().eq('id', m.id)
    if (error) setNotice('Couldn’t delete that message.'); else setMsgs((c) => c.filter((x) => x.key !== m.key))
    setSelected(null)
  }

  const find = (id: string | null) => (id ? msgs.find((m) => m.id === id) : undefined)
  const snippet = (m?: Msg) => !m ? 'Earlier message' : m.payload?.text ?? (m.kind === 'image' ? '📷 Photo' : m.kind === 'video' ? '🎬 Video' : m.kind === 'voice' ? '🎤 Voice note' : '🔒 Message')

  if (e2ee.error) return <div className="page"><p className="error">Couldn’t set up encryption on this device: {e2ee.error}</p></div>
  if (!e2ee.ready) return <div className="page"><p className="muted">Setting up secure messaging…</p></div>

  let lastDay = ''
  return (
    <div className="chat">
      <div className="chat-list" ref={listRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
        {hasMore && <button className="link center" onClick={loadEarlier} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load earlier messages'}</button>}
        {loading && <p className="muted center">Loading messages…</p>}
        {loadErr && <p className="error center">{loadErr} <button className="link" onClick={() => location.reload()}>Retry</button></p>}
        {!loading && !loadErr && msgs.length === 0 && <p className="muted center empty">🫂 Your first message is waiting here.<br /><small>Messages are end-to-end encrypted.</small></p>}
        {msgs.map((m) => {
          const day = dayLabel(m.createdAt); const showDay = day !== lastDay; lastDay = day
          const rep = m.replyTo ? find(m.replyTo) : undefined
          return (
            <div key={m.key}>
              {showDay && <div className="day">{day}</div>}
              <div className={`bubble ${m.mine ? 'sent' : 'received'} ${m.status}`} onClick={() => setSelected(selected === m.key ? null : m.key)}>
                {m.replyTo && <blockquote>{snippet(rep)}</blockquote>}
                {m.problem === 'not-for-this-device' ? <p className="locked"><Icon name="lock" /> Sent before this device was set up, so it can’t be shown here.</p>
                  : m.problem ? <p className="locked"><Icon name="lock" /> This message couldn’t be decrypted.</p>
                  : m.payload?.attachment ? (<><Attachment meta={m.payload.attachment} kind={m.kind} />{m.payload.text && <p>{m.payload.text}</p>}</>)
                  : <p>{m.payload?.text}</p>}
                <small>{timeOnly(m.createdAt)}{m.mine && (
                  m.status === 'sending' ? <span className="tick">…</span>
                    : m.status === 'failed' ? <span className="tick fail">!</span>
                    : <span className={`tick ${m.readAt ? 'read' : ''}`}>{m.deliveredAt || m.readAt ? '✓✓' : '✓'}</span>)}</small>
                {m.status === 'failed' && <button className="link" onClick={(e) => { e.stopPropagation(); m.retry?.() }}>Not sent · Tap to retry</button>}
              </div>
              {selected === m.key && m.status === 'sent' && (
                <div className={`bubble-actions ${m.mine ? 'sent' : ''}`}>
                  <button onClick={() => { setReply(m); setSelected(null) }}><Icon name="reply" /> Reply</button>
                  {m.mine && <button onClick={() => remove(m)}><Icon name="trash" /> Delete</button>}
                </div>
              )}
            </div>
          )
        })}
        {typing && <div className="typing" aria-live="polite">{couple?.partner?.display_name} is typing…</div>}
      </div>

      {notice && <div className="toast" role="status" onClick={() => setNotice(null)}>{notice}</div>}
      {reply && <div className="reply-bar"><Icon name="reply" /><span>{snippet(reply)}</span><button aria-label="Cancel reply" onClick={() => setReply(null)}><Icon name="x" /></button></div>}
      {emoji && <div className="emoji-tray">{EMOJI.map((e) => <button key={e} onClick={() => setText((t) => t + e)}>{e}</button>)}</div>}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <input ref={fileRef} type="file" hidden accept={[...IMAGE_TYPES, ...VIDEO_TYPES].join(',')} onChange={(e) => onPick(e.target.files)} />
        <button type="button" className="icon-btn" aria-label="Attach photo or video" onClick={() => fileRef.current?.click()}><Icon name="clip" /></button>
        <button type="button" className="icon-btn" aria-label="Emoji" onClick={() => setEmoji((v) => !v)}>😊</button>
        {recording !== null ? <div className="recording"><span className="rec-dot" />Recording {recording}s · tap ■ to send</div>
          : <input value={text} maxLength={4000} placeholder="Write something sweet…" aria-label="Message"
              onChange={(e) => { setText(e.target.value); if (Date.now() - lastTyping.current > 2500) { lastTyping.current = Date.now(); ch.send('typing') } }} />}
        {text.trim() || recording !== null ? (recording !== null
          ? <button type="button" className="icon-btn accent" aria-label="Stop and send voice note" onClick={toggleRecord}>■</button>
          : <button className="icon-btn accent" aria-label="Send"><Icon name="send" /></button>)
          : <button type="button" className="icon-btn" aria-label="Record voice note" onClick={toggleRecord}><Icon name="mic" /></button>}
      </form>
    </div>
  )
}
