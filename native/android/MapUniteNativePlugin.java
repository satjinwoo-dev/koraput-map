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
 *   share({ title?, text, imageBase64?, fileName?, mimeType? }) -> { shared }
 *       mimeType: image/png (default), image/jpeg, video/mp4 or video/webm (a ride
 *       recap's motion clip); the file name's extension must match it.
 *       Android's own share sheet (ACTION_SEND through a chooser): WhatsApp,
 *       Telegram, Instagram, … whatever is installed. No app-specific API or key.
 *       With imageBase64 (a PNG) the image goes along via the FileProvider that
 *       Capacitor's Android template declares (authority <appId>.fileprovider,
 *       with a cache-path entry in res/xml/file_paths.xml); if that provider is
 *       missing, the text is shared alone and imageShared is false.
 *   fileOpen({ fileName, mimeType }) -> { id }
 *   fileWrite({ id, data })          data: base64, one chunk (the page sends ~384 KB at a time)
 *   fileClose({ id, action, title?, text? }) -> { saved, where } | { shared }
 *       A ride video or recap image too big for one bridge message, sent in
 *       chunks into the app's cache, then either SAVED to the phone (Android
 *       10+: MediaStore, so it shows in the gallery or Files: Movies/MapUnite,
 *       Pictures/MapUnite or Download/MapUnite; no storage permission needed)
 *       or SHARED through the share sheet. The WebView can't download blob:
 *       links, so this is how "Save" works inside the app. Android 7–9: save
 *       rejects with code "unsupported" and the page offers the share sheet.
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
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelUuid;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
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

    // ---- Share (Android's share sheet) ------------------------------------

    private static final int MAX_SHARE_IMAGE_BYTES = 40 * 1024 * 1024;   // a few-second recap clip fits easily

    @PluginMethod
    public void share(PluginCall call) {
        String text = call.getString("text", "");
        String title = call.getString("title", "Share");
        String imageBase64 = call.getString("imageBase64", null);
        String fileName = call.getString("fileName", "mapunite.png");
        String mimeType = call.getString("mimeType", "image/png");
        String ext;
        switch (mimeType) {
            case "image/jpeg": ext = ".jpg"; break;
            case "video/mp4": ext = ".mp4"; break;
            case "video/webm": ext = ".webm"; break;
            default: mimeType = "image/png"; ext = ".png";
        }
        Intent send = new Intent(Intent.ACTION_SEND);
        send.putExtra(Intent.EXTRA_TEXT, text);
        send.putExtra(Intent.EXTRA_SUBJECT, title);
        send.setType("text/plain");
        boolean imageShared = false;
        if (imageBase64 != null && !imageBase64.isEmpty()) {
            try {
                byte[] bytes = Base64.decode(imageBase64, Base64.DEFAULT);
                if (bytes.length > MAX_SHARE_IMAGE_BYTES) throw new IllegalArgumentException("image too large");
                File dir = new File(getContext().getCacheDir(), "shared");
                if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("no cache dir");
                // only a plain file name, never a path from the page
                String safe = fileName.replaceAll("[^A-Za-z0-9._-]", "-");
                if (!safe.endsWith(ext)) safe = safe + ext;
                File out = new File(dir, safe);
                try (FileOutputStream fos = new FileOutputStream(out)) { fos.write(bytes); }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", out);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.setType(mimeType);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                imageShared = true;
            } catch (Exception e) {
                // no FileProvider / bad image: share the text alone rather than nothing
                imageShared = false;
            }
        }
        Intent chooser = Intent.createChooser(send, title);
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (imageShared) chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            getContext().startActivity(chooser);
            JSObject ret = new JSObject();
            ret.put("shared", true);
            ret.put("imageShared", imageShared);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Couldn't open the share sheet: " + e.getMessage());
        }
    }

    // ---- Files in chunks: save to the phone, or share ---------------------

    private static final long MAX_FILE_BYTES = 300L * 1024 * 1024;
    private static final class Pending { File file; String mime; long size; }
    private final Map<String, Pending> files = new HashMap<>();

    /** The extension for the types the app makes; null for anything else (refused). */
    private static String extFor(String mime) {
        switch (mime) {
            case "image/png": return ".png";
            case "image/jpeg": return ".jpg";
            case "video/mp4": return ".mp4";
            case "video/webm": return ".webm";
            case "application/json": return ".json";
            default: return null;
        }
    }

    @PluginMethod
    public void fileOpen(PluginCall call) {
        String mime = call.getString("mimeType", "");
        String ext = extFor(mime == null ? "" : mime);
        if (ext == null) { call.reject("type not allowed", "bad-type"); return; }
        String safe = call.getString("fileName", "mapunite").replaceAll("[^A-Za-z0-9._-]", "-");
        if (safe.isEmpty() || safe.startsWith(".")) safe = "mapunite" + safe;
        if (!safe.endsWith(ext)) safe = safe + ext;
        File dir = new File(getContext().getCacheDir(), "shared");
        if (!dir.exists() && !dir.mkdirs()) { call.reject("no cache dir"); return; }
        Pending p = new Pending();
        p.file = new File(dir, safe);
        p.mime = mime;
        if (p.file.exists() && !p.file.delete()) { call.reject("couldn't replace the old file"); return; }
        String id = UUID.randomUUID().toString();
        synchronized (files) { files.put(id, p); }
        JSObject ret = new JSObject();
        ret.put("id", id);
        call.resolve(ret);
    }

    @PluginMethod
    public void fileWrite(PluginCall call) {
        Pending p;
        synchronized (files) { p = files.get(call.getString("id", "")); }
        if (p == null) { call.reject("unknown file", "no-file"); return; }
        try {
            byte[] bytes = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
            if (p.size + bytes.length > MAX_FILE_BYTES) throw new IllegalArgumentException("file too large");
            try (FileOutputStream fos = new FileOutputStream(p.file, true)) { fos.write(bytes); }
            p.size += bytes.length;
            call.resolve();
        } catch (Exception e) {
            synchronized (files) { files.values().remove(p); }
            //noinspection ResultOfMethodCallIgnored
            p.file.delete();
            call.reject("Couldn't write the file: " + e.getMessage());
        }
    }

    @PluginMethod
    public void fileClose(PluginCall call) {
        Pending p;
        synchronized (files) { p = files.remove(call.getString("id", "")); }
        if (p == null || p.size == 0) { call.reject("unknown or empty file", "no-file"); return; }
        if ("share".equals(call.getString("action", "save"))) {
            try {
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", p.file);
                openChooser(call.getString("title", "Share"), call.getString("text", ""), uri, p.mime);
                JSObject ret = new JSObject();
                ret.put("shared", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Couldn't open the share sheet: " + e.getMessage());
            }
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) { call.reject("saving needs Android 10 or newer", "unsupported"); return; }
        Uri collection;
        String folder;
        if (p.mime.startsWith("video/")) { collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI; folder = Environment.DIRECTORY_MOVIES + "/MapUnite"; }
        else if (p.mime.startsWith("image/")) { collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI; folder = Environment.DIRECTORY_PICTURES + "/MapUnite"; }
        else { collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI; folder = Environment.DIRECTORY_DOWNLOADS + "/MapUnite"; }
        ContentResolver cr = getContext().getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, p.file.getName());
        v.put(MediaStore.MediaColumns.MIME_TYPE, p.mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, folder);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri item = null;
        try {
            item = cr.insert(collection, v);
            if (item == null) throw new IllegalStateException("the gallery refused the file");
            try (InputStream in = new FileInputStream(p.file); OutputStream out = cr.openOutputStream(item)) {
                if (out == null) throw new IllegalStateException("no output stream");
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(item, done, null, null);
            JSObject ret = new JSObject();
            ret.put("saved", true);
            ret.put("where", folder);
            call.resolve(ret);
        } catch (Exception e) {
            if (item != null) { try { cr.delete(item, null, null); } catch (Exception ignored) { /* nothing to undo */ } }
            call.reject("Couldn't save: " + e.getMessage());
        } finally {
            //noinspection ResultOfMethodCallIgnored
            p.file.delete();
        }
    }

    private void openChooser(String title, String text, Uri uri, String mime) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.putExtra(Intent.EXTRA_TEXT, text);
        send.putExtra(Intent.EXTRA_SUBJECT, title);
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.setType(mime);
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, title);
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getContext().startActivity(chooser);
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
