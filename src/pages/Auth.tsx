import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

type Mode = 'login' | 'register' | 'forgot'

function friendly(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('invalid login')) return 'That email or password doesn’t look right.'
  if (m.includes('email not confirmed')) return 'Please confirm your email first — check your inbox.'
  if (m.includes('database error') || m.includes('not approved')) return 'This email isn’t on the approved list for 2 Fold.'
  if (m.includes('already registered')) return 'An account with this email already exists. Try logging in.'
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts. Please wait a few minutes and try again.'
  if (m.includes('password')) return message
  return 'Something went wrong. Please try again.'
}

export function AuthPages() {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault(); setMsg(null)
    if (mode === 'register') {
      if (password.length < 10) return setMsg({ kind: 'err', text: 'Use at least 10 characters for your password.' })
      if (password !== confirm) return setMsg({ kind: 'err', text: 'The passwords don’t match.' })
      if (!name.trim()) return setMsg({ kind: 'err', text: 'Please tell us what to call you.' })
    }
    setBusy(true)
    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (error) setMsg({ kind: 'err', text: friendly(error.message) })
      } else if (mode === 'register') {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(), password,
          options: { data: { display_name: name.trim() }, emailRedirectTo: window.location.origin },
        })
        if (error) setMsg({ kind: 'err', text: friendly(error.message) })
        else if (!data.session) setMsg({ kind: 'ok', text: 'Almost there — check your email to confirm your account, then log in.' })
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/` })
        // Same message either way: don't reveal whether an email has an account.
        setMsg(error && /rate/i.test(error.message) ? { kind: 'err', text: friendly(error.message) }
          : { kind: 'ok', text: 'If that email has an account, a reset link is on its way.' })
      }
    } finally { setBusy(false) }
  }

  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit} noValidate>
        <h1>2 Fold <span>🌎💕</span></h1>
        <p className="muted">{mode === 'login' ? 'Our little world, just for two.' : mode === 'register' ? 'Create your account.' : 'Reset your password.'}</p>
        {mode === 'register' && (<><label htmlFor="name">What should we call you?</label>
          <input id="name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoComplete="given-name" required /></>)}
        <label htmlFor="email">Email address</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        {mode !== 'forgot' && (<><label htmlFor="pw">Password</label>
          <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required /></>)}
        {mode === 'register' && (<><label htmlFor="pw2">Confirm password</label>
          <input id="pw2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required /></>)}
        {msg && <p className={msg.kind === 'err' ? 'error' : 'success'} role="alert">{msg.text}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'One moment…' : mode === 'login' ? 'Log in 💕' : mode === 'register' ? 'Create account' : 'Send reset link'}</button>
        <div className="auth-links">
          {mode !== 'login' && <button type="button" className="link" onClick={() => { setMode('login'); setMsg(null) }}>Back to log in</button>}
          {mode === 'login' && <button type="button" className="link" onClick={() => { setMode('forgot'); setMsg(null) }}>Forgot password?</button>}
          {mode === 'login' && <button type="button" className="link" onClick={() => { setMode('register'); setMsg(null) }}>First time? Create account</button>}
        </div>
      </form>
    </div>
  )
}

export function ResetPassword() {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (pw.length < 10) return setMsg('Use at least 10 characters.')
    if (pw !== pw2) return setMsg('The passwords don’t match.')
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) setMsg(friendly(error.message))
    else { await supabase.auth.signOut({ scope: 'others' }); window.history.replaceState(null, '', '/') }
  }
  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <h1>Choose a new password</h1>
        <label htmlFor="np">New password</label>
        <input id="np" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required />
        <label htmlFor="np2">Confirm</label>
        <input id="np2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
        {msg && <p className="error" role="alert">{msg}</p>}
        <button className="btn primary" disabled={busy}>Save password</button>
      </form>
    </div>
  )
}
