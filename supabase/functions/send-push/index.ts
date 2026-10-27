// Database Webhook target: sends a Web Push to the partner for new messages and incoming calls.
// Payloads never contain message text (messages are end-to-end encrypted).
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_WEBHOOK_SECRET
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase and stay server-side.)
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
)
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

Deno.serve(async (req) => {
  if (req.headers.get('x-webhook-secret') !== Deno.env.get('PUSH_WEBHOOK_SECRET')) {
    return new Response('forbidden', { status: 403 })
  }
  const evt = await req.json()
  if (evt.type !== 'INSERT') return new Response('ignored')
  const rec = evt.record
  let recipient: string | null = null
  let payload: Record<string, unknown> | null = null

  if (evt.table === 'messages') {
    const { data } = await admin.from('couple_members').select('user_id').eq('couple_id', rec.couple_id).neq('user_id', rec.sender_id).maybeSingle()
    recipient = data?.user_id ?? null
    payload = { title: '2 Fold 💕', body: 'You have a new message', tag: 'msg', url: '/chat', kind: 'message' }
  } else if (evt.table === 'calls' && rec.state === 'ringing') {
    recipient = rec.callee_id
    payload = {
      title: rec.media === 'video' ? 'Incoming video call' : 'Incoming voice call',
      body: 'Tap to answer', tag: 'call-' + rec.id, url: '/?call=' + rec.id, kind: 'call', requireInteraction: true,
    }
  }
  if (!recipient || !payload) return new Response('nothing to send')

  const { data: subs } = await admin.from('push_subscriptions').select('id,endpoint,p256dh,auth').eq('user_id', recipient)
  let sent = 0
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: payload!.kind === 'call' ? 45 : 86400, urgency: payload!.kind === 'call' ? 'high' : 'normal' },
      )
      sent++
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode
      if (code === 404 || code === 410) await admin.from('push_subscriptions').delete().eq('id', s.id)
    }
  }))
  return new Response(JSON.stringify({ sent }), { headers: { 'Content-Type': 'application/json' } })
})
