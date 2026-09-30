# MapUnite for Android (Capacitor 8)

This guide wraps the MapUnite web app in a native Android app. The app adds two things a browser can't do:

- **Background location.** While a ride is recording, or while you're in a group trip, a foreground service with a notification keeps sending your position to the server. Native code does the sending, so it keeps working when the screen is off, when Android freezes the WebView, or when the app is swiped away. It stops the moment the ride and the trip end, so it never becomes 24/7 tracking.
- **Bluetooth peripheral mode.** Inside a group trip, each phone broadcasts a small Bluetooth LE beacon and listens for trip-mates' beacons. The radar panel then shows riders within roughly 50 m ("📡 Asha — right next to you · Bluetooth"), with no GPS, no mobile data and no radio needed. The beacon carries only per-trip pseudonymous ids, the same ones the radio relay uses, so nothing links you across trips.

On top of those two features, voice alerts, voice commands and pairing a Meshtastic radio all work inside the app. Android's WebView has none of the browser APIs they rely on, so `js/native/shims.js` rebuilds those APIs on native plugins.

**How the pieces fit.** The website (`public/`) stays exactly as it is. The app bundles a copy of it (`www/`) and talks to your existing server over HTTPS and WebSocket. The Google Maps `<script>` tag is untouched and still uses your referrer-restricted key; there is no Maps proxy.

---

## 0. What you need

| Tool | Version |
|---|---|
| Node.js | **22 or newer** (Capacitor 8 requirement): `node -v` |
| Android Studio | **Otter (2025.2.1) or newer**, with Android SDK 36 installed. SDK Manager → SDK Platforms → Android 16 (API 36) |
| JDK | The one bundled with Android Studio (21) is fine |
| A phone | Android 7.0+ (API 24+), USB debugging on. Bluetooth advertising needs a phone that supports it, which almost every phone from 2017 onward does |
| Your server | Deployed with this batch's `server.js`, reachable over **https://** |

Everything below runs in the **root of your MapUnite repo**, next to `server.js` and `package.json`.

---

## 1. Put this batch's files in place

Copy these into your repo. Paths are the same as in the zip:

```
server.js                               (changed: native location endpoint, CORS for the app)
lib/media.js                            (changed: photos loadable from the app)
public/index.html  public/sw.js         (changed: cache version bump only)
public/shell.js                         (changed: no service worker inside the app)
public/js/core.js  chat.js  memories.js  gps.js  radio.js   (changed: server origin, media URLs, Bluetooth in radar)
public/js/native/shims.js               (new)
public/js/native/bridge.js              (new)
scripts/build-native.mjs                (new)
capacitor.config.json                   (new)
native/android/MainActivity.java        (new)
native/android/MapUniteNativePlugin.java(new)
native/android/AndroidManifest.additions.xml (new)
native/android/strings.additions.xml    (new)
```

Deploy the server part (`server.js`, `lib/media.js`, `public/`) the usual way and restart it. The website behaves exactly as before; the new code only switches on inside the app.

---

## 2. Initialise Capacitor

```bash
# Capacitor itself
npm install @capacitor/core@^8 @capacitor/android@^8
npm install -D @capacitor/cli@^8

# Create the Capacitor project (app name, Android package id, web folder)
npx cap init "MapUnite" "com.mapunite.app" --web-dir www
```

`cap init` writes a config file. **Use ours instead:**

- If it created `capacitor.config.ts`, delete it: `rm capacitor.config.ts`
- Keep the `capacitor.config.json` from this batch. If `cap init` overwrote it, copy ours back.

If you pick a different app id than `com.mapunite.app`, change it in three places:

1. `capacitor.config.json` → `appId`
2. the `package` line at the top of both `.java` files
3. the folder you copy them into in step 5

Add the build scripts and ignore the generated web copy:

