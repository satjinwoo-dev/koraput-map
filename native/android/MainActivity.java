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
//   NavPipPlugin          navigation, minimized: picture-in-picture when the rider
//                         leaves the app, and the live turn notification (Kotlin,
//                         native/android/nav/, same setup script)
//
// Back: the page closes whatever is open first (js/native/back.js, MUBack). With
// nothing open, Back shrinks a navigation into the small window, or sends the
// app to the background like Home. It never finishes the activity, so a ride
// that is recording keeps its page alive.

import android.content.res.Configuration;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;
import com.mapunite.app.perception.PerceptionPlugin;
import com.mapunite.app.voice.VoicePlugin;
import com.mapunite.app.radar.MediaPlugin;
import com.mapunite.app.radar.RadioPlugin;
import com.mapunite.app.nav.NavPipPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MapUniteNativePlugin.class);
        registerPlugin(PerceptionPlugin.class);
        registerPlugin(VoicePlugin.class);
        registerPlugin(RadioPlugin.class);
        registerPlugin(MediaPlugin.class);
        registerPlugin(NavPipPlugin.class);
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() { onBack(); }
        });
    }

    private static final String ASK_PAGE = "(function(){try{return !!(window.MUBack&&window.MUBack.handle())}catch(e){return false}})()";

    private void onBack() {
        WebView wv = bridge != null ? bridge.getWebView() : null;
        if (wv == null) { leave(); return; }
        wv.evaluateJavascript(ASK_PAGE, (result) -> { if (!"true".equals(result)) leave(); });
    }

    private void leave() {
        if (NavPipPlugin.onBack(this)) return;
        moveTaskToBack(true);
    }

    // Navigation, minimized: leaving the app while navigating opens the small window (Android 8–11;
    // Android 12+ opens it by itself, set up by NavPipPlugin), and the web side hears when it opens or closes.
    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        NavPipPlugin.onUserLeaveHint(this);
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        NavPipPlugin.onPipChanged(isInPictureInPictureMode);
    }
}
