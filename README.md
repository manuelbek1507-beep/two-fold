# 2 Fold 🌎💕

A private, installable web app for exactly two approved partners: end-to-end encrypted chat, shared memories,
scheduled letters, a shared playlist with background playback, and WebRTC voice/video calls.
Stack: **React + TypeScript + Vite**, **Supabase** (Auth, Postgres + RLS, Realtime, Storage, Edge Functions), **Netlify**, **PWA**.

> ### Honest status (read first)
> Everything below was **written but not yet run end-to-end**, because the environment that produced it had no internet
> (so no `npm install`, no Vite build, no Supabase, no browser, no phones).
> What *was* actually executed: the crypto/logic unit tests (**11/11 pass**), a TypeScript syntax check of all 32 source files,
> a strict type-check against stub typings, and static cross-checks of routes / RPCs / tables / buckets / env vars.
> **Not run:** `npm run build`, `npm run lint`, the SQL migrations, `supabase/tests/rls_tests.sql`, anything on a real device.
> Expect to fix a few small errors on the first `npm install && npm run build`. See [CHECKLIST.md](CHECKLIST.md) for per-feature status.

## 1. Prerequisites
Node 20+ (22 recommended), npm, Git, the [Supabase CLI](https://supabase.com/docs/guides/cli), a **new** Supabase project
(do **not** reuse your existing production one), a Netlify account, and a GitHub repo.

## 2. Local setup (VS Code)
```bash
cd 2fold
npm install            # also creates package-lock.json (commit it; none is shipped because there was no network)
cp .env.example .env   # fill VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (Project Settings → API)
npm run dev            # http://localhost:5173
```
Other commands: `npm run typecheck`, `npm run lint`, `npm test` (crypto + logic), `npm run build`, `npm run preview`.
The service worker only registers in production builds (`npm run build && npm run preview`).

## 3. Supabase setup (new project)
1. **Create a project**, then `supabase login && supabase link --project-ref <ref>`.
2. **Approve the two partners** *before anyone signs up* (signup is blocked by a database trigger for any other email).
   After the first push (step 3) run in the SQL editor:
   ```sql
   insert into public.allowed_emails values ('you@example.com'), ('partner@example.com');  -- lowercase
   ```
3. **Apply migrations:** `supabase db push` (files in `supabase/migrations/`: `0001` pairing/devices, `0002` chat/calls/realtime auth, `0003` memories/letters/playlist/push/storage).
4. **Auth settings** (Dashboard → Authentication): *Site URL* = your Netlify URL; *Redirect URLs* add `http://localhost:5173/**` and your production URL;
   keep **email confirmations ON**; minimum password length 10; enable leaked-password protection if your plan allows.
5. **Realtime** (Dashboard → Realtime → Settings): turn **off** "Allow public access" so channels must be private (the app uses private channels authorised by RLS).
6. **Edge Functions:** `supabase functions deploy turn-credentials` and `supabase functions deploy send-push`.
7. **Secrets** (never in git/frontend): `supabase secrets set CF_TURN_KEY_ID=… CF_TURN_API_TOKEN=… VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… VAPID_SUBJECT=mailto:you@example.com PUSH_WEBHOOK_SECRET=<long random>`.
   Generate VAPID keys with `npx web-push generate-vapid-keys`; put the **public** key also in `.env` / Netlify as `VITE_VAPID_PUBLIC_KEY`.
8. **Database Webhooks** for push (Dashboard → Database → Webhooks): create two — table `messages` *Insert*, and table `calls` *Insert* — type *HTTP Request* (POST) to
   `https://<ref>.functions.supabase.co/send-push` with header `x-webhook-secret: <PUSH_WEBHOOK_SECRET>`.
9. **TURN** (needed when direct peer-to-peer fails, e.g. mobile data/strict NATs): create a free Cloudflare account → *Realtime → TURN* → create a key → use its Key ID and API token above.
   Without TURN the app falls back to STUN only and some calls will fail to connect.
10. **Pair up:** both partners register in the app, one taps *I'm starting our space*, creates an invite code, the other joins with it.

## 4. Deploy (GitHub → Netlify)
Push to GitHub, "Add new site → Import from Git". Build command `npm run build`, publish dir `dist` (already in `netlify.toml`, which also sets security headers and the CSP).
Add env vars `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_VAPID_PUBLIC_KEY`. HTTPS is automatic (required for camera, mic, push and install).
If you use a different Supabase region/custom domain, update `connect-src` in `netlify.toml`.

## 5. Costs & external accounts
| Service | Needed for | Cost notes (check current pricing) |
|---|---|---|
| Supabase | everything | Free tier works to start (free projects pause after inactivity; 1 GB storage). Pro is a monthly fee. |
| Netlify | hosting | Free tier is plenty. |
| Cloudflare Calls TURN | calls on hard networks | Free monthly allowance, then per-GB. A voice call is a few MB/min; video far more. |
| Web Push (VAPID) | notifications | Free. |
| Domain | optional | Yearly fee if you want one. |

## 6. What works where
| Capability | Normal browser tab | Installed PWA | Needs native Android |
|---|---|---|---|
| Chat, memories, letters, playlist, calls (app open) | ✅ | ✅ | – |
| Install to home screen | – | ✅ (Chrome "Install app") | – |
| Push notifications (message / call) | ✅ (Chrome/Firefox/Edge) | ✅ most reliable | – |
| Music keeps playing when switching pages | ✅ | ✅ | – |
| Music with screen off / app backgrounded | ⚠️ browser-dependent | ✅ usually (uploaded/direct audio) | embeds (YouTube/Spotify) always need native/their own app |
| WhatsApp-style full-screen ringing when app is closed | ❌ | ❌ (you get a notification; battery-saver may delay it) | ✅ (native ConnectionService/FCM) |
| **Force earpiece ⇄ loudspeaker** | ❌ not reliably | ❌ not reliably | ✅ `AudioManager` (see `docs/NATIVE_ANDROID.md`) |

### Loudspeaker vs normal audio — how it really behaves
The active-call screen has **separate** controls: *Mute* (microphone) and an audio-output control. The output control calls `setSinkId()` **only** when the browser
reports at least two distinct audio outputs (`enumerateDevices`). If it finds one labelled speaker it shows a *Speaker on / Phone* toggle; if it finds several
other outputs it shows a picker; **otherwise the button is disabled and says so** — it never just flips an icon. Android Chrome often exposes a single "default" output,
in which case the phone's own volume/audio-output button is the only switch. Guaranteed switching needs the native wrapper described in `docs/NATIVE_ANDROID.md`.
This has **not** been verified on a real phone — follow `docs/TEST_PLAN.md` §B.

## 7. Project layout
```
src/lib      auth, e2ee, crypto, keystore, channel (private realtime), calls (WebRTC), player (audio+MediaSession), push
src/pages    Auth, Pairing, Home, Chat, Memories, Letters, Playlist, Calls, Settings
src/components  Shell, CallOverlay (mute + speaker control), MiniPlayer, Icon
public/      manifest, sw.js (shell cache + push), icons
supabase/    migrations/, functions/{turn-credentials,send-push}, tests/rls_tests.sql
tests/       crypto.test.ts, logic.test.ts   (node --test)
docs/        SECURITY.md, NATIVE_ANDROID.md, TEST_PLAN.md
```

## 8. Troubleshooting
- **"This email isn't on the approved list"** → insert the email into `allowed_emails` (step 3.2). Supabase may show it as "Database error saving new user".
- **Chat stuck on "Setting up secure messaging…"** → check the browser console; usually migrations weren't applied or you aren't paired yet.
- **Realtime never connects / calls can't signal** → ensure migration `0002` ran (it adds `realtime.messages` policies) and the app is on HTTPS or localhost.
- **Calls connect on Wi-Fi but not on mobile data** → TURN isn't configured (step 3.9).
- **Push never arrives** → check VAPID keys match, both webhooks exist, notification permission is granted, and see `supabase functions logs send-push`.
- **Old messages unreadable on a new phone** → by design: a new device only receives messages sent after it enrolled (see `docs/SECURITY.md`).
- **Cleared browser data = lost keys** → history is unreadable on that device; there is no recovery by design (documented limitation).
- **Music stops with screen off** → use an installed PWA with uploaded/direct-link audio; web-link (YouTube/Spotify) entries can't play in-app.
