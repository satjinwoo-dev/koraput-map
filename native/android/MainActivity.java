package com.mapunite.app;

// Replaces android/app/src/main/java/com/mapunite/app/MainActivity.java
// (created by `npx cap add android`). Registers the app's own plugin; the
// npm plugins register themselves.
// If your appId isn't com.mapunite.app, change the package line above.

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MapUniteNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
