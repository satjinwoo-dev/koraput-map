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
public/shell.js                         (changed: no service worker inside the app; start-up error notice; forms never reload the page)
public/js/core.js  chat.js  memories.js  gps.js  radio.js   (changed: server origin, media URLs, Bluetooth in radar)
public/js/native/shims.js               (new)
public/js/native/bridge.js              (new)
scripts/build-native.mjs                (new)
scripts/check-android.mjs               (new: checks your android/ setup, step 5f)
capacitor.config.json                   (new)
native/android/MainActivity.java        (new)
native/android/MapUniteNativePlugin.java(new)
native/android/AndroidManifest.additions.xml (new)
native/android/strings.additions.xml    (new)
native/android/res/drawable/ic_stat_mapunite.xml (new: notification icon)
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
npm pkg set scripts.android:check="node scripts/check-android.mjs"
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
| `MapUniteNative` (our own, `native/android/`) | Bluetooth **peripheral**: advertising the trip beacon. No published plugin can do this, because bluetooth-le is central-only. Also: the Android 13+ notification permission, stopping a background-location service left over from a ride, keeping the screen on during a ride, and the share sheet (the WebView has no working Wake Lock or Web Share) |
| `@capacitor-community/text-to-speech` (8.0.x) | Spoken alerts. The WebView has no `speechSynthesis` |
| `@capacitor-community/speech-recognition` (7.0.x) | Voice commands. The WebView has no `SpeechRecognition` |

About speech recognition: its newest release is 7.0.1, which declares `@capacitor/core >= 7` and so installs fine on Capacitor 8. It hasn't been rebuilt for Capacitor 8, though. If `npx cap sync` or the Gradle build fails on this plugin, remove it:

```bash
npm uninstall @capacitor-community/speech-recognition
```

The build script treats it as optional. The app still works, with voice commands off; spoken alerts are unaffected.

---

## 4. Build the web bundle for the app

Point the app at your server. Use the origin only: scheme and host, no path. It **must be https://**. The app's pages run on `https://localhost`, and Android blocks them from talking to a plain-http server, so an address like `http://192.168.1.20:3000` can never work. The script refuses it.

To test against the server on your own computer, give it a temporary https address with a tunnel, then build with the address it prints:

```bash
npx cloudflared tunnel --url http://localhost:3000     # prints https://<random>.trycloudflare.com
# or: ngrok http 3000                                  # prints https://<random>.ngrok-free.app
```

```bash
MU_SERVER_ORIGIN=https://maps.example.com npm run build:native
# Windows PowerShell:  $env:MU_SERVER_ORIGIN="https://maps.example.com"; npm run build:native
```

This creates `www/` from `public/`. The script:

- **bundles the Socket.IO client** (from your server's own `socket.io` package), so the app always starts, even when the server can't be reached yet;
- **bakes the server's settings** (`/api/config`: routing server, cluster mode and so on) into the page, so start-up never waits on the network;
- adds the Capacitor runtime, the plugins' browser bundles, `js/native/shims.js` and `js/native/bridge.js`;
- leaves out the service worker;
- **checks your server**: that it answers, and that it allows the app's origin (`https://localhost`). It tells you exactly what to fix if not.

Expected output:

```
build-native: www/ ready for https://maps.example.com (app scripts v=…, 5 native bundles, settings from server, server allows the app ✓). Next: npx cap sync android
```

Read any `WARNING` lines. The most important ones:

| Warning | Meaning |
|---|---|
| `the server doesn't allow the app's origin https://localhost` | The server is still running an older `server.js`. Deploy this batch's `server.js` (step 1) and build again |
| `couldn't reach https://…` | Wrong address, or the server is asleep. Free hosting tiers can take a minute to wake: open the address in a browser, wait for it, then build again. The build still completes with default settings |
| `… is a local address` | The phone must be on the same network and trust the certificate. A tunnel is easier |

Run the build again whenever you change anything in `public/`, and whenever you change the server's `OSRM_PUBLIC_URL` or turn Redis on or off, because those settings are baked in. Add `--skip-check` to build without contacting the server.

---

## 5. Add the Android platform and the native code

```bash
npx cap add android
```

Then do these steps by hand, once.

**a) Our plugin and MainActivity**

```bash
cp native/android/MapUniteNativePlugin.java android/app/src/main/java/com/mapunite/app/
cp native/android/MainActivity.java         android/app/src/main/java/com/mapunite/app/   # replaces the generated one
```

**b) Manifest.** Open `android/app/src/main/AndroidManifest.xml`. `native/android/AndroidManifest.additions.xml` has two parts, and the `<manifest>` tag needs one extra attribute:

1. Add `xmlns:tools="http://schemas.android.com/tools"` to the `<manifest>` tag.
2. Paste **PART B** (one `<service>` line) inside `<application>`, after the generated `<provider>`.
3. Paste **PART A** (permissions, queries, features) inside `<manifest>`, outside `<application>`.

