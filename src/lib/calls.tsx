// WebRTC calling. Media is peer-to-peer (TURN-relayed only when needed) and is NEVER recorded.
// Signalling: call lifecycle lives in the `calls` table (RPCs, RLS); SDP/ICE travel over the private
// couple channel, which only the two members can join. Offers are sent only AFTER the callee accepts,
// so nothing is lost if the callee was offline when the call started.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { supabase } from './supabase'
import { useAuth } from './auth'
import { useCoupleChannel } from './channel'
import { canTransition, RING_TIMEOUT_MS, type CallPhase } from './callState'
import type { CallRow } from './types'

interface CallCtx {
  phase: CallPhase
  call: CallRow | null
  isCaller: boolean
  media: 'voice' | 'video'
  muted: boolean
  cameraOff: boolean
  canSwitchCamera: boolean
  elapsed: number
  notice: string | null
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  audioEl: HTMLAudioElement | null
  needsAudioTap: boolean
  startCall: (media: 'voice' | 'video') => Promise<void>
  answer: () => Promise<void>
  reject: () => Promise<void>
  hangup: () => Promise<void>
  toggleMute: () => void
  toggleCamera: () => void
  switchCamera: () => Promise<void>
  resumeAudio: () => void
}
const Ctx = createContext<CallCtx | null>(null)
export const useCall = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useCall outside provider')
  return v
}

async function getIceServers(): Promise<RTCIceServer[]> {
  try {
    const { data, error } = await supabase.functions.invoke('turn-credentials')
    if (!error && data?.iceServers) return data.iceServers as RTCIceServer[]
  } catch { /* fall through */ }
  return [{ urls: 'stun:stun.l.google.com:19302' }]
}

