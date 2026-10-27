import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

const JOIN_ERRORS: Record<string, string> = {
  invalid: 'That code isn’t valid or has expired. Ask your partner for a fresh one.',
  rate_limited: 'Too many attempts. Please wait 15 minutes before trying again.',
  not_allowed: 'This account’s email isn’t approved for 2 Fold.',
  already_member: 'You’re already part of a couple.',
  couple_full: 'That space already has two people.',
}

export default function Pairing() {
  const { couple, refreshCouple, signOut, user } = useAuth()
  const [code, setCode] = useState<string | null>(null)
  const [join, setJoin] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // while waiting for the partner, poll membership
  useEffect(() => {
    if (!couple) return
    const t = setInterval(refreshCouple, 5000)
    return () => clearInterval(t)
  }, [couple, refreshCouple])

  async function create() {
    setBusy(true); setErr(null)
    const { error } = await supabase.rpc('create_couple')
    if (error) setErr(error.message.includes('not approved') ? 'This account’s email isn’t approved for 2 Fold.' : 'Could not create your space.')
    else await refreshCouple()
    setBusy(false)
  }
  async function invite() {
    setBusy(true); setErr(null)
    const { data, error } = await supabase.rpc('create_invite')
    if (error) setErr('Could not create an invite code.'); else setCode(data as string)
    setBusy(false)
  }
  async function doJoin() {
    setBusy(true); setErr(null)
    const { data, error } = await supabase.rpc('join_couple', { p_code: join })
    if (error) setErr('Something went wrong. Please try again.')
    else if (data === 'ok') await refreshCouple()
    else setErr(JOIN_ERRORS[data as string] ?? 'Could not join.')
    setBusy(false)
  }

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <h1>Let’s pair up 💞</h1>
        <p className="muted">Signed in as {user?.email}</p>
        {err && <p className="error" role="alert">{err}</p>}
        {!couple ? (
          <>
            <button className="btn primary" disabled={busy} onClick={create}>I’m starting our space</button>
            <hr />
            <label htmlFor="jc">Or enter the code your partner gave you</label>
            <input id="jc" value={join} onChange={(e) => setJoin(e.target.value)} placeholder="XXXX-XXXX-XXXX-XX" autoCapitalize="characters" autoComplete="off" />
            <button className="btn" disabled={busy || join.trim().length < 8} onClick={doJoin}>Join</button>
          </>
        ) : (
          <>
            <p>Your space is ready. Waiting for your partner to join…</p>
            {code ? (
              <>
                <p className="code" aria-label="Invite code">{code.match(/.{1,4}/g)?.join('-')}</p>
                <p className="muted">Share this code privately. It works once and expires in 24 hours.</p>
              </>
            ) : <button className="btn primary" disabled={busy} onClick={invite}>Create invite code</button>}
          </>
        )}
        <button className="link" onClick={() => signOut()}>Log out</button>
      </div>
    </div>
  )
}
