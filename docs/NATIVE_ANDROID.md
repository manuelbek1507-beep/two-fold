# When the browser isn't enough: native Android

A web app/PWA **cannot reliably** (a) force earpiece vs loudspeaker, (b) show a full-screen ringing call when the app is closed, or (c) guarantee screen-off playback of third-party embeds.
If any of these are essential, wrap the existing site in a small native shell. Nothing in `src/` needs rewriting.

## Recommended path: Capacitor (Android) around the deployed site
1. `npm i @capacitor/core @capacitor/cli @capacitor/android && npx cap init "2 Fold" com.yourname.twofold --web-dir=dist && npx cap add android`
2. **Speaker/earpiece plugin** (tiny custom Capacitor plugin, Kotlin):
   ```kotlin
   @CapacitorPlugin(name = "AudioRoute")
   class AudioRoutePlugin : Plugin() {
     @PluginMethod fun setSpeaker(call: PluginCall) {
       val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
       am.mode = AudioManager.MODE_IN_COMMUNICATION
       if (Build.VERSION.SDK_INT >= 31) { // setCommunicationDevice
         val want = if (call.getBoolean("on") == true) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
         am.availableCommunicationDevices.firstOrNull { it.type == want }?.let { am.setCommunicationDevice(it) }
       } else { @Suppress("DEPRECATION") am.isSpeakerphoneOn = call.getBoolean("on") == true }
       call.resolve()
     }
   }
   ```
3. In `src/components/CallOverlay.tsx`, when `window.Capacitor?.isNativePlatform()` is true, render the Speaker toggle bound to `AudioRoute.setSpeaker({on})` instead of the `setSinkId` path. Reset `am.mode = MODE_NORMAL` on call end.
4. **Incoming calls when closed:** add `@capacitor/push-notifications` (FCM) and show a high-priority full-screen-intent notification / `ConnectionService`; have `send-push` also call FCM. Requires a Firebase project (free) and `POST_NOTIFICATIONS` / `USE_FULL_SCREEN_INTENT` permissions.
5. **Background music:** use a foreground service with a native media player (ExoPlayer) for embedded sources; uploaded/direct audio already works via the web `<audio>` element.
6. Build/sign with Android Studio; distribute as APK or Play Store internal testing.

Effort: roughly a day for (2)+(3); several days for reliable (4). Costs: Firebase free; Google Play developer account is a one-time fee if you publish.
