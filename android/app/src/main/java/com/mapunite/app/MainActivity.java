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

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.mapunite.app.perception.PerceptionPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MapUniteNativePlugin.class);
        registerPlugin(PerceptionPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