The result looks like this:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
          xmlns:tools="http://schemas.android.com/tools">

    <application ...>
        <activity ...> ... </activity>          <!-- leave as generated -->
        <provider ...> ... </provider>          <!-- leave as generated -->

        <!-- PART B: close the background-location service to other apps -->
        <service
            android:name="com.capgo.capacitor_background_geolocation.BackgroundGeolocationService"
            android:exported="false"
            tools:replace="android:exported" />
    </application>

    <!-- PART A -->
    <uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
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

Why PART B: the background-location plugin declares its service `exported="true"` with no permission, so any app on the phone could start it. Started that way, it can crash MapUnite or resume a stored tracking session. Only MapUnite ever needs to start it.

You don't add the location, foreground-service, notification or Bluetooth scan/connect permissions yourself. The plugins' own manifests merge them in automatically:

- **background-geolocation:** `ACCESS_FINE/COARSE_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED`, and the `location`-type foreground service;
- **bluetooth-le:** `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, and the legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` for Android ≤ 11.

**Do not add `ACCESS_BACKGROUND_LOCATION`.** The service starts while the app is open (you tap *Start ride* or join a trip), so Android only needs the normal "While using the app" permission. Leaving it out also avoids Google Play's strict background-location review. `BLUETOOTH_SCAN` is left **without** `neverForLocation` on purpose, because Android filters beacon results out of scans made with that flag.

To check the merged result: in Android Studio, open `AndroidManifest.xml` and switch to the *Merged Manifest* tab at the bottom.

**c) Notification text and icon**

```bash
mkdir -p android/app/src/main/res/drawable
cp native/android/res/drawable/ic_stat_mapunite.xml android/app/src/main/res/drawable/
```

Then paste the three `<string>` lines from `native/android/strings.additions.xml` into `android/app/src/main/res/values/strings.xml`, inside `<resources>`.

The icon must exist. If `strings.xml` names an icon that isn't there, Android can't show the background-location notification, and it stops the app the moment a ride starts. To use your own icon instead: Android Studio → right-click `app/res` → **New → Image Asset** → **Notification Icons**, name `ic_stat_mapunite`, using a white shape on transparent.

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

**f) Check the setup**

```bash
npm run android:check
```

This reads your `android/` folder, `capacitor.config.json` and installed plugins, and lists every setting MapUnite needs. Each item is marked ✓ (fine), ! (advice) or ✗ (must fix), and every ✗ comes with the exact fix. Run it again after any change, and before every release build.

**g) Road camera + dataset recorder (MapUnitePerception, Kotlin)**

This step adds the road model's native plugin. Phase 1 has a dummy model, plus the real camera, sensors and recorder for collecting your own ride data.

```bash
node scripts/setup-perception-android.mjs --dry-run   # shows what it will change
node scripts/setup-perception-android.mjs
npx cap sync android
```

The script:

- copies `native/android/perception/*.kt` into `android/app/src/main/java/com/mapunite/app/perception/`;
- copies `MainActivity.java`, which now also registers `PerceptionPlugin`;
- adds Kotlin (Gradle plugin 2.1.21) and CameraX 1.4.2 to the Gradle files;
- matches Kotlin's JVM target to Java's.

It is safe to run again. If a Gradle file doesn't look like Capacitor's template, the script prints the lines to add by hand.

No new permissions are needed: `CAMERA` is in PART A, and location comes from the background-location plugin. Recordings go to the app's own folder, so no storage permission either.

**Using it**

1. In the app, open Smart Drive Settings → **Road data recorder**.
2. Tap **Start camera** and use **Check the view** to aim the mount: the horizon should sit a little above the middle.
3. With the bike on its stand, enter the camera height and tap **Calibrate**.
4. Tap **Start recording**.
5. Copy rides to your computer: `adb pull /sdcard/Android/data/com.mapunite.app/files/perception-datasets`

Details, privacy notes and the Phase 2 LiteRT slot: `native/android/perception/README.md`.

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

If the app can't reach your server, it says so at the top of the screen: **"Can't reach the MapUnite server"** with the address and a **Retry** button. If something fails while the app starts, it shows **"MapUnite didn't start properly"** with the first error and a **Reload** button. Either message tells you where to look.

**Reading JavaScript errors in Logcat.** The app's JS errors are logged under the tag `Capacitor/Console`.