```bash
npm pkg set scripts.build:native="node scripts/build-native.mjs"
npm pkg set scripts.android:sync="npm run build:native && npx cap sync android"
npm pkg set scripts.android:run="npm run android:sync && npx cap run android"
echo "www/" >> .gitignore
```

Commit the `android/` folder that step 5 creates. That is normal for Capacitor, because it holds your native edits.

---

## 3. Install the plugins

```bash
npm install @capgo/background-geolocation@^8 \
            @capacitor-community/bluetooth-le@^8 \
            @capacitor-community/text-to-speech@^8 \
            @capacitor-community/speech-recognition@^7
```

| Plugin | What MapUnite uses it for |
|---|---|
| `@capgo/background-geolocation` (8.4.x) | Foreground location service. Its native code POSTs each fix to `/api/native/location` every 10 s at most |
| `@capacitor-community/bluetooth-le` (8.3.x) | Bluetooth **central**: pairing your Meshtastic radio (behind `navigator.bluetooth`), and scanning for trip-mates' beacons |
| `MapUniteNative` (our own, `native/android/`) | Bluetooth **peripheral**: advertising the trip beacon. No published plugin can do this, because bluetooth-le is central-only. It also requests the Android 13+ notification permission |
| `@capacitor-community/text-to-speech` (8.0.x) | Spoken alerts. The WebView has no `speechSynthesis` |
| `@capacitor-community/speech-recognition` (7.0.x) | Voice commands. The WebView has no `SpeechRecognition` |

About speech recognition: its newest release is 7.0.1, which declares `@capacitor/core >= 7` and so installs fine on Capacitor 8. It hasn't been rebuilt for Capacitor 8, though. If `npx cap sync` or the Gradle build fails on this plugin, remove it:

```bash
npm uninstall @capacitor-community/speech-recognition
```

The build script treats it as optional. The app still works, with voice commands off; spoken alerts are unaffected.

---

## 4. Build the web bundle for the app

Point the app at your server. Use the origin only: scheme and host, no path.

```bash
MU_SERVER_ORIGIN=https://maps.example.com npm run build:native
# Windows PowerShell:  $env:MU_SERVER_ORIGIN="https://maps.example.com"; npm run build:native
```

This creates `www/` from `public/`. The script:

- loads Socket.IO and `/config.js` from your server;
- adds the Capacitor runtime, the plugins' browser bundles, `js/native/shims.js` and `js/native/bridge.js`;
- leaves out the service worker.

Expected output:

```
build-native: www/ ready for https://maps.example.com (app scripts v=…, 5 native bundles). Next: npx cap sync android
```

Run it again whenever you change anything in `public/`.

---

## 5. Add the Android platform and the native code

```bash
npx cap add android
```

Then do these five steps by hand, once.

**a) Our plugin and MainActivity**

```bash
cp native/android/MapUniteNativePlugin.java android/app/src/main/java/com/mapunite/app/
cp native/android/MainActivity.java         android/app/src/main/java/com/mapunite/app/   # replaces the generated one
```

**b) Manifest.** Open `android/app/src/main/AndroidManifest.xml` and paste the contents of `native/android/AndroidManifest.additions.xml` inside `<manifest>`, **above** `<application>`. The result looks like this:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application ...> ... </application>   <!-- leave as generated -->

    <!-- MapUnite additions (paste ABOVE <application>) -->
    <uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.VIBRATE" />
    <queries>
        <intent><action android:name="android.speech.RecognitionService" /></intent>
        <intent><action android:name="android.intent.action.TTS_SERVICE" /></intent>
    </queries>
    <uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.microphone" android:required="false" />

    <uses-permission android:name="android.permission.INTERNET" />  <!-- already there -->