function mediaError(e: unknown): string {
  const name = (e as DOMException)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Permission denied. Allow microphone/camera access in your browser settings, then try again.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone or camera was found on this device.'
  if (name === 'NotReadableError') return 'Your microphone or camera is being used by another app.'
  return 'Could not access the microphone or camera.'
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { user, couple } = useAuth()
  const channel = useCoupleChannel()
  const [phase, setPhaseState] = useState<CallPhase>('idle')
  const [call, setCall] = useState<CallRow | null>(null)
  const [media, setMedia] = useState<'voice' | 'video'>('voice')
  const [muted, setMuted] = useState(false)
  const [cameraOff, setCameraOff] = useState(false)
  const [canSwitchCamera, setCanSwitchCamera] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [needsAudioTap, setNeedsAudioTap] = useState(false)
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null)

  const phaseRef = useRef<CallPhase>('idle')
  const callRef = useRef<CallRow | null>(null)
  const pc = useRef<RTCPeerConnection | null>(null)
  const local = useRef<MediaStream | null>(null)
  const pendingIce = useRef<RTCIceCandidateInit[]>([])
  const timers = useRef<{ ring?: number; tick?: number; lost?: number; reset?: number }>({})
  const ringer = useRef<{ ctx: AudioContext; iv: number } | null>(null)
  const wake = useRef<WakeLockSentinel | null>(null)
  const facing = useRef<'user' | 'environment'>('user')
  const skew = useRef(0)

  const setPhase = useCallback((p: CallPhase) => {
    if (!canTransition(phaseRef.current, p)) return
    phaseRef.current = p; setPhaseState(p)
    window.dispatchEvent(new CustomEvent('twofold:call', { detail: { active: p !== 'idle' && p !== 'ended' } }))
  }, [])
  const setCurrent = useCallback((c: CallRow | null) => { callRef.current = c; setCall(c) }, [])

  // ---------- ringtone (synthesised; no asset needed). Browsers may block audio until the user has interacted.
  const stopRing = useCallback(() => {
    if (ringer.current) { clearInterval(ringer.current.iv); ringer.current.ctx.close().catch(() => {}); ringer.current = null }
    navigator.vibrate?.(0)
  }, [])
  const startRing = useCallback((incoming: boolean) => {
    stopRing()
    try {
      const ctx = new AudioContext()
      const burst = () => {
        for (const [f, t] of [[440, 0], [480, 0]] as const) {
          const o = ctx.createOscillator(), g = ctx.createGain()
          o.frequency.value = f; g.gain.value = 0.06
          o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + 0.9)
        }
        if (incoming) navigator.vibrate?.([400, 200, 400])
      }
      burst()
      ringer.current = { ctx, iv: window.setInterval(burst, 2500) }
    } catch { /* autoplay blocked: visual ring only */ }
  }, [stopRing])

  const cleanup = useCallback((message?: string) => {
    stopRing()
    Object.values(timers.current).forEach((t) => { if (t) { clearTimeout(t); clearInterval(t) } })
    timers.current = {}
    if (pc.current) { pc.current.ontrack = null; pc.current.onicecandidate = null; pc.current.onconnectionstatechange = null; pc.current.close(); pc.current = null }
    local.current?.getTracks().forEach((t) => t.stop())
    local.current = null; setLocalStream(null); setRemoteStream(null)
    pendingIce.current = []
    wake.current?.release().catch(() => {}); wake.current = null
    setMuted(false); setCameraOff(false); setNeedsAudioTap(false)
    if (message) setNotice(message)
    setPhase('ended')
    timers.current.reset = window.setTimeout(() => { setCurrent(null); setElapsed(0); setNotice(null); setPhase('idle') }, 2500)
  }, [setCurrent, setPhase, stopRing])

  const begin = useCallback(async (m: 'voice' | 'video') => {
    // 1. permission first, so a denied prompt never creates a ringing call for the partner
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: m === 'video' ? { facingMode: facing.current, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    })
    local.current = stream; setLocalStream(stream); setMedia(m)
    if (m === 'video') {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
      setCanSwitchCamera(cams.length > 1)
      try { wake.current = (await navigator.wakeLock?.request('screen')) ?? null } catch { /* optional */ }
    } else setCanSwitchCamera(false)
  }, [])

  const makePc = useCallback(async () => {
    const connection = new RTCPeerConnection({ iceServers: await getIceServers() })
    pc.current = connection
    local.current?.getTracks().forEach((t) => connection.addTrack(t, local.current!))
    connection.ontrack = (e) => {
      const s = e.streams[0] ?? new MediaStream([e.track])
      setRemoteStream(s)
    }
    connection.onicecandidate = (e) => {
      if (e.candidate && callRef.current) channel.send('call-ice', { callId: callRef.current.id, candidate: e.candidate.toJSON() })
    }
    connection.onconnectionstatechange = () => {
      const st = connection.connectionState
      if (st === 'connected') {
        clearTimeout(timers.current.lost); setNotice(null)
        setPhase('active')
        if (!timers.current.tick) {
          const started = callRef.current?.answered_at ? new Date(callRef.current.answered_at).getTime() - skew.current : Date.now()
          timers.current.tick = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 500) as unknown as number
        }
      } else if (st === 'disconnected') {
        setPhase('reconnecting'); setNotice('Connection lost. Trying to reconnect…')
        clearTimeout(timers.current.lost)
        timers.current.lost = window.setTimeout(() => endInternal('failed', 'Connection lost.'), 20_000)
      } else if (st === 'failed') {
        endInternal('failed', 'The call could not stay connected.')
      }
    }
    return connection
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, setPhase])

  const flushIce = async () => {
    const list = pendingIce.current; pendingIce.current = []
    for (const c of list) await pc.current?.addIceCandidate(c).catch(() => {})
  }

  const endInternal = useCallback(async (reason: string | null, message: string) => {
    const c = callRef.current
    if (c) {
      try { await supabase.rpc('end_call', { p_id: c.id, p_reason: reason }) } catch { /* DB timeout rules will close it */ }
      channel.send('call-end', { callId: c.id })
    }
    cleanup(message)
  }, [channel, cleanup])

  // ---------- public actions
  const startCall = useCallback(async (m: 'voice' | 'video') => {
    if (phaseRef.current !== 'idle' && phaseRef.current !== 'ended') return
    if (!channel.connected || !channel.partnerOnline) {
      // Partner can still be rung via push; the call row alerts them if the app is open.
      if (!channel.connected) { setNotice('Not connected. Check your internet connection.'); return }
    }
    clearTimeout(timers.current.reset)
    try { await begin(m) } catch (e) { setNotice(mediaError(e)); local.current?.getTracks().forEach((t) => t.stop()); return }
    const { data, error } = await supabase.rpc('start_call', { p_media: m })
    if (error) {
      local.current?.getTracks().forEach((t) => t.stop()); local.current = null; setLocalStream(null)
      setNotice(error.message.includes('call_in_progress') ? 'A call is already in progress.' : 'Could not start the call.')
      return
    }
    setCurrent(data as CallRow); setPhase('outgoing'); startRing(false)
    timers.current.ring = window.setTimeout(() => endInternal('missed', 'No answer.'), RING_TIMEOUT_MS)
  }, [begin, channel, endInternal, setCurrent, setPhase, startRing])

  const answer = useCallback(async () => {
    const c = callRef.current
    if (!c || phaseRef.current !== 'incoming') return
    stopRing(); clearTimeout(timers.current.ring)
    try { await begin(c.media) } catch (e) {
      setNotice(mediaError(e)); await supabase.rpc('end_call', { p_id: c.id }); cleanup(mediaError(e)); return
    }
    const { data, error } = await supabase.rpc('answer_call', { p_id: c.id })
    if (error) { cleanup('This call is no longer available.'); return }
    setCurrent(data as CallRow); setPhase('connecting')
    await makePc()
    await channel.send('call-accept', { callId: c.id })     // caller creates the offer once we are ready
  }, [begin, channel, cleanup, makePc, setCurrent, setPhase, stopRing])

  const reject = useCallback(async () => { await endInternal(null, 'Call declined.') }, [endInternal])
  const hangup = useCallback(async () => { await endInternal(null, 'Call ended.') }, [endInternal])

  const toggleMute = useCallback(() => {
    const tracks = local.current?.getAudioTracks() ?? []
    const nowMuted = tracks.length ? tracks[0].enabled : false   // currently live => becomes muted
    tracks.forEach((t) => { t.enabled = !nowMuted })
    setMuted(nowMuted)
  }, [])
  const toggleCamera = useCallback(() => {
    const t = local.current?.getVideoTracks()[0]; if (!t) return
    t.enabled = !t.enabled; setCameraOff(!t.enabled)
  }, [])
  const switchCamera = useCallback(async () => {
    if (!local.current) return
    const next = facing.current === 'user' ? 'environment' : 'user'
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: next } }, audio: false })
      const nt = s.getVideoTracks()[0]
      const sender = pc.current?.getSenders().find((x) => x.track?.kind === 'video')
      await sender?.replaceTrack(nt)
      local.current.getVideoTracks().forEach((t) => { t.stop(); local.current!.removeTrack(t) })
      local.current.addTrack(nt)
      facing.current = next; setCameraOff(false)
      setLocalStream(new MediaStream(local.current.getTracks()))
    } catch { setNotice('This device could not switch cameras.') }
  }, [])
  const resumeAudio = useCallback(() => { audioEl?.play().then(() => setNeedsAudioTap(false)).catch(() => {}) }, [audioEl])

  // attach remote media to the single <audio> element (audio routing is controlled on this element)
  useEffect(() => {
    if (!audioEl) return
    audioEl.srcObject = remoteStream
    if (remoteStream) audioEl.play().then(() => setNeedsAudioTap(false)).catch(() => setNeedsAudioTap(true))
  }, [remoteStream, audioEl])

  // ---------- inbound: signalling over the private channel
  useEffect(() => {
    const offs = [
      channel.on('call-accept', async ({ callId }) => {
        const c = callRef.current
        if (!c || c.id !== callId || c.caller_id !== user?.id || phaseRef.current !== 'outgoing') return
        stopRing(); clearTimeout(timers.current.ring); setPhase('connecting')
        const connection = await makePc()
        const offer = await connection.createOffer()
        await connection.setLocalDescription(offer)
        channel.send('call-offer', { callId, sdp: connection.localDescription?.toJSON() })
      }),
      channel.on('call-offer', async ({ callId, sdp }) => {
        const c = callRef.current
        if (!c || c.id !== callId || c.callee_id !== user?.id || !pc.current) return
        await pc.current.setRemoteDescription(sdp); await flushIce()
        const ans = await pc.current.createAnswer()
        await pc.current.setLocalDescription(ans)
        channel.send('call-answer', { callId, sdp: pc.current.localDescription?.toJSON() })
      }),
      channel.on('call-answer', async ({ callId, sdp }) => {
        if (callRef.current?.id !== callId || !pc.current) return
        await pc.current.setRemoteDescription(sdp); await flushIce()
      }),
      channel.on('call-ice', async ({ callId, candidate }) => {
        if (callRef.current?.id !== callId || !candidate) return
        if (pc.current?.remoteDescription) await pc.current.addIceCandidate(candidate).catch(() => {})
        else pendingIce.current.push(candidate)
      }),
      channel.on('call-end', ({ callId }) => {
        if (callRef.current?.id === callId && phaseRef.current !== 'idle' && phaseRef.current !== 'ended') {
          cleanup(phaseRef.current === 'incoming' ? 'Missed call.' : 'The other person ended the call.')
        }
      }),
    ]
    return () => offs.forEach((o) => o())
  }, [channel, user?.id, cleanup, makePc, setPhase, stopRing])

  // ---------- inbound: database events (source of truth for ringing / ended)
  useEffect(() => {
    if (!user || !couple) return
    let cancelled = false
    const ring = (c: CallRow) => {
      if (c.callee_id !== user.id || c.state !== 'ringing') return
      if (phaseRef.current !== 'idle' && phaseRef.current !== 'ended') return
      clearTimeout(timers.current.reset)
      setCurrent(c); setMedia(c.media); setPhase('incoming'); startRing(true)
      timers.current.ring = window.setTimeout(() => cleanup('Missed call.'), RING_TIMEOUT_MS + 5000)
    }
    ;(async () => {
      const { data: now } = await supabase.rpc('server_now')
      if (now) skew.current = Date.now() - new Date(now as string).getTime()
      // a call that began just before the app was opened (e.g. from a push notification)
      const { data } = await supabase.from('calls').select('*').eq('state', 'ringing').eq('callee_id', user.id)
        .gt('created_at', new Date(Date.now() - skew.current - RING_TIMEOUT_MS).toISOString()).limit(1)
      if (!cancelled && data?.[0]) ring(data[0] as CallRow)
    })()
    const ch = supabase.channel(`calls-db:${couple.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'calls', filter: `couple_id=eq.${couple.id}` },
        (p) => ring(p.new as CallRow))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls', filter: `couple_id=eq.${couple.id}` }, (p) => {
        const c = p.new as CallRow
        if (callRef.current?.id !== c.id) return
        if (c.state === 'ended' && phaseRef.current !== 'idle' && phaseRef.current !== 'ended') {
          const msg = c.end_reason === 'declined' ? 'Call declined.' : c.end_reason === 'missed' ? (c.callee_id === user.id ? 'Missed call.' : 'No answer.')
            : c.end_reason === 'cancelled' ? 'Call cancelled.' : c.end_reason === 'failed' ? 'The call failed.' : 'Call ended.'
          cleanup(msg)
        } else setCurrent(c)
      })
      .subscribe()
    return () => { cancelled = true; supabase.removeChannel(ch) }
  }, [user, couple, cleanup, setCurrent, setPhase, startRing])

  // leaving the page mid-call: tell the partner and release the mic/camera
  useEffect(() => {
    const h = () => { const c = callRef.current; if (c && phaseRef.current !== 'idle') { supabase.rpc('end_call', { p_id: c.id }).then(() => {}) } }
    window.addEventListener('pagehide', h)
    return () => window.removeEventListener('pagehide', h)
  }, [])

  const value = useMemo<CallCtx>(() => ({
    phase, call, isCaller: call?.caller_id === user?.id, media, muted, cameraOff, canSwitchCamera, elapsed, notice,
    localStream, remoteStream, audioEl, needsAudioTap, startCall, answer, reject, hangup, toggleMute, toggleCamera, switchCamera, resumeAudio,
  }), [phase, call, user?.id, media, muted, cameraOff, canSwitchCamera, elapsed, notice, localStream, remoteStream, audioEl, needsAudioTap,
    startCall, answer, reject, hangup, toggleMute, toggleCamera, switchCamera, resumeAudio])

  return (
    <Ctx.Provider value={value}>
      {children}
      <audio ref={setAudioEl} autoPlay playsInline />
    </Ctx.Provider>
  )
}
