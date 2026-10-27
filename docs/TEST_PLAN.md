# Test plan
Legend: **[AUTO-RUN]** executed during development · **[AUTO-TODO]** automated but not yet run · **[MANUAL]** needs you / real devices. Record real results in the table at the bottom — don't tick what you didn't do.

## 0. Automated
- [AUTO-RUN] `npm test` → crypto (7 tests) + call-phase / duration / audio-output classification (4 tests): **11/11 passed**.
- [AUTO-TODO] `npm run typecheck && npm run lint && npm run build`.
- [AUTO-TODO] `supabase/tests/rls_tests.sql` on a dev DB (cross-couple reads, direct INSERT/UPDATE refusal, third-member cap, non-approved signup, invite rate limit, letter lock/immutability, one-call-at-a-time, storage path isolation, anon denial).

## A. Two accounts, two browsers (desktop is fine)
1. Register both emails; non-approved email is refused. Pair with invite; reuse the code → fails; wrong code ×6 → rate-limited.
2. Chat: send/receive live; refresh → history persists; send while offline (devtools) → "Not sent · tap to retry" → retry succeeds once, no duplicate; typing indicator; read ticks turn blue when opened; reply; delete own; load earlier (send >30).
3. Attachments: photo, video (>24 MB rejected), voice note; verify in Supabase Storage the chat object is unreadable ciphertext; DB `messages.ciphertext` is not plaintext.
4. E2EE: Settings safety numbers equal on both accounts; sign in as partner on a 2nd browser → new device; old messages show "sent before this device was set up"; revoke it → it stops receiving.
5. Memories: upload photo/video, edit caption/date (creator only), delete, >50 MB and bad type rejected, >24 items paginates; copy a signed URL after 1 h → expired.
6. Letters: draft → schedule 2 min ahead; partner sees locked card, no body in network tab; change partner's device clock → still locked; after unlock appears; author can no longer edit; cancel-schedule before unlock works.
7. Playlist: add upload + direct link + web link; reorder; remove; both see changes live; broken URL → "unavailable" and skips; navigate pages while playing (music continues).
8. Direct API attacks (use curl with partner's JWT and the other couple's IDs): select/insert/update/delete on every table & `storage/v1/object/...` → must be denied/empty.
9. Logout / log in as the other user in the same browser → no previous data visible; password reset email flow; "log out everywhere".

## B. Real Android phones (Chrome, installed PWA and plain tab) — **[MANUAL]**
1. Install via Chrome → "Install app"; icon/splash/standalone display; offline launch shows shell + "offline" banner, no private data cached (DevTools → Application → Cache Storage contains only shell/assets).
2. **Voice call:** A→B ring tone + vibrate, answer, two-way audio, mute (other side hears silence, mute is independent of speaker), duration timer, end from either side cleans up (mic indicator off), decline, cancel, 45 s no-answer → "missed", airplane mode mid-call → "Reconnecting…" then failed/ended, history shows each outcome.
3. **Speaker control (essential):** on the active call screen note what the control shows. Record: (a) which browsers/phones expose a speaker/earpiece pair; (b) does toggling change the real route; (c) if disabled, the explanatory text is shown. If (b) fails on your phones, implement `docs/NATIVE_ANDROID.md`.
4. **Video:** both directions, camera off, flip front/rear, rotate, end cleanup. Test on Wi-Fi and mobile data (TURN needed on some networks).
5. **Push:** allow notifications; app foreground (no duplicate), background, swiped away, battery-saver on; tap opens chat / call screen; incoming-call push while closed (expect a notification, not a ringing screen).
6. **Background audio:** play uploaded track → switch app, lock screen, use lock-screen controls (play/pause/next/seek), unplug headphones, receive a call (pauses then resumes), return to app.

## Results log (fill in)
| Date | Tester | Device / browser | Test | Result | Notes |
|---|---|---|---|---|---|
| | | | | | |
