import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { eraseLocalDevice } from './keystore'
import type { Profile } from './types'

export interface CoupleState { id: string; memberCount: number; me: Profile; partner: Profile | null }
interface AuthCtx {
  session: Session | null
  user: User | null
  loading: boolean
  recovery: boolean
  couple: CoupleState | null | undefined   // undefined = still loading, null = not paired yet
  refreshCouple: () => Promise<void>
  signOut: (eraseKeys?: boolean) => Promise<void>
}
const Ctx = createContext<AuthCtx | null>(null)
export const useAuth = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [recovery, setRecovery] = useState(false)
  const [couple, setCouple] = useState<CoupleState | null | undefined>(undefined)
  const lastUser = useRef<string | null>(null)

  const refreshCouple = useCallback(async () => {
    const { data: members, error } = await supabase.from('couple_members').select('couple_id,user_id')
    if (error) return setCouple(null)
    if (!members?.length) return setCouple(null)
    const { data: profs } = await supabase.from('profiles').select('user_id,display_name,timezone')
    const { data: u } = await supabase.auth.getUser()
    const me = profs?.find((p) => p.user_id === u.user?.id)
    if (!me) return setCouple(null)
    setCouple({
      id: members[0].couple_id, memberCount: members.length, me,
      partner: profs?.find((p) => p.user_id !== me.user_id) ?? null,
    })
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false) })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true)
      if (event === 'USER_UPDATED') setRecovery(false)
      // Account change: wipe all in-memory state so nothing from the previous user can leak.
      if (event === 'SIGNED_OUT' || (s && lastUser.current && s.user.id !== lastUser.current)) setCouple(undefined)
      lastUser.current = s?.user.id ?? null
      setSession(s)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (session?.user) refreshCouple()
    else setCouple(undefined)
  }, [session?.user?.id, refreshCouple])

  // Session revocation: verify with the server whenever the app regains focus.
  useEffect(() => {
    if (!session) return
    const check = async () => {
      if (document.visibilityState !== 'visible') return
      const { error } = await supabase.auth.getUser()
      if (error && (error.status === 401 || error.status === 403)) await supabase.auth.signOut({ scope: 'local' })
    }
    document.addEventListener('visibilitychange', check)
    return () => document.removeEventListener('visibilitychange', check)
  }, [session])

  const signOut = useCallback(async (eraseKeys = false) => {
    if (eraseKeys && session?.user) await eraseLocalDevice(session.user.id)
    // Unsubscribe push on this device so the next user doesn't receive this user's alerts.
    try {
      const reg = await navigator.serviceWorker?.getRegistration()
      const sub = await reg?.pushManager.getSubscription()
      if (sub) { await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe() }
    } catch { /* best effort */ }
    await supabase.auth.signOut()
    setCouple(undefined)
  }, [session])

  const value = useMemo<AuthCtx>(() => ({
    session, user: session?.user ?? null, loading, recovery, couple, refreshCouple, signOut,
  }), [session, loading, recovery, couple, refreshCouple, signOut])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
