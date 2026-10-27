import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useE2EE } from '../lib/e2ee'
import { disablePush, enablePush, pushState, type PushState } from '../lib/push'
import { dateTime } from '../lib/format'

const PUSH_TEXT: Record<PushState, string> = {
  unsupported: 'This browser doesn’t support push notifications. On Android, use Chrome and install the app.',
  unconfigured: 'Push isn’t configured on this deployment yet (missing VAPID key).',
  denied: 'Notifications are blocked for this site. Allow them in your browser’s site settings.',
  off: 'Off on this device.', on: 'On for this device.',
}

export default function Settings() {
  const { couple, user, refreshCouple, signOut } = useAuth()
  const e2ee = useE2EE()
  const [name, setName] = useState(couple?.me.display_name ?? '')
  const [tz, setTz] = useState(couple?.me.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [push, setPush] = useState<PushState>('off')
  const [safety, setSafety] = useState('')
  const [pw, setPw] = useState('')
  const [erase, setErase] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => { pushState().then(setPush) }, [])
  useEffect(() => { if (e2ee.ready) e2ee.mySafetyNumber().then(setSafety) }, [e2ee.ready, e2ee.devices.length])  // eslint-disable-line react-hooks/exhaustive-deps

  async function saveProfile() {
    const { error } = await supabase.from('profiles').update({ display_name: name.trim(), timezone: tz }).eq('user_id', user!.id)
    setMsg(error ? 'Couldn’t save your profile.' : 'Saved.'); if (!error) await refreshCouple()
  }
  async function togglePush() {
    try { if (push === 'on') { await disablePush(); setPush('off') } else setPush(await enablePush(user!.id)) }
    catch { setMsg('Couldn’t change notification settings.') }
  }
  async function changePw() {
    if (pw.length < 10) return setMsg('Use at least 10 characters.')
    const { error } = await supabase.auth.updateUser({ password: pw })
    setMsg(error ? error.message : 'Password updated.'); if (!error) setPw('')
  }
  async function signOutEverywhere() {
    if (!confirm('Sign out of every device (including this one)?')) return
    await supabase.auth.signOut({ scope: 'global' })
  }
  async function revoke(id: string) {
    if (!confirm('Revoke this device? It will no longer receive new messages.')) return
    await supabase.rpc('revoke_device', { p_id: id }); await e2ee.refreshDevices()
  }
  async function reset() {
    if (!confirm('Create a new encryption identity for this device? Messages already on the server stay readable only on devices that received them.')) return
    await e2ee.resetDevice(); setMsg('This device has a new encryption identity.')
  }
  const mine = e2ee.devices.filter((d) => d.user_id === user?.id)
  const theirs = e2ee.devices.filter((d) => d.user_id !== user?.id)

  return (
    <div className="page">
      <h2 className="title">Settings</h2>
      {msg && <p className="success" role="status" onClick={() => setMsg(null)}>{msg}</p>}

      <section className="panel"><h3>Profile</h3>
        <label htmlFor="dn">Display name</label><input id="dn" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="tz">Time zone</label><input id="tz" value={tz} onChange={(e) => setTz(e.target.value)} />
        <p className="muted small">Signed in as {user?.email}. Partner: {couple?.partner?.display_name ?? '—'} ({couple?.partner?.timezone}).</p>
        <button className="btn" onClick={saveProfile} disabled={!name.trim()}>Save</button></section>

      <section className="panel"><h3>Notifications</h3>
        <p className="muted">{PUSH_TEXT[push]}</p>
        <button className="btn" onClick={togglePush} disabled={push === 'unsupported' || push === 'unconfigured' || push === 'denied'}>{push === 'on' ? 'Turn off' : 'Turn on'}</button>
        <p className="muted small">Notifications never contain message text. A call that arrives while the app is fully closed shows as a notification you tap — it doesn’t ring like a phone call, and battery-saver can delay it.</p></section>

      <section className="panel"><h3>Encryption & devices</h3>
        <p className="muted small">Messages are end-to-end encrypted with keys that never leave your devices. Compare this number with {couple?.partner?.display_name} in person or on a call — it should match exactly.</p>
        <p className="code" aria-label="Safety number">{safety || '…'}</p>
        <h4>Your devices</h4>
        <ul className="plain">{mine.map((d) => <li key={d.id}>{d.label}{d.id === e2ee.device?.deviceId ? ' (this device)' : ''} <small className="muted">· added {dateTime(d.created_at)}</small>
          {d.id !== e2ee.device?.deviceId && <button className="link" onClick={() => revoke(d.id)}>Revoke</button>}</li>)}</ul>
        <h4>{couple?.partner?.display_name}’s devices</h4>
        <ul className="plain">{theirs.map((d) => <li key={d.id}>{d.label} <small className="muted">· added {dateTime(d.created_at)}</small></li>)}</ul>
        <p className="muted small">If you see a partner device you don’t recognise, ask them — then re-compare the safety number.</p>
        <button className="btn" onClick={reset}>Reset this device’s keys</button></section>

      <section className="panel"><h3>Account</h3>
        <label htmlFor="np">New password</label><input id="np" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
        <button className="btn" onClick={changePw}>Change password</button>
        <hr />
        <label className="row"><input type="checkbox" checked={erase} onChange={(e) => setErase(e.target.checked)} /> Also erase this device’s encryption keys (older messages become unreadable here)</label>
        <div className="row"><button className="btn" onClick={() => signOut(erase)}>Log out</button>
          <button className="btn danger" onClick={signOutEverywhere}>Log out everywhere</button></div></section>
    </div>
  )
}
