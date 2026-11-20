package com.mussoman.hwpviewer;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.Deque;

public class MainActivity extends BridgeActivity {
    private static final int MAX_FILE_BYTES = 80 * 1024 * 1024;
    private final Deque<String> pendingFilesJson = new ArrayDeque<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(new AndroidHwpBridge(), "AndroidHwpBridge");
        }

        handleIncomingIntent(getIntent(), true);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent, true);
    }

    private void handleIncomingIntent(Intent intent, boolean notifyWeb) {
        if (intent == null) return;
        String action = intent.getAction();
        Uri uri = null;

        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                uri = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
            } else {
                @SuppressWarnings("deprecation")
                Uri legacyUri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                uri = legacyUri;
            }
        }

        if (uri == null) return;

        final Uri targetUri = uri;
        new Thread(() -> {
            String payload = readUriAsJson(targetUri);
            if (payload == null) return;

            synchronized (pendingFilesJson) {
                pendingFilesJson.addLast(payload);
            }

            if (notifyWeb) {
                runOnUiThread(() -> {
                    if (getBridge() != null && getBridge().getWebView() != null) {
                        WebView webView = getBridge().getWebView();
                        webView.evaluateJavascript(
                                "window.dispatchEvent(new Event('android-hwp-file'));",
                                null
                        );
                    }
                });
            }
        }).start();
    }

    private String readUriAsJson(Uri uri) {
        try {
            ContentResolver resolver = getContentResolver();
            String displayName = resolveFileName(resolver, uri);

            try (InputStream in = resolver.openInputStream(uri)) {
                if (in == null) return null;
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int total = 0;
                int read;
                while ((read = in.read(buf)) != -1) {
                    total += read;
                    if (total > MAX_FILE_BYTES) {
                        return null;
                    }
                    out.write(buf, 0, read);
                }

                String b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                JSONObject json = new JSONObject();
                json.put("name", displayName);
                json.put("base64", b64);
                return json.toString();
            }
        } catch (Exception e) {
            return null;
        }
    }

    private String resolveFileName(ContentResolver resolver, Uri uri) {
        if ("content".equals(uri.getScheme())) {
            try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (idx >= 0) {
                        String name = cursor.getString(idx);
                        if (name != null && !name.trim().isEmpty()) {
                            return name.trim();
                        }
                    }
                }
            } catch (Exception ignored) {
                // fallback below
            }
        }

        String seg = uri.getLastPathSegment();
        if (seg != null && !seg.trim().isEmpty()) {
            int slash = seg.lastIndexOf('/');
            return slash >= 0 ? seg.substring(slash + 1) : seg;
        }
        return "document.hwpx";
    }

    private class AndroidHwpBridge {
        @JavascriptInterface
        public String consumePendingFile() {
            synchronized (pendingFilesJson) {
                return pendingFilesJson.isEmpty() ? "" : pendingFilesJson.removeFirst();
            }
        }

        @JavascriptInterface
        public String saveFile(String filename, String mimeType, String base64Data) {
            try {
                byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                String safeName = (filename == null || filename.trim().isEmpty())
                        ? "document.hwpx"
                        : filename.replaceAll("[\\\\/:*?\"<>|]", "_");
                String safeMime = (mimeType == null || mimeType.trim().isEmpty())
                        ? "application/octet-stream"
                        : mimeType;

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                    values.put(MediaStore.Downloads.MIME_TYPE, safeMime);
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);

                    ContentResolver resolver = getContentResolver();
                    Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) return "error:MediaStore insert failed";

                    try (OutputStream out = resolver.openOutputStream(uri)) {
                        if (out == null) return "error:OutputStream unavailable";
                        out.write(bytes);
                    }
                    return "ok:Downloads/" + safeName;
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null) dir = getCacheDir();
                    File outFile = new File(dir, safeName);
                    try (FileOutputStream out = new FileOutputStream(outFile)) {
                        out.write(bytes);
                    }
                    return "ok:" + outFile.getAbsolutePath();
                }
            } catch (Exception e) {
                return "error:" + e.getMessage();
            }
        }
    }
}
