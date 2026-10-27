// Issues short-lived TURN credentials to authenticated couple members only.
// Secrets (set with `supabase secrets set`): CF_TURN_KEY_ID, CF_TURN_API_TOKEN
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const auth = req.headers.get('Authorization')
  if (!auth) return json({ error: 'unauthorized' }, 401)

  // Act as the caller so RLS decides whether they are a couple member.
  const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
  })
  const { data: user } = await supa.auth.getUser()
  if (!user?.user) return json({ error: 'unauthorized' }, 401)
  const { data: coupleId } = await supa.rpc('my_couple_id')
  if (!coupleId) return json({ error: 'forbidden' }, 403)

  const stun = { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }
  const keyId = Deno.env.get('CF_TURN_KEY_ID')
  const token = Deno.env.get('CF_TURN_API_TOKEN')
  if (!keyId || !token) return json({ iceServers: [stun], relay: false })

  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: 3600 }),
  })
  if (!res.ok) return json({ iceServers: [stun], relay: false, warning: 'turn_unavailable' })
  const body = await res.json()
  return json({ iceServers: body.iceServers ?? [stun], relay: true })
})