</manifest>
```

You don't add the location, foreground-service, notification or Bluetooth scan/connect permissions yourself. The plugins' own manifests merge them in automatically:

- **background-geolocation:** `ACCESS_FINE/COARSE_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`, `WAKE_LOCK`, and the `location`-type foreground service;
- **bluetooth-le:** `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, and the legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` for Android ≤ 11.

**Do not add `ACCESS_BACKGROUND_LOCATION`.** The service starts while the app is open (you tap *Start ride* or join a trip), so Android only needs the normal "While using the app" permission. Leaving it out also avoids Google Play's strict background-location review. `BLUETOOTH_SCAN` is left **without** `neverForLocation` on purpose, because Android filters beacon results out of scans made with that flag.

To check the merged result: in Android Studio, open `AndroidManifest.xml` and switch to the *Merged Manifest* tab at the bottom.

**c) Notification text and icon**

- Paste the three `<string>` lines from `native/android/strings.additions.xml` into `android/app/src/main/res/values/strings.xml`, inside `<resources>`.
- Create the icon: in Android Studio, right-click `app/res` → **New → Image Asset**.
  - Icon type: **Notification Icons**
  - Name: `ic_stat_mapunite`
  - Use a simple white shape; a full-colour logo shows as a grey square.

**d) SDK levels.** Capacitor 8's generated `android/variables.gradle` already has what MapUnite needs, so check it and leave it as is:

```
minSdkVersion = 24
compileSdkVersion = 36
targetSdkVersion = 36
```

**e) Sync**

```bash
npx cap sync android
```

---

## 6. Allow the app on your server and your Maps key

**Server CORS.** Inside the app, the page's origin is `https://localhost` (Capacitor 8's default). `server.js` already allows it in addition to your `CORS_ORIGIN` through a new variable:

```
NATIVE_APP_ORIGINS=https://localhost,capacitor://localhost     # this is the default; set it only to change it
```

- If you changed `server.hostname` in `capacitor.config.json`, put that origin here.
- To switch the app's access off entirely, set `NATIVE_APP_ORIGINS=` (empty).

**Google Maps key.** The Maps `<script>` inside the app sends `https://localhost/` as its referrer. Add it to the key:

1. Google Cloud Console → **APIs & Services → Credentials**
2. Open your Maps JavaScript API key → **Website restrictions** → **Add**: `https://localhost/*`
3. Save; it can take up to 5 minutes to apply.

Without this, the map in the app shows "This page can't load Google Maps correctly" (`RefererNotAllowedMapError`). The web map keeps working either way.

---

## 7. Run it on your phone

```bash
npm run android:run          # build www/ → sync → pick your phone → install and launch
# or open Android Studio and press Run:
npx cap open android
```

To debug the WebView, open `chrome://inspect` on your computer while the phone is connected. For that, temporarily set `"webContentsDebuggingEnabled": true` in `capacitor.config.json`, then sync again. Set it back to `false` before any release.

### What to check on the device

1. **First launch:**
   - allow **Location → While using the app**;
   - allow **Nearby devices** (Android 12+), asked when you first pair a radio or join a trip;
   - allow **Notifications** (Android 13+), asked when you first start a ride.
2. **Start a ride.** A "MapUnite is sharing your ride" notification appears and the island shows *Sharing continues in the background*. Lock the phone for 2 minutes. On a second device, the rider keeps moving on the map.
3. **End the ride.** The notification disappears and sharing stops.
4. **Two phones in the same group trip,** side by side. Within a few seconds each gets *"Asha is right next to you — Detected over Bluetooth"*, and the radar panel lists "📡 … · Bluetooth".
5. **Voice.** Speed alerts and navigation are spoken. Tap the mic and say "how far".
6. **Radio.** In the radar panel, tap **Connect radio**. Android's device picker lists "Meshtastic radios nearby".

---

## 8. Release build

1. **Create an upload key (once).** Keep the file and passwords safe:

   ```bash
   keytool -genkey -v -keystore mapunite-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
   ```

