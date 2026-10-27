import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useCall } from '../lib/calls'
import { Icon } from './Icon'
import { formatDuration } from '../lib/callState'
import { classifyOutputs, supportsSetSinkId, type OutputInfo } from '../lib/audioOutput'

/** Speaker / private-listening control. It is separate from microphone mute and only claims to work
 *  when the browser really exposes more than one output route (see docs/NATIVE_ANDROID.md). */
function AudioOutputControl() {
  const { audioEl } = useCall()
  const [outs, setOuts] = useState<OutputInfo[]>([])
  const [sel, setSel] = useState('default')
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    const refresh = async () => {
      try {
        const d = await navigator.mediaDevices.enumerateDevices()
        setOuts(d.filter((x) => x.kind === 'audiooutput').map((x) => ({ deviceId: x.deviceId, label: x.label || 'Audio output' })))
      } catch { setOuts([]) }
    }
    refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
  }, [])

  const cls = classifyOutputs(outs)
  const supported = supportsSetSinkId() && cls.canSwitch

  async function route(id: string) {
    try {
      await (audioEl as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(id)
      setSel(id); setMsg(null)
    } catch (e) {
      setMsg((e as DOMException).name === 'NotAllowedError' ? 'Permission to change audio output was denied.' : 'This device could not switch audio output.')
    }
  }

  if (!supported) {
    return (
      <div className="call-ctl-wrap">
        <button className="call-btn" disabled aria-disabled title="Not supported in this browser">
          <Icon name="speaker" /><span>Speaker</span>
        </button>
        <p className="call-hint">Your browser doesn’t let web apps switch speaker/earpiece. Use your phone’s volume or audio-output button.</p>
      </div>
    )
  }
  if (cls.speaker) {
    const on = sel === cls.speaker.deviceId
    return (
      <div className="call-ctl-wrap">
        <button className={`call-btn ${on ? 'on' : ''}`} aria-pressed={on}
          onClick={() => route(on ? (cls.earpiece?.deviceId ?? 'default') : cls.speaker!.deviceId)}>
          <Icon name={on ? 'speaker' : 'speaker-low'} /><span>{on ? 'Speaker on' : 'Phone'}</span>
        </button>
        {msg && <p className="call-hint">{msg}</p>}
      </div>
    )
  }
  return (
    <div className="call-ctl-wrap">
      <label className="call-select"><Icon name="speaker" />
        <select value={sel} onChange={(e) => route(e.target.value)} aria-label="Audio output">
          {outs.map((o) => <option key={o.deviceId} value={o.deviceId}>{o.label}</option>)}
        </select>
      </label>
      {msg && <p className="call-hint">{msg}</p>}
    </div>
  )
}

function Video({ stream, muted, mirror, className }: { stream: MediaStream | null; muted?: boolean; mirror?: boolean; className: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => { if (ref.current) ref.current.srcObject = stream }, [stream])
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} style={mirror ? { transform: 'scaleX(-1)' } : undefined} />
}

export function CallOverlay() {
  const c = useCall()
  const { couple } = useAuth()
  const [, force] = useState(0)
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(t) }, [])
  const name = couple?.partner?.display_name ?? 'Your person'

  if (c.phase === 'idle') return c.notice ? <div className="toast" role="status">{c.notice}</div> : null

  const label = {
    outgoing: `Calling ${name}…`, incoming: `${name} is calling`, connecting: 'Connecting…',
    active: formatDuration(c.elapsed), reconnecting: 'Reconnecting…', ended: c.notice ?? 'Call ended', idle: '',
  }[c.phase]

  return (
    <div className={`call-screen ${c.media}`} role="dialog" aria-modal="true" aria-label="Call">
      {c.media === 'video' && <Video stream={c.remoteStream} muted className="call-remote" />}
      {c.media === 'video' && c.localStream && !c.cameraOff && <Video stream={c.localStream} muted mirror className="call-local" />}
      <div className="call-top">
        {c.media === 'voice' && <div className="call-avatar">{name.charAt(0).toUpperCase()}</div>}
        <h2>{name}</h2>
        <p className="call-status" aria-live="polite">{label}</p>
        {c.phase === 'reconnecting' && c.notice && <p className="call-hint">{c.notice}</p>}
        {c.needsAudioTap && <button className="btn" onClick={c.resumeAudio}>Tap to enable call audio</button>}
      </div>

      {c.phase === 'incoming' ? (
        <div className="call-actions">
          <button className="call-btn danger" onClick={c.reject} aria-label="Decline"><Icon name="phone-off" /><span>Decline</span></button>
          <button className="call-btn accept" onClick={c.answer} aria-label="Answer"><Icon name={c.media === 'video' ? 'video' : 'phone'} /><span>Answer</span></button>
        </div>
      ) : c.phase === 'ended' ? null : (
        <div className="call-actions wrap">
          <button className={`call-btn ${c.muted ? 'on' : ''}`} onClick={c.toggleMute} aria-pressed={c.muted}>
            <Icon name={c.muted ? 'mic-off' : 'mic'} /><span>{c.muted ? 'Unmute' : 'Mute'}</span>
          </button>
          <AudioOutputControl />
          {c.media === 'video' && (
            <>
              <button className={`call-btn ${c.cameraOff ? 'on' : ''}`} onClick={c.toggleCamera} aria-pressed={c.cameraOff}>
                <Icon name={c.cameraOff ? 'video-off' : 'video'} /><span>{c.cameraOff ? 'Camera off' : 'Camera'}</span>
              </button>
              {c.canSwitchCamera && <button className="call-btn" onClick={c.switchCamera}><Icon name="flip" /><span>Flip</span></button>}
            </>
          )}
          <button className="call-btn danger" onClick={c.hangup} aria-label="End call"><Icon name="phone-off" /><span>{c.phase === 'outgoing' ? 'Cancel' : 'End'}</span></button>
        </div>
      )}
    </div>
  )
}
