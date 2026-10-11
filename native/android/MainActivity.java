package com.mapunite.app;

// Replaces android/app/src/main/java/com/mapunite/app/MainActivity.java
// (created by `npx cap add android`). Registers the app's own plugins; the
// npm plugins register themselves.
// If your appId isn't com.mapunite.app, change the package line above.
//
//   MapUniteNativePlugin  Bluetooth beacon, keep-awake, share sheet (Java)
//   PerceptionPlugin      road camera + road model + dataset recorder (Kotlin,
//                         native/android/perception/, set up by
//                         scripts/setup-perception-android.mjs)
//   VoicePlugin           the Master AI's voice: best neural hi-IN/en-IN voice,
//                         navigation audio, ducking, Bluetooth pre-roll (Kotlin,
//                         native/android/voice/, same setup script)
//   RadioPlugin           Master AI link agent: radio signal strength + bandwidth
//                         estimate (Kotlin, native/android/radar/, same setup script)
//   MediaPlugin           Master AI mood agent: what's playing in other apps, via
//                         MediaListenerService (needs notification access, once)

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.mapunite.app.perception.PerceptionPlugin;
import com.mapunite.app.voice.VoicePlugin;
import com.mapunite.app.radar.MediaPlugin;
import com.mapunite.app.radar.RadioPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MapUniteNativePlugin.class);
        registerPlugin(PerceptionPlugin.class);
        registerPlugin(VoicePlugin.class);
        registerPlugin(RadioPlugin.class);
        registerPlugin(MediaPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
