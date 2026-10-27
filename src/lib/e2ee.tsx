import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { supabase } from './supabase'
import { useAuth } from './auth'
import { generateDeviceKeys, exportPublicJwk, encryptMessage, decryptMessage, thumbprint, safetyNumber, type PublicJwk } from './crypto'
import { loadLocalDevice, saveLocalDevice, eraseLocalDevice, type LocalDevice } from './keystore'
import type { DeviceRow, MessagePayload, MessageRow } from './types'

interface E2EECtx {
  ready: boolean
  error: string | null
  device: LocalDevice | null
  devices: DeviceRow[]
  refreshDevices: () => Promise<void>
  encrypt: (payload: MessagePayload, clientId: string, kind: string) => Promise<{ ciphertext: string; iv: string; keys: unknown[] }>
  decrypt: (m: MessageRow) => Promise<MessagePayload>
  mySafetyNumber: () => Promise<string>
  resetDevice: () => Promise<void>
}
const Ctx = createContext<E2EECtx | null>(null)
export const useE2EE = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useE2EE outside provider')
  return v
}

const deviceLabel = () => `${/Android/i.test(navigator.userAgent) ? 'Android' : /iPhone|iPad/i.test(navigator.userAgent) ? 'iOS' : 'Browser'} · ${new Date().toLocaleDateString()}`

export function E2EEProvider({ children }: { children: ReactNode }) {
  const { user, couple } = useAuth()
  const [device, setDevice] = useState<LocalDevice | null>(null)
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const keyCache = useRef(new Map<string, unknown>())

  const refreshDevices = useCallback(async () => {
    const { data } = await supabase.from('devices').select('*').is('revoked_at', null).order('created_at')
    setDevices((data as DeviceRow[]) ?? [])
  }, [])

  const enroll = useCallback(async (userId: string): Promise<LocalDevice> => {
    const kp = await generateDeviceKeys()
    const publicJwk = await exportPublicJwk(kp.publicKey)
    const { data, error: e } = await supabase.rpc('register_device', { p_label: deviceLabel(), p_public_key: publicJwk })
    if (e) throw e
    const d: LocalDevice = { deviceId: data as string, privateKey: kp.privateKey, publicJwk }
    await saveLocalDevice(userId, d)
    return d
  }, [])

  useEffect(() => {
    setDevice(null); setDevices([]); setError(null); keyCache.current.clear()   // never carry state across accounts
    if (!user || !couple || couple.memberCount < 1) return
    let cancelled = false
    ;(async () => {
      try {
        let d = (await loadLocalDevice(user.id)) ?? null
        const { data: rows } = await supabase.from('devices').select('*').is('revoked_at', null)
        if (d && !(rows as DeviceRow[] | null)?.some((r) => r.id === d!.deviceId)) d = null   // revoked or unknown -> re-enroll
        if (!d) d = await enroll(user.id)
        if (cancelled) return
        setDevice(d)
        await refreshDevices()
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not set up encryption on this device')
      }
    })()
    return () => { cancelled = true }
  }, [user?.id, couple?.id, couple?.memberCount, enroll, refreshDevices])  // eslint-disable-line react-hooks/exhaustive-deps

  const encrypt = useCallback(async (payload: MessagePayload, clientId: string, kind: string) => {
    if (!device || !couple) throw new Error('Encryption is not ready')
    // Always fetch fresh device list so a partner's new phone receives this message too.
    const { data } = await supabase.from('devices').select('*').is('revoked_at', null)
    const targets = ((data as DeviceRow[]) ?? []).map((d) => ({ deviceId: d.id, publicJwk: d.public_key }))
    return encryptMessage(payload, { coupleId: couple.id, clientId, kind }, device, targets)
  }, [device, couple])

  const decrypt = useCallback(async (m: MessageRow): Promise<MessagePayload> => {
    if (!device || !couple) throw new Error('Encryption is not ready')
    const { data: keyRow } = await supabase.from('message_keys').select('wrapped_key,iv')
      .eq('message_id', m.id).eq('device_id', device.deviceId).maybeSingle()
    if (!keyRow) throw new Error('not-for-this-device')   // sent before this device was enrolled
    let sender = devices.find((d) => d.id === m.sender_device_id)
    if (!sender) {
      const { data } = await supabase.from('devices').select('*').eq('id', m.sender_device_id).maybeSingle()
      sender = (data as DeviceRow | null) ?? undefined
    }
    if (!sender) throw new Error('unknown-sender-device')
    return decryptMessage<MessagePayload>(m, keyRow, { coupleId: couple.id, clientId: m.client_id, kind: m.kind },
      { deviceId: sender.id, publicJwk: sender.public_key as PublicJwk }, device)
  }, [device, devices, couple])

  const mySafetyNumber = useCallback(async () => {
    const { data } = await supabase.from('devices').select('public_key').is('revoked_at', null)
    return safetyNumber(await Promise.all(((data as { public_key: PublicJwk }[]) ?? []).map((d) => thumbprint(d.public_key))))
  }, [])

  const resetDevice = useCallback(async () => {
    if (!user) return
    if (device) await supabase.rpc('revoke_device', { p_id: device.deviceId })
    await eraseLocalDevice(user.id)
    const d = await enroll(user.id)
    setDevice(d); await refreshDevices()
  }, [user, device, enroll, refreshDevices])

  const value = useMemo<E2EECtx>(() => ({
    ready: Boolean(device), error, device, devices, refreshDevices, encrypt, decrypt, mySafetyNumber, resetDevice,
  }), [device, error, devices, refreshDevices, encrypt, decrypt, mySafetyNumber, resetDevice])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
