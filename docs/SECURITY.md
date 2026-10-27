# Security model & threat model

## Boundaries
- **Browser holds only the publishable key.** No service-role key, DB password or private encryption key is in the frontend or repo. The service role exists only inside the `send-push` Edge Function (injected by Supabase).
- **Authorization is in Postgres.** Every table has RLS. Clients can only *read* membership/devices/messages; all writes that matter go through `SECURITY DEFINER` RPCs that re-check `auth.uid()` and couple membership.
- **Two-person rule (server-side):** `couple_members` has `UNIQUE(user_id)` and a `BEFORE INSERT` trigger capping a couple at 2 (row-locked). Signup itself is gated by a trigger on `auth.users` against `allowed_emails`. Pairing codes are 56-bit random, stored only as SHA-256, single-use, 24 h expiry, and `join_couple` is rate-limited to 5 attempts / 15 min.
- **Storage:** three private buckets; policies require the first path segment to be the caller's couple and (for writes/deletes) the second to be the caller's user id. No UPDATE policy (objects are immutable). Memories/playlist use short-lived signed URLs; chat attachments are ciphertext.
- **Realtime:** private channel `couple:<id>` authorised by RLS on `realtime.messages`; only the two members can join, send, or receive signalling. Call row creation/answer/end are RPCs; an outsider cannot inject SDP/ICE.
- **Letters:** locked bodies are never returned (`inbox_letters()` nulls them) and the recipient has no direct SELECT; unlock uses server `now()`. A trigger freezes delivered letters.
- **Calls are never recorded.** Only `calls` metadata (who, when, duration, outcome) is stored. There is no recorder, upload, or server media path in the call code; media is peer-to-peer or TURN-relayed (TURN relays encrypted SRTP and doesn't store it).
- **Sessions:** PKCE flow, auto-refresh, server re-check on app focus (revoked sessions sign out), "log out everywhere", password reset signs out other sessions. Account switch clears in-memory state; push subscription is removed on logout.
- **Caching:** the service worker caches only same-origin hashed build assets and the shell. It never touches Supabase/signed-URL/TURN traffic.
- **Web:** strict CSP, HSTS, no framing, `nosniff`, restrictive Permissions-Policy (see `netlify.toml`). User text is rendered via React (escaped); links in playlist are `https:` only and opened with `noopener`.

## End-to-end encryption (what is and isn't implemented)
**Protocol (built only from WebCrypto primitives, no custom algorithm):**
1. Each device generates an **ECDH P-256** key pair; the private key is **non-extractable** and stored in IndexedDB (scoped per user). The public JWK is registered via `register_device`.
2. To send, the sender creates a random **AES-256-GCM** message key, encrypts the JSON payload (AAD = `couple|client_id|kind`, so ciphertext can't be replayed under another id/couple/kind).
3. The message key is wrapped separately for **every active device of both partners** (including the sender's own): `ECDH(senderPriv, recipientPub) → HKDF-SHA256(info = "2fold-v1-wrap|senderDevice|recipientDevice") → AES-GCM`.
4. The server stores `ciphertext`, `iv`, and per-device wrapped keys. It never sees plaintext, message keys, or private keys.
5. **Attachments** are encrypted client-side with a fresh AES-GCM key per file; the key is carried *inside* the encrypted message.
6. **Verification:** Settings shows a *safety number* derived from the SHA-256 thumbprints of all active device keys; partners compare it out of band. If a new/unknown partner device appears, the number changes.

**Tested (automated, run):** round-trip for sender and recipient devices, third device can't decrypt, ciphertext/AAD tampering is rejected, private keys can't be exported, fresh key/IV per message, attachment round trip + tamper detection, safety-number properties.

**Visible to the service (metadata):** who messaged whom, when, message kind (text/image/video/voice), ciphertext size, attachment ciphertext size, device list and labels, reply links, delivered/read timestamps, call metadata, memories/letters/playlist content (**these are NOT end-to-end encrypted** — they're protected by RLS and private storage, not E2EE), and the Supabase operator can in principle read them.

**Limitations (not misrepresented):**
- **No forward secrecy / post-compromise security** (static device keys, no double ratchet). Compromise of a device key exposes past messages that device received. This is not Signal.
- **Key trust is trust-on-first-use** unless you compare safety numbers; a malicious *server* could add a rogue device for a partner. Comparing the number is the defence.
- **New device:** only receives messages sent after it enrolled (older ones show "sent before this device was set up"). No history transfer is implemented.
- **No key backup/recovery.** Clearing browser data or losing the phone loses that device's keys. A passphrase-encrypted backup is a possible future addition.
- **Device replacement:** use Settings → revoke old device / reset keys. Revoked devices stop receiving new messages but keep what they already had.
- **Browser XSS or a malicious extension** could use (not export) the non-extractable key.
- Typing/presence/call signalling are protected by private-channel auth but not E2EE (SDP/ICE reveal IP candidates to the peer and TURN).
- Not independently audited. Treat as strong-by-design, unreviewed-in-practice.

## Residual risks to review before relying on it
Run `supabase/tests/rls_tests.sql` on a dev DB; run an `npm audit`; review Edge Function logs; confirm "Allow public access" is off for Realtime; re-run `docs/TEST_PLAN.md` §A with two real accounts.
