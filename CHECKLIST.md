# Feature checklist

**Status key**
- 🟢 **Tested (automated, run)** — a test actually executed and passed in development.
- 🟡 **Implemented, not yet run** — code is written and passes syntax + strict type-check against stubs and static cross-checks, but has **not** been executed against Supabase/browsers/devices.
- 🟠 **Partial** — works within a stated limitation.
- 🔴 **Blocked on you** — needs your accounts/credentials/devices.
- ⚪ **Not implemented**.

## What was verified in this session
| Check | Result |
|---|---|
| `node --test` (crypto + logic) | 🟢 **11 / 11 pass** |
| Syntax check, 32 TS/TSX files | 🟢 0 errors |
| Strict type-check (`strictNullChecks`, stub typings for react/router/supabase) | 🟢 0 errors (⚠ stubs ⇒ third-party API usage not validated) |
| Import resolution, routes ⇄ links, RPCs ⇄ migrations ⇄ grants, tables ⇄ RLS, buckets, env vars | 🟢 consistent |
| `npm install`, `npm run build`, `npm run lint` | 🔴 **not run** (no network) → run locally; no lockfile shipped |
| SQL migrations applied / `rls_tests.sql` executed | 🔴 **not run** (no Postgres) |
| Anything on a real device or two live accounts | 🔴 **not run** |
A real bug found and fixed by review: delivered letters couldn't be marked read (trigger blocked it).

## Requirements
| # | Requirement | Status | Notes |
|---|---|---|---|
| 1 | Foundation: Vite/React/TS, routing, design system | 🟡 | Plum/pink theme from original; sidebar (desktop) + tab bar (phone) |
| 2 | Auth: register, login, reset, session refresh, revoked-session check, log out / everywhere | 🟡 | PKCE; email confirmation on; password ≥10 |
| 3 | Two-person pairing enforced server-side | 🟡 | allowed_emails gate trigger, UNIQUE(user), cap trigger, hashed single-use invites, rate limit |
| 4 | RLS on every table; private storage buckets + policies | 🟡 | Verified statically (every table has RLS); `rls_tests.sql` written, 🔴 unrun |
| 5 | Chat: realtime, history, pagination, retry, receipts, typing, presence, replies, delete-own | 🟡 | Receipts: sent ✓ / delivered ✓✓ / read (blue) |
| 5b | Chat reactions | ⚪ | Replies done; reactions not built |
| 6 | Attachments: image/video/voice with limits, encrypted | 🟡 | 10 MB img, 24 MB video, 5 min voice |
| 7 | **E2EE** (ECDH P-256 + HKDF + AES-GCM, per-device wraps, non-extractable keys, safety number, device revoke) | 🟢 crypto / 🟡 integration | 7 crypto tests pass; wiring unrun. See `docs/SECURITY.md` |
| 7b | E2EE: forward secrecy, key backup/recovery, history transfer to new device | ⚪ | Documented limitations |
| 7c | E2EE for memories, letters, playlist | ⚪ | RLS + private storage only (documented) |
| 8 | Memories: upload, gallery, lightbox, caption/date edit, delete, pagination, signed URLs | 🟠 | Progress is per-file, not per-byte; no thumbnails (full image used) |
| 9 | Letters: draft, send, schedule (UTC instant, tz shown), cancel, server-enforced lock, immutable once delivered | 🟡 | Letter-unlock push notification ⚪ (needs pg_cron + function; not built) |
| 10 | Playlist: add (upload / direct URL / web link), remove, reorder (↑↓), realtime shared, metadata, errors | 🟠 | Drag-and-drop ⚪; YouTube/Spotify only as external links |
| 11 | Persistent single audio element, Media Session, volume/seek, pause during calls | 🟡 | Screen-off playback depends on device/browser → 🔴 test (TEST_PLAN §B6) |
| 12 | Voice calls: start/ring/answer/decline/cancel/end, mute, timer, timeout, cleanup, history | 🟡 | WebRTC; call phase machine 🟢 unit-tested; real calls 🔴 unrun |
| 12b | Reconnect on network loss | 🟠 | Shows "Reconnecting", ends as failed after 20 s; no ICE-restart renegotiation |
| 13 | **Speaker ⇄ normal control** | 🟠 | Separate from mute. Uses `setSinkId` only when ≥2 real outputs exist; otherwise disabled with explanation (never fakes). Classifier 🟢 tested. Real-phone behaviour 🔴; guaranteed routing needs native (`docs/NATIVE_ANDROID.md`) |
| 14 | Video calls: camera on/off, mute, front/rear flip, local+remote | 🟡 | 🔴 real-device test |
| 15 | TURN support | 🔴 | Edge function + Cloudflare keys needed from you; falls back to STUN |
| 16 | Call history with outcomes, durations, per-user hide | 🟡 | No audio/video is ever recorded or uploaded (verified by search of call modules) |
| 17 | Push: messages + incoming calls, permission flow, click routing, duplicate suppression | 🔴 | Needs VAPID keys, deployed function, two DB webhooks. Closed-app calls = notification only |
| 18 | PWA: manifest, icons (192/512/maskable/apple), SW (shell only, never private data), update banner, offline banner | 🟡 | 🔴 install test on device |
| 19 | Security headers/CSP, no secrets in frontend | 🟡 | `netlify.toml`; CSP may need tweaking after first real run |
| 20 | Migrations (3 files), `.env.example`, `.gitignore`, README, docs | 🟡 | `package-lock.json` missing (create with `npm install`) |
| 21 | Hercules/Convex removed | 🟢 | No references remain in the new codebase |
| 22 | Original features preserved (dashboard, chat, memories, letters, playlist, call) | 🟠 | Rebuilt with real backend; original "Kira" hardcoding replaced by partner profile |

## Actions that genuinely need you
1. `npm install` (creates lockfile) → `npm run typecheck && npm run lint && npm run build` → send/fix any errors.
2. Create a **new** Supabase project; `supabase link`; `supabase db push`; insert the two emails into `allowed_emails`.
3. Auth URL settings; Realtime "Allow public access" **off**.
4. Deploy both Edge Functions; set secrets (Cloudflare TURN key id/token, VAPID pair, push webhook secret); create the two Database Webhooks.
5. Run `supabase/tests/rls_tests.sql` on a dev database; fix anything that fails.
6. Connect to Netlify with the 3 env vars; open on both phones; run `docs/TEST_PLAN.md` §A and §B and log real results.
7. Decide after §B3: if the speaker control is disabled on your phones and you need it, build the native wrapper (`docs/NATIVE_ANDROID.md`).