2. **Build the signed bundle:**

   ```bash
   npm run android:sync
   npx cap build android --keystorepath ../mapunite-upload.jks --keystorepass '…' \
       --keystorealias upload --keystorealiaspass '…' --androidreleasetype AAB
   # or: Android Studio → Build → Generate Signed App Bundle / APK…
   # or: cd android && ./gradlew bundleRelease   (after adding a signingConfig to app/build.gradle)
   ```

   The bundle is written to `android/app/build/outputs/bundle/release/app-release.aab`.

3. **Google Play Console, before the first release:**
   - **App content → Foreground service permissions.** Declare **Location** and explain it, for example: "Shares the rider's live position with their group during a ride or group trip the user started; stops when the ride ends." Play asks for a short video of the notification appearing when a ride starts.
   - **App content → Data safety.** Declare:
     - Location (precise), collected and shared with other users of the app, for app functionality;
     - Photos (memory photos) and Audio (voice squad and voice commands), if you keep those features.
   - **Location permission.** Only foreground location is requested, so no background-location declaration is needed.
   - **Privacy policy URL.** Required because the app handles location.

4. **Each version:** bump `versionCode` and `versionName` in `android/app/build.gradle`.

---

## Everyday workflow

```bash
# changed something in public/ (or pulled new web code)?
MU_SERVER_ORIGIN=https://maps.example.com npm run android:sync
# changed plugins (npm install/uninstall)?
npx cap sync android
```

Web-only fixes still reach website users the moment you deploy. App users get them when you ship a new app build, because the app carries its own copy of `www/`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `build-native: missing node_modules/…` | Run the `npm install` from step 3 |
| App opens but the map says *can't load Google Maps correctly* | Add `https://localhost/*` to the key's website restrictions (step 6) |
| App stuck on "Connecting…", or friends never appear | Check `MU_SERVER_ORIGIN` (https, correct host, no path) and that the server's `NATIVE_APP_ORIGINS` includes `https://localhost`. In `chrome://inspect`, look for CORS errors on `/socket.io/` |
| Photos don't load in the app | Deploy the new `lib/media.js`; it sends `Cross-Origin-Resource-Policy: cross-origin` |
| No background notification when a ride starts | Notifications blocked. Settings → Apps → MapUnite → Notifications. Also check Settings → Location → MapUnite is "Allow only while using the app" or better |
| Rider disappears from others' maps after a few minutes with the screen off | Some phones (Xiaomi, Oppo, Vivo, Samsung "Deep sleep") kill foreground services. Settings → Battery → MapUnite → **Unrestricted**. See dontkillmyapp.com for your brand |
| Radar never shows "· Bluetooth" | Both phones must be in the **same group trip**, have Bluetooth on, and have "Nearby devices" allowed. Some very old or cheap phones can't advertise; they still *see* others |
| Gradle error mentioning `speech-recognition` | Remove the plugin (step 3). Voice commands go off; everything else keeps working |
| `Manifest merger failed` | Make sure you pasted the additions **above** `<application>` and didn't add `ACCESS_BACKGROUND_LOCATION` or a `uses-feature` for GPS (the geolocation plugin declares that one) |

---

## What was tested here, and what wasn't

The cloud workspace has no Android SDK, so the Gradle build and the phone itself were not run here. The rest was tested:

- **The web side of the app, in Chromium**, using the real `www/` produced by `build-native.mjs` with stand-in plugins that follow each plugin's documented API, against the real `server.js`. 24 checks pass, including:
  - Socket.IO pointed at the server;
  - speech on the TTS and speech-recognition plugins;
  - a Meshtastic radio pairing through the Bluetooth shim;
  - background location starting and stopping with the ride, with the right URL and auth headers;
  - native fixes keeping a backgrounded rider live on a friend's map;
  - two riders detecting each other's beacons, with and without a radio;
  - absolute photo URLs.
- **`MapUniteNativePlugin.java`** was compiled against the Android and Capacitor API signatures.
- **The full regression suite** (all earlier batches) passes.

The first real `npx cap run android` is where anything device-specific will show up. If it does, send me the Gradle or Logcat error.