- Set the Logcat filter to `package:mine tag:Capacitor/Console` to hide the flood of Samsung `View setRequestedFrameRate` lines.
- Turn on **soft-wrap** (the ↩ icon in the Logcat toolbar) to read whole messages instead of lines cut off at the window edge.

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
| "Can't reach the MapUnite server", or friends never appear | Rebuild and read the `WARNING` lines from step 4. Usual causes: the wrong `MU_SERVER_ORIGIN`, an older `server.js` still deployed, a sleeping free-tier server, or `NATIVE_APP_ORIGINS` set without `https://localhost` |
| Logcat shows `ReferenceError` in `gps.js:514` / `convoy.js:81`, and Join clears your name | An app built before this fix couldn't load the Socket.IO client from the server, which stopped `core.js` early. Pull this batch, then run `npm run build:native` and `npx cap sync android`. The client is now bundled, and Join no longer reloads the page |
| Photos don't load in the app | Deploy the new `lib/media.js`; it sends `Cross-Origin-Resource-Policy: cross-origin` |
| No background notification when a ride starts | Notifications blocked. Settings → Apps → MapUnite → Notifications. Also check Settings → Location → MapUnite is "Allow only while using the app" or better |
| Rider disappears from others' maps after a few minutes with the screen off | Some phones (Xiaomi, Oppo, Vivo, Samsung "Deep sleeping apps") kill foreground services. On Samsung: Settings → Apps → MapUnite → Battery → **Unrestricted**, and make sure MapUnite isn't under Settings → Battery → Background usage limits → Sleeping / Deep sleeping apps. See dontkillmyapp.com for other brands |
| Rider disappears after the **server** restarts (deploy, free-tier sleep) while their phone is in a pocket | Known limitation: background updates only reach riders who are still connected on the server. Opening the app reconnects them |
| Voice squad / call: others stop hearing you when your screen turns off | Known Android limit: apps can't use the microphone in the background without a foreground service of type "microphone", and MapUnite's service is type "location". Keep the screen on during calls (the ride screen already stays on) |
| Hands-free voice commands beep every few seconds | Android's speech recognizer plays a tone each time it starts listening, and it stops after a few seconds of silence. Use push-to-talk (the mic button) in the app; hands-free suits the website better |
| "Background sharing is off — Allow precise location" | Location is denied, or set to *Approximate*; the background service needs *Precise*. Tap **Settings** on that message → Permissions → Location → *Allow only while using the app* + *Use precise location* |
| "Nearby trip-mates over Bluetooth is off" | "Nearby devices" was denied. Tap **Settings** on that message → Permissions → Nearby devices → Allow. The app doesn't ask again on its own for 30 minutes |
| A "MapUnite is sharing your ride" notification that won't go away | Open the app: a service left over from a ride the app no longer knows about is stopped within about 10 s of start-up. If it stays, end and restart a ride, or force-stop the app |
| Radar never shows "· Bluetooth" | Both phones must be in the **same group trip**, have Bluetooth on, and have "Nearby devices" allowed. Some very old or cheap phones can't advertise; they still *see* others |
| Gradle error mentioning `speech-recognition` | Remove the plugin (step 3). Voice commands go off; everything else keeps working |
| `Manifest merger failed` | Make sure you pasted the additions **above** `<application>` and didn't add `ACCESS_BACKGROUND_LOCATION` or a `uses-feature` for GPS (the geolocation plugin declares that one) |

---

## What was tested here, and what wasn't

The cloud workspace has no Android SDK, so the Gradle build and the phone itself were not run here. The rest was tested:

- **The web side of the app, in Chromium**, using the real `www/` produced by `build-native.mjs` with stand-in plugins that follow each plugin's documented API, against the real `server.js`. 38 checks pass, including:
  - the app starting with the server unreachable, and saying so on screen;
  - a broken start-up named on screen, with Join no longer wiping the form;
  - Socket.IO pointed at the server;
  - speech on the TTS and speech-recognition plugins;
  - a Meshtastic radio pairing through the Bluetooth shim;
  - background location starting and stopping with the ride, with the right URL and auth headers;
  - native fixes keeping a backgrounded rider live on a friend's map;
  - two riders detecting each other's beacons, with and without a radio;
  - absolute photo URLs;
  - the Android failure paths: location denied (explained once, not re-asked), a service still attached after a page reload, Android refusing to start the service from the background (retried when back on screen), a leftover service from an earlier ride being stopped, "Nearby devices" denied, the screen kept on during a ride, the share sheet, and bonding the radio before connecting.
- **The plugins' Android source code** (background-geolocation, bluetooth-le, text-to-speech, speech-recognition, Capacitor 8 core) was read to confirm how each one reports errors, which permissions it requests and what it merges into the manifest.
- **`scripts/check-android.mjs`** was run against Capacitor 8's own Android template, set up as this guide describes (no problems) and as the first kit described (5 problems found, each with its fix).
- **`MapUniteNativePlugin.java`** was compiled against the real Android API jar and Capacitor's method signatures.
- **The full regression suite** (all earlier batches) passes.

The first real `npx cap run android` is where anything device-specific will show up. If it does, send me the Gradle or Logcat error.
