// One PRIVATE realtime channel per couple ("couple:<id>"), authorised by RLS on realtime.messages.
// Carries presence, typing indicators and call signalling. Durable data never travels only here.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { useAuth } from './auth'

type Handler = (payload: any) => void
interface ChannelCtx {
  connected: boolean
  partnerOnline: boolean
  send: (event: string, payload?: Record<string, unknown>) => Promise<void>
  on: (event: string, h: Handler) => () => void
}
const Ctx = createContext<ChannelCtx | null>(null)
export const useCoupleChannel = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useCoupleChannel outside provider')
  return v
}

export function CoupleChannelProvider({ children }: { children: ReactNode }) {
  const { user, couple } = useAuth()
  const [connected, setConnected] = useState(false)
  const [partnerOnline, setPartnerOnline] = useState(false)
  const chan = useRef<RealtimeChannel | null>(null)
  const handlers = useRef(new Map<string, Set<Handler>>())

  useEffect(() => {
    if (!user || !couple || couple.memberCount < 2) { setConnected(false); setPartnerOnline(false); return }
    let cancelled = false
    ;(async () => {
      await supabase.realtime.setAuth()
      if (cancelled) return
      const ch = supabase.channel(`couple:${couple.id}`, { config: { private: true, presence: { key: user.id }, broadcast: { self: false } } })
      ch.on('presence', { event: 'sync' }, () => {
        setPartnerOnline(Object.keys(ch.presenceState()).some((k) => k !== user.id))
      })
      for (const ev of ['typing', 'call-accept', 'call-offer', 'call-answer', 'call-ice', 'call-end']) {
        ch.on('broadcast', { event: ev }, ({ payload }) => handlers.current.get(ev)?.forEach((h) => h(payload)))
      }
      ch.subscribe(async (status) => {
        setConnected(status === 'SUBSCRIBED')
        if (status === 'SUBSCRIBED') await ch.track({ at: new Date().toISOString() })
      })
      chan.current = ch
    })()
    return () => {
      cancelled = true
      if (chan.current) supabase.removeChannel(chan.current)
      chan.current = null; setConnected(false); setPartnerOnline(false)
    }
  }, [user?.id, couple?.id, couple?.memberCount])  // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(async (event: string, payload: Record<string, unknown> = {}) => {
    await chan.current?.send({ type: 'broadcast', event, payload })
  }, [])
  const on = useCallback((event: string, h: Handler) => {
    if (!handlers.current.has(event)) handlers.current.set(event, new Set())
    handlers.current.get(event)!.add(h)
    return () => { handlers.current.get(event)?.delete(h) }
  }, [])

  const value = useMemo(() => ({ connected, partnerOnline, send, on }), [connected, partnerOnline, send, on])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
