package com.mapunite.app;

/*
 * MapUniteNative — the one piece of native Android code MapUnite needs that
 * no published Capacitor plugin provides: acting as a Bluetooth LE
 * PERIPHERAL (advertising). @capacitor-community/bluetooth-le is central-only.
 *
 *   startBeacon({ serviceUuid, data, txPower?, mode? })
 *       Advertises serviceUuid in the advertising packet and `data` (hex,
 *       up to 20 bytes) as service data in the scan response, so other
 *       phones scanning with a service-UUID filter receive both:
 *         advertising packet: flags (3) + 128-bit UUID (18) + tx power (3) = 24 bytes
 *         scan response:      service data, 128-bit UUID + 8 bytes    = 26 bytes
 *       (both within the 31-byte legacy limit, so it works on every BLE phone).
 *       Not connectable, no device name — nothing identifies the phone
 *       except the per-trip pseudonym the app puts in `data`.
 *   stopBeacon()
 *   beaconStatus() -> { supported, bluetoothOn, advertising }
 *   requestNotifications() -> { granted }   Android 13+ POST_NOTIFICATIONS,
 *       needed for the background-location foreground-service notification.
 *
 * Register it in MainActivity (see native/android/MainActivity.java).
 * If your appId isn't com.mapunite.app, change the package line above.
 */

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.Context;
import android.os.Build;
import android.os.ParcelUuid;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.UUID;

@CapacitorPlugin(
    name = "MapUniteNative",
    permissions = {
        @Permission(alias = "advertise", strings = { Manifest.permission.BLUETOOTH_ADVERTISE }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class MapUniteNativePlugin extends Plugin {

    private static final int MAX_DATA_BYTES = 20;

    private BluetoothLeAdvertiser advertiser;
    private AdvertiseCallback advertiseCallback;
    private boolean advertising = false;

    // ---- Beacon ----------------------------------------------------------

    @PluginMethod
    public void startBeacon(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("advertise") != PermissionState.GRANTED) {
            requestPermissionForAlias("advertise", call, "advertisePermissionCallback");
            return;
        }
        doStartBeacon(call);
    }

    @PermissionCallback
    private void advertisePermissionCallback(PluginCall call) {
        if (getPermissionState("advertise") == PermissionState.GRANTED) doStartBeacon(call);
        else call.reject("Nearby-devices permission denied", "PERMISSION_DENIED");
    }

    private void doStartBeacon(final PluginCall call) {
        final String uuidStr = call.getString("serviceUuid");
        final String dataHex = call.getString("data", "");
        UUID uuid;
        try {
            uuid = UUID.fromString(uuidStr);
        } catch (Exception e) {
            call.reject("serviceUuid must be a 128-bit UUID string", "BAD_ARGUMENT");
            return;
        }
        final byte[] data = hexToBytes(dataHex);
        if (data == null || data.length > MAX_DATA_BYTES) {
            call.reject("data must be hex, at most " + MAX_DATA_BYTES + " bytes", "BAD_ARGUMENT");
            return;
        }
        BluetoothAdapter adapter = adapter();
        if (adapter == null) { call.reject("This phone has no Bluetooth", "UNSUPPORTED"); return; }
        if (!adapter.isEnabled()) { call.reject("Bluetooth is off", "BLUETOOTH_OFF"); return; }
        BluetoothLeAdvertiser adv = adapter.getBluetoothLeAdvertiser();
        if (adv == null || !adapter.isMultipleAdvertisementSupported()) {
            call.reject("This phone can't advertise over Bluetooth LE", "UNSUPPORTED");
            return;
        }
        stopAdvertisingQuietly();
        advertiser = adv;

        int txLevel;
        String tx = call.getString("txPower", "medium");
        if ("high".equals(tx)) txLevel = AdvertiseSettings.ADVERTISE_TX_POWER_HIGH;
        else if ("low".equals(tx)) txLevel = AdvertiseSettings.ADVERTISE_TX_POWER_LOW;
        else txLevel = AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM;
        int modeValue;
        String mode = call.getString("mode", "balanced");
        if ("lowLatency".equals(mode)) modeValue = AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY;
        else if ("lowPower".equals(mode)) modeValue = AdvertiseSettings.ADVERTISE_MODE_LOW_POWER;
        else modeValue = AdvertiseSettings.ADVERTISE_MODE_BALANCED;

        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(modeValue)
            .setTxPowerLevel(txLevel)
            .setConnectable(false)
            .setTimeout(0)
            .build();
        ParcelUuid pu = new ParcelUuid(uuid);
        AdvertiseData advData = new AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(true)
            .addServiceUuid(pu)
            .build();
        AdvertiseData scanResponse = new AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addServiceData(pu, data)
            .build();

        advertiseCallback = new AdvertiseCallback() {
            @Override
            public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                advertising = true;
                JSObject ret = new JSObject();
                ret.put("advertising", true);
                call.resolve(ret);
            }

            @Override
            public void onStartFailure(int errorCode) {
                advertising = false;
                call.reject("Advertising failed (" + describe(errorCode) + ")", "ADVERTISE_FAILED_" + errorCode);
            }
        };
        try {
            advertiser.startAdvertising(settings, advData, scanResponse, advertiseCallback);
        } catch (SecurityException e) {
            call.reject("Nearby-devices permission missing", "PERMISSION_DENIED");
        }
    }

    @PluginMethod
    public void stopBeacon(PluginCall call) {
        stopAdvertisingQuietly();
        JSObject ret = new JSObject();
        ret.put("advertising", false);
        call.resolve(ret);
    }

    @PluginMethod
    public void beaconStatus(PluginCall call) {
        BluetoothAdapter adapter = adapter();
        JSObject ret = new JSObject();
        ret.put("supported", adapter != null && adapter.isMultipleAdvertisementSupported());
        ret.put("bluetoothOn", adapter != null && adapter.isEnabled());
        ret.put("advertising", advertising);
        call.resolve(ret);
    }

    // ---- Notification permission (Android 13+) ---------------------------

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsPermissionCallback");
    }

    @PermissionCallback
    private void notificationsPermissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    // ---- Lifecycle -------------------------------------------------------

    @Override
    protected void handleOnDestroy() {
        stopAdvertisingQuietly();
        super.handleOnDestroy();
    }

    // ---- Helpers ---------------------------------------------------------

    private BluetoothAdapter adapter() {
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return bm == null ? null : bm.getAdapter();
    }

    private void stopAdvertisingQuietly() {
        if (advertiser != null && advertiseCallback != null) {
            try { advertiser.stopAdvertising(advertiseCallback); } catch (Exception ignored) { /* already stopped / permission revoked */ }
        }
        advertiseCallback = null;
        advertising = false;
    }

    private static byte[] hexToBytes(String hex) {
        if (hex == null) return new byte[0];
        String h = hex.trim();
        if (h.length() % 2 != 0 || !h.matches("[0-9a-fA-F]*")) return null;
        byte[] out = new byte[h.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(h.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    private static String describe(int code) {
        switch (code) {
            case AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE: return "data too large";
            case AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS: return "too many advertisers";
            case AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED: return "already started";
            case AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR: return "internal error";
            case AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED: return "not supported";
            default: return "code " + code;
        }
    }
}
